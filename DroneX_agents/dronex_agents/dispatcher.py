"""The Dispatcher: the agent a person talks to in ASI:One.

Agent Chat Protocol in, Interactive Cards out. A sentence becomes a mission request (model or rules); missing
facts are asked with a form card; the fleet agents are asked what they can do; candidates come back as a carousel
with pass/fail badges and the failing check; the chosen drone's physics verdict is a review card; on approval the
flight agent flies it and the progress streams back; the result is a detail card with links to the 3D map and
the Copilot page. When nothing passes, the dispatcher names the failing check and offers the one-part swap the
configurator has re-judged as passing, with a link to open that build.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    MetadataContent,
    StartSessionContent,
    TextContent,
    chat_protocol_spec,
)

from .addresses import LocalFirstResolver, fleet_addresses, flight_address, local_rules
from .cards import carousel_card, carousel_item, detail_card, form_card, number_field, parse_card_response, review_card, select_field, text_field, numbers_from
from .config import Settings, describe_missing, load_settings
from .llm import ModelCall, make_model_call
from .mission import MISSION_KINDS, Candidate, MissionRequest, find_swap, judge_candidate, parse_request, parse_request_rules, rank, review_rows
from .payment import buyer_protocol
from .protocol import CapabilityQuery, CapabilityReply, FlightOrder, FlightProgress, FlightResult
from .render_api import Preset, RenderApi, RenderApiError

GREETING = (
    "I am DroneX Dispatch. Tell me the job and I will find a drone in the hangar that the physics says can do it, "
    "show you its numbers, and fly it in the simulator over San Francisco. For example: "
    "\"Fly a 10 km ridge run to Twin Peaks within 15 minutes\", "
    "\"Survey 40 hectares of crops near Candlestick Point within 25 minutes\", or "
    "\"Deliver 500 g of blood samples 6 km to UCSF within 20 minutes\"."
)


def now() -> datetime:
    return datetime.now(timezone.utc)


def text_message(*parts: str | MetadataContent, end: bool = False) -> ChatMessage:
    content: list[Any] = []
    for p in parts:
        content.append(TextContent(type="text", text=p) if isinstance(p, str) else p)
    if end:
        content.append(EndSessionContent(type="end-session"))
    return ChatMessage(timestamp=now(), msg_id=uuid.uuid4(), content=content)


def is_new_job(text: str) -> bool:
    """A sentence that states a job (a distance and a time), as opposed to a command for the flying drone."""
    r = parse_request_rules(text)
    return r.distance_km is not None and r.time_min is not None


class Session:
    """One user's conversation, kept in agent storage as JSON."""

    def __init__(self, data: dict[str, Any] | None = None):
        d = data or {}
        self.stage: str = d.get("stage", "idle")
        self.request: MissionRequest | None = MissionRequest.from_json(d["request"]) if d.get("request") else None
        self.candidates: list[dict[str, Any]] = d.get("candidates", [])
        self.chosen: str | None = d.get("chosen")
        self.swaps: dict[str, Any] | None = d.get("swaps")
        self.order_id: str | None = d.get("order_id")
        self.vehicle_id: str | None = d.get("vehicle_id")

    def to_dict(self) -> dict[str, Any]:
        return {"stage": self.stage, "request": self.request.to_json() if self.request else None, "candidates": self.candidates, "chosen": self.chosen, "swaps": self.swaps, "order_id": self.order_id, "vehicle_id": self.vehicle_id}


def form_for(req: MissionRequest) -> MetadataContent:
    fields = [select_field("kind", "What kind of mission?", [(k, k.title()) for k in MISSION_KINDS], required=True)]
    if req.payload_g is None:
        fields.append(number_field("payload_g", "Payload to carry (grams)", required=req.kind == "delivery"))
    if req.distance_km is None:
        fields.append(number_field("distance_km", "Distance to cover (km)", required=True))
    if req.time_min is None:
        fields.append(number_field("time_min", "Time limit (minutes)", required=True))
    if not req.place:
        fields.append(text_field("place", "Destination (a place in San Francisco)"))
    return form_card("What does the mission need?", fields, submit_label="Find a drone")


