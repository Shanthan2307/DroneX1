"""The fleet: one uAgent per hangar drone, each answering "can you do this?" from its own physics verdict.

All eight run in one Bureau on one port. Their addresses derive from the fleet seed and the preset id, so the
dispatcher finds them without a registry. They read the configurator's /api/catalog on start and refresh it every
few minutes; the answer to a CapabilityQuery is the mapped mission's row: ready or not, which checks fail.
"""

from __future__ import annotations

from pathlib import Path

import asyncio
import json
import time

from uagents import Agent, Bureau, Context, Protocol

from .addresses import LocalFirstResolver, local_rules
from .config import Settings, describe_missing, load_settings
from .mission import MissionRequest, judge_candidate
from .protocol import CapabilityQuery, CapabilityReply
from .render_api import Catalog, Preset, RenderApi, RenderApiError

FLEET_PROTOCOL = Protocol(name="dronex-fleet-capability", version="0.1.0")


class FleetState:
    """The catalog, shared by the eight agents, refreshed in the background."""

    def __init__(self, api: RenderApi, refresh_s: float = 180.0):
        self.api = api
        self.catalog: Catalog | None = None
        self.fetched_at = 0.0
        self.refresh_s = refresh_s
        self.error: str | None = None

    async def get(self) -> Catalog | None:
        if self.catalog is None or time.time() - self.fetched_at > self.refresh_s:
            try:
                self.catalog = await self.api.catalog()
                self.fetched_at = time.time()
                self.error = None
            except RenderApiError as e:
                self.error = str(e)
        return self.catalog


def reply_for(preset: Preset, q: CapabilityQuery) -> CapabilityReply:
    req = MissionRequest(kind="", mission_id=q.mission_id, text="", payload_g=q.payload_g, distance_km=q.distance_km, time_min=q.time_min)
    c = judge_candidate(preset, req)
    return CapabilityReply(request_id=q.request_id, preset_id=preset.id, name=preset.name, ready=c.passes, failing=len(c.failing) + len(c.request_notes), failing_summary=c.why, preset_json=json.dumps(preset.to_dict()))


def build_fleet(s: Settings, state: FleetState) -> Bureau:
    resolver = LocalFirstResolver(local_rules(s))
    bureau = Bureau(port=s.fleet_port, endpoint=s.fleet_endpoint)
    for pid in s.preset_ids:
        agent = Agent(
            name=f"dronex-fleet-{pid}",
            seed=s.fleet_seed_for(pid),
            mailbox=s.fleet_mailbox,
            resolve=resolver,
            publish_agent_details=s.fleet_mailbox,
            readme_path=str(Path(__file__).resolve().parents[1] / "readme" / "fleet.md"),
            enable_agent_inspector=False,
            description=f"DroneX hangar drone {pid}: answers what it can carry, how far and for how long, from a physics verdict over sourced parts.",
        )
        proto = Protocol(name=FLEET_PROTOCOL.name, version=FLEET_PROTOCOL.version)

        def make_handler(preset_id: str):
            async def handle(ctx: Context, sender: str, msg: CapabilityQuery) -> None:
                cat = await state.get()
                preset = cat.preset(preset_id) if cat else None
                if preset is None:
                    await ctx.send(sender, CapabilityReply(request_id=msg.request_id, preset_id=preset_id, name=preset_id, ready=False, failing=99, failing_summary=state.error or "catalog unavailable", preset_json="{}"))
                    return
                r = reply_for(preset, msg)
                ctx.logger.info(f"{preset.name}: mission {msg.mission_id} → {'READY' if r.ready else 'not ready: ' + r.failing_summary}")
                await ctx.send(sender, r)

            return handle

        proto.on_message(CapabilityQuery, replies=CapabilityReply)(make_handler(pid))
        agent.include(proto, publish_manifest=s.fleet_mailbox)
        bureau.add(agent)
    return bureau


def main() -> None:
    s = load_settings()
    api = RenderApi(s.render_url)
    state = FleetState(api)
    print("DroneX fleet: one agent per hangar drone")
    for line in describe_missing(s):
        print(f"  note: {line}")
    # One loop for the warm-up and the Bureau (asyncio.run would close it and leave none for the Bureau).
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    cat = loop.run_until_complete(state.get())
    if cat is None:
        print(f"  warning: {state.error}; the fleet will keep trying")
    else:
        print(f"  {len(cat.presets)} drones judged by the configurator at {s.render_url}")
    bureau = build_fleet(s, state)
    for pid in s.preset_ids:
        from .addresses import address_of

        print(f"  {pid:28s} {address_of(s.fleet_seed_for(pid))}")
    print(f"  listening on {s.fleet_endpoint}")
    bureau.run()


if __name__ == "__main__":
    main()
