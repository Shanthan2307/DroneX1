"""The flight agent: owns the simulation engine on behalf of the dispatcher.

A FlightOrder names a hangar drone and a mission. The agent finds the stored design for that drone (packed once
from the configurator), starts it as a new simulated vehicle (/api/sim/refly), asks the shared airspace for a
corridor (SpacetimeDB track, optional), then flies through the copilot's intent route: take off, go to the place,
and reports telemetry. Commands go straight to the engine's tools (/api/sim/vehicles), not through a model, and
the agent waits for ArduPilot's pre-arm state (GPS fix, EKF good) before it arms. Progress streams back to the dispatcher as text; the dispatcher relays it to ASI:One.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any, Callable

from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.payment import CommitPayment

from . import airspace
from .addresses import LocalFirstResolver, dispatcher_address, local_rules
from .config import Settings, describe_missing, load_settings
from .payment import request_payment, seller_protocol
from .protocol import FlightOrder, FlightProgress, FlightResult, PaymentQuote
from .render_api import RenderApi, RenderApiError, StoredDesign, VehicleState

FLIGHT_PROTOCOL_NAME = "dronex-flight"
FLIGHT_AGENT_NAME = "dronex-flight"
READY_TIMEOUT_S = 120
CLIMB_TIMEOUT_S = 25
TAKEOFF_ATTEMPTS = 3
POLL_S = 2.0


def _describe(st: VehicleState) -> str:
    t, v = st.telemetry, st.vehicle
    parts = [str(v.get("mode") or "?"), "armed" if st.armed else "disarmed"]
    if st.altitude_m is not None:
        parts.append(f"{st.altitude_m:.0f} m")
    if t.get("gpsSatellites") is not None:
        parts.append(f"{t['gpsSatellites']:.0f} satellites")
    if t.get("ekfStatus"):
        parts.append(f"EKF {t['ekfStatus']}")
    return ", ".join(parts)


def pick_design(designs: list[StoredDesign], preset_id: str, design_id: str | None) -> StoredDesign | None:
    if design_id:
        hit = next((d for d in designs if d.id == design_id), None)
        if hit:
            return hit
    based = [d for d in designs if d.based_on == preset_id]
    if based:
        return sorted(based, key=lambda d: d.created_at, reverse=True)[0]
    return None


class FlightRunner:
    def __init__(self, s: Settings, api: RenderApi, poll_s: float = POLL_S):
        self.s = s
        self.api = api
        self.poll_s = poll_s

    async def _wait(self, done: Callable[[VehicleState], bool], timeout_s: float, vid: str) -> VehicleState | None:
        """Polls the vehicle until `done` or the timeout; returns the last state seen (None if never reachable)."""
        last: VehicleState | None = None
        deadline = time.monotonic() + timeout_s
        while True:
            try:
                last = await self.api.vehicle(vid)
                if done(last):
                    return last
            except RenderApiError:
                pass
            if time.monotonic() >= deadline:
                return last
            await asyncio.sleep(self.poll_s)

    async def _go_to_place(self, order: FlightOrder, vid: str, start: tuple[float, float] | None, progress) -> str | None:
        """Locate the place, reserve the corridor to it in the shared airspace, then go. Returns the place when the
        vehicle is on its way, None when it holds where it is (not found, corridor refused, go-to refused)."""
        place = order.place or ""
        try:
            here = await self.api.vehicle(vid, place=place)
        except RenderApiError as e:
            await progress(f"could not look up {place}: {e}; holding at the current height")
            return None
        if not here.place:
            await progress(f"I could not find a place called {place} near the vehicle; holding at the current height")
            return None
        lat, lon = here.telemetry.get("latitudeDeg"), here.telemetry.get("longitudeDeg")
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            start = (float(lat), float(lon))
        end = (float(here.place["latitudeDeg"]), float(here.place["longitudeDeg"]))
        if start is not None:
            answer = await airspace.reserve_corridor(self.api, vehicle_id=vid, name=str(here.place.get("name") or place), start=start, end=end, altitude_m=order.altitude_m)
            await progress(answer.line)
            if answer.granted is False:
                await progress("holding at the current height until the corridor is free; ask me again in a minute")
                return None
        await progress(f"going to {here.place.get('name') or place} at {order.altitude_m:g} metres…")
        try:
            said = await self.api.tool(vid, "goto_place", place=place, altitude_m=order.altitude_m)
        except RenderApiError as e:
            await progress(f"go-to failed: {e}")
            return None
        await progress(said)
        return None if "refused" in said or said.startswith("I could not find") else str(here.place.get("name") or place)

    async def _failed(self, order: FlightOrder, vid: str) -> None:
        await self.api.record_mission(vehicle_id=vid, mission_id=order.mission_id, agent=FLIGHT_AGENT_NAME, status="failed")

    async def run(self, ctx: Context, order: FlightOrder, progress) -> FlightResult:
        try:
            designs = await self.api.designs()
        except RenderApiError as e:
            return FlightResult(order_id=order.order_id, ok=False, summary=str(e))
        design = pick_design(designs, order.preset_id, order.design_id)
        if design is None:
            return FlightResult(
                order_id=order.order_id,
                ok=False,
                summary=f"The hangar drone {order.preset_id} has not been packed for the simulator yet. Open {self.s.render_url}/?build={order.preset_id}, press Build all, then Fly in simulation once; after that I can fly it on request.",
            )
        await progress(f"packing {design.name} (design {design.id}) into the simulator…")
        try:
            flown = await self.api.refly(design.id)
        except RenderApiError as e:
            return FlightResult(order_id=order.order_id, ok=False, design_id=design.id, summary=f"the simulator did not start the vehicle: {e}")
        vid = flown.vehicle_id
        map_url = f"{self.s.sim_ui_url}/?vehicle={vid}"
        copilot_url = f"{self.s.render_url}/copilot"
        await progress(f"{flown.name or design.name} is online in the simulator (vehicle {vid[:8]}…). Map: {map_url}")
        await self.api.record_mission(vehicle_id=vid, mission_id=order.mission_id, agent=FLIGHT_AGENT_NAME, status="accepted")

        # ArduPilot refuses to arm until its pre-arm checks pass (GPS 3D fix, EKF converged): wait for that first.
        await progress("waiting for a GPS fix and the EKF to settle before arming (about a minute in the simulator)…")
        state = await self._wait(lambda st: st.ready, READY_TIMEOUT_S, vid)
        if state is None or not state.ready:
            await self._failed(order, vid)
            return FlightResult(order_id=order.order_id, ok=False, vehicle_id=vid, vehicle_name=flown.name, design_id=design.id, map_url=map_url, copilot_url=copilot_url, summary=f"the vehicle did not get a GPS fix and a good EKF within {READY_TIMEOUT_S} s, so it cannot arm; it is still on the map, try again in a minute")
        await progress(f"GPS fix and EKF good ({_describe(state)})")
        lat, lon = state.telemetry.get("latitudeDeg"), state.telemetry.get("longitudeDeg")
        start = (float(lat), float(lon)) if isinstance(lat, (int, float)) and isinstance(lon, (int, float)) else None

        climb = min(order.altitude_m, 30)
        await progress(f"arming and taking off to {climb:g} metres…")
        state = None
        for attempt in range(TAKEOFF_ATTEMPTS):
            try:
                await progress(await self.api.tool(vid, "takeoff", altitude_m=climb))
            except RenderApiError as e:
                await self._failed(order, vid)
                return FlightResult(order_id=order.order_id, ok=False, vehicle_id=vid, vehicle_name=flown.name, design_id=design.id, map_url=map_url, copilot_url=copilot_url, summary=f"takeoff failed: {e}")
            state = await self._wait(lambda st: (st.altitude_m or 0) >= 0.5 * climb, CLIMB_TIMEOUT_S, vid)
            if state is not None and (state.altitude_m or 0) >= 0.5 * climb:
                break
            await progress(f"not climbing yet ({_describe(state) if state else 'no telemetry'}); retrying")
        else:
            await self._failed(order, vid)
            return FlightResult(order_id=order.order_id, ok=False, vehicle_id=vid, vehicle_name=flown.name, design_id=design.id, map_url=map_url, copilot_url=copilot_url, summary=f"the vehicle did not climb after {TAKEOFF_ATTEMPTS} takeoff attempts ({_describe(state) if state else 'no telemetry'})")
        await progress(f"airborne at {state.altitude_m:.0f} m")

        heading_to: str | None = None
        if order.place:
            heading_to = await self._go_to_place(order, vid, start, progress)
        await self.api.record_mission(vehicle_id=vid, mission_id=order.mission_id, agent=FLIGHT_AGENT_NAME, status="flying")
        await asyncio.sleep(5)
        try:
            st = await self.api.vehicle(vid)
            telemetry = {"status": _describe(st), "telemetry": st.telemetry}
        except RenderApiError:
            telemetry = {}
        return FlightResult(
            order_id=order.order_id,
            ok=True,
            vehicle_id=vid,
            vehicle_name=flown.name or design.name,
            design_id=design.id,
            map_url=map_url,
            copilot_url=copilot_url,
            telemetry_json=json.dumps(telemetry),
            summary=f"{flown.name or design.name} is flying{f' toward {heading_to}' if heading_to else f' at {climb:g} m (not going to {order.place}, see above)' if order.place else ''}. Watch it on the 3D map or talk to it on the Copilot page.",
        )


def build_flight_agent(s: Settings, api: RenderApi) -> Agent:
    agent = Agent(
        name=FLIGHT_AGENT_NAME,
        seed=s.flight_seed,
        port=s.flight_port,
        endpoint=s.flight_endpoint,
        mailbox=s.flight_mailbox,
        resolve=LocalFirstResolver(local_rules(s)),
        publish_agent_details=s.flight_mailbox,
        readme_path=str(Path(__file__).resolve().parents[1] / "readme" / "flight.md"),
        enable_agent_inspector=False,
        description="DroneX flight agent: starts a verified design in the ArduPilot simulator over a real city, reserves a corridor in the shared airspace and flies the mission.",
    )
    runner = FlightRunner(s, api)
    proto = Protocol(name=FLIGHT_PROTOCOL_NAME, version="0.1.0")
    pending: dict[str, FlightOrder] = {}

    async def fly(ctx: Context, order: FlightOrder) -> None:
        async def progress(text: str) -> None:
            ctx.logger.info(f"[{order.order_id}] {text}")
            await ctx.send(order.reply_to, FlightProgress(order_id=order.order_id, text=text))

        result = await runner.run(ctx, order, progress)
        await ctx.send(order.reply_to, result)

    @proto.on_message(FlightOrder)
    async def on_order(ctx: Context, sender: str, order: FlightOrder) -> None:
        ctx.logger.info(f"order {order.order_id}: {order.preset_id} on {order.mission_id} from {sender[:12]}…")
        if s.payments:
            pending[order.order_id] = order
            try:
                await request_payment(ctx, sender, recipient=str(agent.wallet.address()), reference=order.order_id, price_fet=s.flight_price_fet, description=f"one simulated flight of {order.preset_id} on {order.mission_id}")
            except Exception as e:  # never strand an order on a payment problem
                ctx.logger.exception("payment request failed")
                pending.pop(order.order_id, None)
                await ctx.send(order.reply_to, FlightProgress(order_id=order.order_id, text=f"could not quote a price ({e}); flying without payment"))
                await fly(ctx, order)
                return
            await ctx.send(order.reply_to, FlightProgress(order_id=order.order_id, text=f"quoted {s.flight_price_fet} FET (testnet) for this flight; waiting for the dispatcher to commit"))
            return
        await fly(ctx, order)

    @proto.on_message(PaymentQuote)
    async def on_quote(ctx: Context, sender: str, q: PaymentQuote) -> None:
        await ctx.send(sender, FlightProgress(order_id=q.order_id, text=f"a simulated flight costs {s.flight_price_fet} FET on testnet" if s.payments else "payments are off; flights are free"))

    async def on_committed(ctx: Context, buyer: str, commit: CommitPayment) -> None:
        order = pending.pop(commit.reference or "", None)
        if order is None:
            ctx.logger.warning(f"commit for unknown order {commit.reference}")
            return
        await ctx.send(order.reply_to, FlightProgress(order_id=order.order_id, text=f"payment received ({'ledger tx ' + commit.transaction_id if commit.transaction_id else 'by reference, no FET moved'}); flying"))
        await fly(ctx, order)

    async def on_unpaid(ctx: Context, commit: CommitPayment, why: str) -> None:
        order = pending.pop(commit.reference or "", None)
        if order is not None:
            await ctx.send(order.reply_to, FlightResult(order_id=order.order_id, ok=False, summary=f"the payment did not check out on the testnet ({why}), so I did not fly"))

    agent.include(proto, publish_manifest=s.flight_mailbox)
    if s.payments:
        agent.include(seller_protocol(on_committed, recipient=str(agent.wallet.address()), verify_ledger=s.payments_ledger, on_unpaid=on_unpaid), publish_manifest=s.flight_mailbox)
    return agent


def main() -> None:
    s = load_settings()
    api = RenderApi(s.render_url)
    agent = build_flight_agent(s, api)
    print("DroneX flight agent")
    for line in describe_missing(s):
        print(f"  note: {line}")
    print(f"  address  {agent.address}")
    print(f"  dispatcher {dispatcher_address(s)}")
    print(f"  payments {'on (' + s.flight_price_fet + ' FET testnet per flight)' if s.payments else 'off (DRONEX_PAYMENTS=1 to quote)'}")
    agent.run()


if __name__ == "__main__":
    main()