def merge_form(req: MissionRequest, ans: dict[str, Any]) -> MissionRequest:
    kind = ans.get("kind") if ans.get("kind") in MISSION_KINDS else req.kind
    return MissionRequest(
        kind=kind,
        mission_id=MISSION_KINDS[kind][0],
        text=req.text,
        payload_g=numbers_from(ans, "payload_g") if ans.get("payload_g") not in (None, "") else req.payload_g,
        distance_km=numbers_from(ans, "distance_km") if ans.get("distance_km") not in (None, "") else req.distance_km,
        time_min=numbers_from(ans, "time_min") if ans.get("time_min") not in (None, "") else req.time_min,
        place=str(ans["place"]) if ans.get("place") else req.place,
        launch=req.launch,
    )


def carousel_for(cands: list[Candidate], req: MissionRequest) -> MetadataContent:
    items = []
    for c in cands[:8]:
        badges = [("READY", "success")] if c.passes else [("NOT READY", "danger")]
        if c.hover_time_min is not None:
            badges.append((f"{c.hover_time_min:.0f} min hover est.", "neutral"))
        if c.hover_twr is not None:
            badges.append((f"{c.hover_twr:.1f}× lift est.", "neutral"))
        items.append(
            carousel_item(
                c.preset_id,
                c.name,
                f"{c.auw_g:.0f} g all-up (est.)" if c.auw_g is not None else "",
                badges=badges,
                secondary_text=c.why if not c.passes else "passes every check for this mission",
                cta_label="Choose this drone" if c.passes else "See its numbers",
                selection={"action": "select", "preset_id": c.preset_id},
            )
        )
    passing = sum(1 for c in cands if c.passes)
    return carousel_card("Hangar candidates", f"{passing} of {len(cands)} pass {req.describe()}", items)


class Dispatcher:
    def __init__(self, s: Settings, api: RenderApi, model: ModelCall | None):
        self.s = s
        self.api = api
        self.model = model
        self.fleet = fleet_addresses(s)
        self.flight = flight_address(s)
        self.orders: dict[str, str] = {}  # order id → the ASI:One user to relay to

    # -- storage -------------------------------------------------------------------------------------------------
    def load(self, ctx: Context, sender: str) -> Session:
        raw = ctx.storage.get(f"session:{sender}")
        return Session(json.loads(raw)) if isinstance(raw, str) else Session(raw if isinstance(raw, dict) else None)

    def save(self, ctx: Context, sender: str, sess: Session) -> None:
        ctx.storage.set(f"session:{sender}", json.dumps(sess.to_dict()))

    # -- fleet ---------------------------------------------------------------------------------------------------
    async def ask_fleet(self, ctx: Context, req: MissionRequest) -> list[Candidate]:
        request_id = uuid.uuid4().hex[:8]
        q = CapabilityQuery(request_id=request_id, mission_id=req.mission_id, payload_g=req.payload_g, distance_km=req.distance_km, time_min=req.time_min)

        async def one(pid: str, addr: str) -> Candidate | None:
            try:
                reply, status = await ctx.send_and_receive(addr, q, response_type=CapabilityReply, timeout=12)
            except Exception as e:  # resolver or transport
                ctx.logger.warning(f"fleet {pid}: {e}")
                return None
            if not isinstance(reply, CapabilityReply) or not reply.preset_json or reply.preset_json == "{}":
                return None
            preset = Preset.parse(json.loads(reply.preset_json))
            return judge_candidate(preset, req)

        results = await asyncio.gather(*(one(pid, addr) for pid, addr in self.fleet.items()))
        cands = [c for c in results if c is not None]
        if len(cands) < len(self.fleet):
            # The fleet is down or partial: the configurator's catalog is the same source of truth.
            try:
                cat = await self.api.catalog()
                have = {c.preset_id for c in cands}
                for p in cat.presets:
                    if p.id not in have:
                        cands.append(judge_candidate(p, req))
                if not results or all(r is None for r in results):
                    ctx.logger.warning("no fleet agent answered; judged from /api/catalog directly")
            except RenderApiError as e:
                ctx.logger.error(f"catalog: {e}")
        return rank(cands)

    # -- conversation --------------------------------------------------------------------------------------------
    async def start(self, ctx: Context, sender: str, sess: Session, text: str) -> list[ChatMessage]:
        req = await parse_request(text, self.model)
        sess.request = req
        if req.missing():
            sess.stage = "await_form"
            return [text_message(f"Got it: {req.describe()}. A few facts first, so the physics can judge it.", form_for(req))]
        return await self.find(ctx, sender, sess)

    async def find(self, ctx: Context, sender: str, sess: Session) -> list[ChatMessage]:
        req = sess.request
        assert req is not None
        cands = await self.ask_fleet(ctx, req)
        if not cands:
            sess.stage = "idle"
            return [text_message("I could not reach the hangar: the configurator at " + self.s.render_url + " is not answering. Start it with ./dev.sh and ask again.")]
        sess.candidates = [{"preset_id": c.preset_id, "name": c.name, "passes": c.passes, "why": c.why} for c in cands]
        passing = [c for c in cands if c.passes]
        if passing:
            sess.stage = "await_pick"
            names = ", ".join(c.name for c in passing)
            return [text_message(f"{len(passing)} drone{'s' if len(passing) != 1 else ''} in the hangar {'pass' if len(passing) != 1 else 'passes'} {req.describe()}: {names}. Pick one and I will show its verdict.", carousel_for(cands, req))]
        # Nothing passes: say why, and look for the one swap that fixes the best candidate.
        best = cands[0]
        preset = Preset.parse(best.preset)
        msgs = [text_message(f"No hangar drone passes {req.describe()} as built. Closest is {best.name}: {best.why}.", carousel_for(cands, req))]
        swap = await find_swap(self.api, preset, req, self.s.data_dir)
        if swap:
            sess.stage = "await_review"
            sess.chosen = best.preset_id
            sess.swaps = {swap.slot: swap.to_id}
            rows = review_rows(f"{best.name} with {swap.slot.replace('Id', '')} {swap.to_id}", swap.row, swap.verdict.summary, req, swap.verdict.warnings)
            msgs.append(
                text_message(
                    f"One swap fixes it: {swap.describe()}. Open it in the configurator to see the parts: {self.s.render_url}/?build={best.preset_id}. Approve below and I will fly the swapped build's hangar drone in the simulator.",
                    review_card("Proposed build", rows, approve_selection={"action": "confirm", "preset_id": best.preset_id}, reject_selection={"action": "cancel"}),
                )
            )
        else:
            sess.stage = "await_pick"
            msgs.append(text_message(f"No single battery, propeller or motor swap makes it pass. Pick a drone above to see its numbers, or change the request. The build is at {self.s.render_url}/?build={best.preset_id}."))
        return msgs

    async def pick(self, ctx: Context, sender: str, sess: Session, text: str) -> list[ChatMessage]:
        ids = [c["preset_id"] for c in sess.candidates]
        ans = parse_card_response(text, known_ids=ids, known_keys=["preset_id", "id", "action"])
        pid = ans.get("preset_id") or ans.get("id")
        if not isinstance(pid, str) or pid not in ids:
            # A name instead of an id?
            lowered = text.lower()
            match = next((c for c in sess.candidates if c["name"].lower() in lowered or c["preset_id"] in lowered), None)
            if not match:
                return [text_message("Which drone? Say its name, or pick one from the cards.")]
            pid = match["preset_id"]
        req = sess.request
        assert req is not None
        try:
            v = await self.api.verdict(preset_id=pid, mission_id=req.mission_id)
        except RenderApiError as e:
            return [text_message(f"The configurator could not judge {pid}: {e}")]
        row = v.mission(req.mission_id)
        name = next((c["name"] for c in sess.candidates if c["preset_id"] == pid), pid)
        sess.stage = "await_review"
        sess.chosen = pid
        sess.swaps = None
        rows = review_rows(name, row, v.summary, req, v.warnings)
        verdict_line = "The physics says it is ready." if row and row.ready else f"The physics says it is not ready: {'; '.join(c.reason for c in (row.failing_checks() if row else []))}."
        return [text_message(f"{name}: {verdict_line} Every number is an estimate from the dataset's own figures. Approve to fly it in the simulator.", review_card(f"{name}", rows, approve_selection={"action": "confirm", "preset_id": pid}, reject_selection={"action": "cancel"}))]

    async def review(self, ctx: Context, sender: str, sess: Session, text: str) -> list[ChatMessage]:
        ans = parse_card_response(text, known_keys=["action", "preset_id"])
        if ans.get("action") == "cancel" or ans.get("action") not in ("confirm", "submit", "select", None) and ans.get("action") != "confirm":
            sess.stage = "await_pick"
            return [text_message("Not that one. Pick another drone from the cards, or describe a different mission.")]
        if ans.get("action") != "confirm":
            return [text_message("Approve the review to fly, or say no to pick another.")]
        req = sess.request
        pid = sess.chosen
        assert req is not None and pid is not None
        order_id = uuid.uuid4().hex[:8]
        sess.order_id = order_id
        sess.stage = "flying"
        self.orders[order_id] = sender
        order = FlightOrder(order_id=order_id, preset_id=pid, mission_id=req.mission_id, mission_text=req.text, place=req.place, altitude_m=40.0, reply_to=ctx.agent.address)
        status = await ctx.send(self.flight, order)
        ctx.logger.info(f"order {order_id} → flight agent: {status.status}")
        note = f" (swapped {', '.join(f'{k} → {v}' for k, v in sess.swaps.items())}; the simulator flies the stored hangar build, the swap changes its battery model only once you re-pack it)" if sess.swaps else ""
        return [text_message(f"Dispatching {pid} to the simulator{note}. I will report as it packs, takes off and flies.")]

    async def on_text(self, ctx: Context, sender: str, text: str) -> list[ChatMessage]:
        sess = self.load(ctx, sender)
        lowered = text.strip().lower()
        try:
            if lowered in ("", "hi", "hello", "help", "start") or lowered.startswith("what can you"):
                return [text_message(GREETING)]
            if sess.stage == "await_form":
                ans = parse_card_response(text, known_keys=["kind", "payload_g", "distance_km", "time_min", "place", "action"])
                if ans and any(k in ans for k in ("payload_g", "distance_km", "time_min", "place", "kind")):
                    sess.request = merge_form(sess.request or await parse_request(text, self.model), ans)
                else:
                    sess.request = await parse_request(f"{sess.request.text if sess.request else ''} {text}", self.model)
                if sess.request.missing():
                    return [text_message("Still missing: " + ", ".join(m.replace("_", " ") for m in sess.request.missing()) + ".", form_for(sess.request))]
                return await self.find(ctx, sender, sess)
            if sess.stage == "await_pick":
                ans = parse_card_response(text, known_ids=[c["preset_id"] for c in sess.candidates], known_keys=["preset_id", "action"])
                if ans.get("preset_id") or ans.get("id") or any(c["name"].lower() in lowered or c["preset_id"] in lowered for c in sess.candidates):
                    return await self.pick(ctx, sender, sess, text)
                return await self.start(ctx, sender, sess, text)
            if sess.stage == "await_review":
                return await self.review(ctx, sender, sess, text)
            if sess.stage == "flying":
                action = parse_card_response(text, known_keys=["action"]).get("action")
                if action == "new" or any(w in lowered for w in ("another", "new mission", "again", "next")):
                    sess.stage = "idle"
                    return [text_message("Ready for the next mission. What is the job?")]
                if is_new_job(text):
                    # A whole new job sentence (distance and time), not a command for the drone in the air.
                    sess.stage = "idle"
                    return await self.start(ctx, sender, sess, text)
                if action == "watch":
                    text = "status"
                # Pass pilot commands to the vehicle in the air through the copilot while a flight is on.
                try:
                    r = await self.api.intent(text, sess.vehicle_id)
                    return [text_message(r.reply)]
                except RenderApiError as e:
                    return [text_message(f"The flight is on; I could not relay that command: {e}")]
            return await self.start(ctx, sender, sess, text)
        finally:
            self.save(ctx, sender, sess)


README_DIR = Path(__file__).resolve().parents[1] / "readme"


def build_dispatcher(s: Settings, api: RenderApi, model: ModelCall | None) -> tuple[Agent, Dispatcher]:
    agent = Agent(
        name="DroneX Dispatch",
        seed=s.dispatcher_seed,
        port=s.dispatcher_port,
        endpoint=None if s.mailbox else s.dispatcher_endpoint,
        mailbox=s.mailbox,
        resolve=LocalFirstResolver(local_rules(s)),
        publish_agent_details=True,
        handle="dronex-dispatch",
        readme_path=str(README_DIR / "dispatcher.md"),
        description="Tell DroneX Dispatch the job and it finds a hangar drone the physics says can do it, shows the verdict, and flies it in an ArduPilot simulator over San Francisco.",
    )
    d = Dispatcher(s, api, model)
    chat = Protocol(spec=chat_protocol_spec)

    @chat.on_message(ChatMessage)
    async def on_chat(ctx: Context, sender: str, msg: ChatMessage) -> None:
        await ctx.send(sender, ChatAcknowledgement(timestamp=now(), acknowledged_msg_id=msg.msg_id))
        text = "".join(c.text for c in msg.content if isinstance(c, TextContent)).strip()
        started = any(isinstance(c, StartSessionContent) for c in msg.content)
        ended = any(isinstance(c, EndSessionContent) for c in msg.content)
        if ended and not text:
            ctx.storage.remove(f"session:{sender}")
            return
        if started and not text:
            await ctx.send(sender, text_message(GREETING))
            return
        ctx.logger.info(f"{sender[:12]}…: {text[:120]}")
        try:
            replies = await d.on_text(ctx, sender, text)
        except Exception as e:  # never leave the user without an answer
            ctx.logger.exception("dispatch failed")
            replies = [text_message(f"Something went wrong on my side: {e}. Try again, or say 'help'.")]
        for r in replies:
            await ctx.send(sender, r)

    @chat.on_message(ChatAcknowledgement)
    async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement) -> None:
        pass

    flight = Protocol(name="dronex-flight", version="0.1.0")

    @flight.on_message(FlightProgress)
    async def on_progress(ctx: Context, sender: str, msg: FlightProgress) -> None:
        user = d.orders.get(msg.order_id)
        if user:
            await ctx.send(user, text_message(msg.text))

    @flight.on_message(FlightResult)
    async def on_result(ctx: Context, sender: str, msg: FlightResult) -> None:
        user = d.orders.pop(msg.order_id, None)
        if not user:
            return
        sess = d.load(ctx, user)
        sess.stage = "flying" if msg.ok else "idle"
        sess.vehicle_id = msg.vehicle_id if msg.ok else None
        d.save(ctx, user, sess)
        if not msg.ok:
            await ctx.send(user, text_message(f"The flight did not start: {msg.summary}"))
            return
        telemetry = json.loads(msg.telemetry_json or "{}")
        rows = [("Vehicle", msg.vehicle_name or ""), ("Design", msg.design_id or ""), ("3D map", msg.map_url or ""), ("Copilot", msg.copilot_url or "")]
        if telemetry.get("status"):
            rows.append(("Telemetry", str(telemetry["status"])))
        card = detail_card("In the air", rows, [("Fly another mission", {"action": "new"}), ("Keep watching", {"action": "watch"})])
        await ctx.send(user, text_message(f"{msg.summary} Map: {msg.map_url}. Copilot: {msg.copilot_url}. While it flies you can tell me things like 'return to launch' or 'what's the battery'.", card))

    agent.include(chat, publish_manifest=True)
    agent.include(flight, publish_manifest=False)
    if s.payments:
        agent.include(buyer_protocol(s.payments_ledger, agent.wallet), publish_manifest=True)
    return agent, d


def main() -> None:
    s = load_settings()
    api = RenderApi(s.render_url)
    model = make_model_call(s)
    agent, _ = build_dispatcher(s, api, model)
    print("DroneX Dispatch (the agent you talk to in ASI:One)")
    for line in describe_missing(s):
        print(f"  note: {line}")
    print(f"  address   {agent.address}")
    print(f"  flight    {flight_address(s)}")
    print(f"  fleet     {len(fleet_addresses(s))} agents")
    print(f"  mailbox   {'on: open the inspector link below, Connect → Mailbox' if s.mailbox else 'off (DRONEX_MAILBOX=1 for ASI:One)'}")
    write_status(s, agent.address)
    agent.run()


STATUS_FILE = Path(__file__).resolve().parents[1] / "logs" / "agents.json"


def write_status(s: Settings, address: str) -> None:
    """Who is who, for the configurator's /dispatch page (it reads this file and probes the ports itself)."""
    STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATUS_FILE.write_text(
        json.dumps(
            {
                "startedAt": datetime.now(timezone.utc).isoformat(),
                "dispatcher": {"name": "DroneX Dispatch", "handle": "dronex-dispatch", "address": address, "port": s.dispatcher_port, "mailbox": s.mailbox},
                "flight": {"address": flight_address(s), "port": s.flight_port, "payments": s.payments, "ledger": s.payments_ledger, "priceFet": s.flight_price_fet},
                "fleet": {"port": s.fleet_port, "agents": fleet_addresses(s)},
                "model": s.intent_model if s.has_model else None,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
