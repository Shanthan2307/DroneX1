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
import time
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

from .addresses import LocalFirstResolver, fleet_addresses, flight_address, flight_wallet_address, local_rules
from .cards import carousel_card, carousel_item, detail_card, form_card, number_field, parse_card_response, review_card, select_field, text_field, numbers_from
from .config import Settings, describe_missing, exit_if_unsafe, load_settings
from .limits import ActiveFlight, ActiveFlights, ModelBudget, RateLimiter, prune_index
from .llm import ModelCall, make_model_call
from .mission import MISSION_KINDS, Candidate, MissionRequest, find_swap, judge_candidate, parse_request, parse_request_rules, rank, review_rows
from .payment import buyer_protocol, fet_to_atestfet
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


END_FLIGHT = ("end flight", "end the flight", "end my flight", "stop the flight", "stop my flight", "stop the simulation", "remove the drone", "i am done", "i'm done", "im done")
ACTIVE_KEY = "active_flights"
SESSION_INDEX_KEY = "session_index"
SWEEP_PERIOD_S = 20.0


def wants_to_end(text: str) -> bool:
    lowered = text.strip().lower()
    return any(p in lowered for p in END_FLIGHT)


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
        self.last_dispatch: float = float(d.get("last_dispatch") or 0.0)

    def to_dict(self) -> dict[str, Any]:
        return {"stage": self.stage, "request": self.request.to_json() if self.request else None, "candidates": self.candidates, "chosen": self.chosen, "swaps": self.swaps, "order_id": self.order_id, "vehicle_id": self.vehicle_id, "last_dispatch": self.last_dispatch}


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
        self.budget = ModelBudget(s.dispatch_daily_model_calls)
        self.model = self.budget.wrap(model)  # past the daily cap, parse_request falls back to the rule parser
        self.rate = RateLimiter(s.dispatch_rate_per_min, s.dispatch_rate_per_day)
        self.active = ActiveFlights(s.dispatch_max_active, s.dispatch_ttl_min * 60.0)
        self._restored = False
        self.fleet = fleet_addresses(s)
        self.flight = flight_address(s)

    # -- limits --------------------------------------------------------------------------------------------------
    def admit(self, sender: str, text: str, now: float | None = None) -> str | None:
        """Why this chat message is not processed (rate or length), or None. Runs before any model or API call."""
        why = self.rate.check(sender, now)
        if why:
            return f"Sorry, {why}"
        if len(text) > self.s.dispatch_max_input_chars:
            return f"That message is too long ({len(text)} characters). Please keep it under {self.s.dispatch_max_input_chars}: the job, the distance, the time and the place are enough."
        return None

    # -- storage -------------------------------------------------------------------------------------------------
    def load(self, ctx: Context, sender: str) -> Session:
        raw = ctx.storage.get(f"session:{sender}")
        return Session(json.loads(raw)) if isinstance(raw, str) else Session(raw if isinstance(raw, dict) else None)

    def save(self, ctx: Context, sender: str, sess: Session) -> None:
        ctx.storage.set(f"session:{sender}", json.dumps(sess.to_dict()))
        index = self._index(ctx)
        index[sender] = time.time()
        ctx.storage.set(SESSION_INDEX_KEY, json.dumps(index))

    def _index(self, ctx: Context) -> dict[str, float]:
        raw = ctx.storage.get(SESSION_INDEX_KEY)
        try:
            d = json.loads(raw) if isinstance(raw, str) else raw
        except ValueError:
            d = None
        return dict(d) if isinstance(d, dict) else {}

    def prune_sessions(self, ctx: Context, now: float | None = None) -> list[str]:
        """Forget sessions idle for longer than a day (users with a vehicle in the simulator keep theirs)."""
        index = self._index(ctx)
        keep = {u: index[u] for u in self.active.by_user if u in index}
        old = [u for u in prune_index(index, self.s.session_max_age_h * 3600.0, now) if u not in keep]
        index.update(keep)
        for u in old:
            ctx.storage.remove(f"session:{u}")
        if old:
            ctx.storage.set(SESSION_INDEX_KEY, json.dumps(index))
        self.rate.prune(now)
        return old

    def restore(self, ctx: Context) -> None:
        """The active flights survive a restart in agent storage, so their vehicles still get stopped."""
        if self._restored:
            return
        raw = ctx.storage.get(ACTIVE_KEY)
        try:
            self.active.load_json(json.loads(raw) if isinstance(raw, str) else raw)
        except ValueError:
            pass
        self._restored = True

    def persist(self, ctx: Context) -> None:
        ctx.storage.set(ACTIVE_KEY, json.dumps(self.active.to_json()))

    # -- vehicles ------------------------------------------------------------------------------------------------
    async def sweep(self, ctx: Context, now: float | None = None) -> None:
        """Stop every Dispatch vehicle whose time is up (TTL after its result, a failed start, an ended flight), drop
        orders that never got a result, and prune old sessions."""
        self.restore(ctx)
        stop, stale = self.active.due(now)
        for f in stale:
            ctx.logger.warning(f"order {f.order_id}: no result from the flight agent; slot freed")
            self._reset_session(ctx, f, None)
        for f in stop:
            assert f.vehicle_id is not None
            try:
                await self.api.stop(f.vehicle_id)
            except Exception as e:  # RenderApiError, or anything else: retry later, never crash the interval
                if self.active.stop_failed(f, now):
                    ctx.logger.warning(f"stopping {f.vehicle_id}: {e}; retrying in a minute")
                else:
                    ctx.logger.error(f"stopping {f.vehicle_id}: {e}; giving up (the engine's own reaper has to remove it)")
                continue
            ctx.logger.info(f"stopped vehicle {f.vehicle_id} of order {f.order_id}")
            self.active.stopped(f)
            if self._reset_session(ctx, f, f.vehicle_id):
                await ctx.send(f.user, text_message(f"Your drone (vehicle {f.vehicle_id[:8]}…) has been stopped and removed from the simulator to make room for others. Tell me the next job whenever you like."))
        if stop or stale:
            self.persist(ctx)
        self.prune_sessions(ctx, now)

    def _reset_session(self, ctx: Context, f: ActiveFlight, vehicle_id: str | None) -> bool:
        """Back to idle when the session still points at this flight; True when it did."""
        raw = ctx.storage.get(f"session:{f.user}")
        if raw is None:
            return False
        sess = self.load(ctx, f.user)
        if sess.order_id != f.order_id and (vehicle_id is None or sess.vehicle_id != vehicle_id):
            return False
        was_flying = vehicle_id is not None and sess.vehicle_id == vehicle_id
        sess.vehicle_id = None
        if sess.stage == "flying":
            sess.stage = "idle"
        self.save(ctx, f.user, sess)
        return was_flying

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
            ctx.logger.error(f"no candidates: the configurator at {self.s.render_url} is not answering")
            return [text_message("I could not reach the hangar: the configurator is not answering right now. Please ask again in a few minutes.")]
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
                    f"One swap fixes it: {swap.describe()}. Open it in the configurator to see the parts: {self.s.public_url}/?build={best.preset_id}. Approve below and I will fly the swapped build's hangar drone in the simulator.",
                    review_card("Proposed build", rows, approve_selection={"action": "confirm", "preset_id": best.preset_id}, reject_selection={"action": "cancel"}),
                )
            )
        else:
            sess.stage = "await_pick"
            msgs.append(text_message(f"No single battery, propeller or motor swap makes it pass. Pick a drone above to see its numbers, or change the request. The build is at {self.s.public_url}/?build={best.preset_id}."))
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
        t = time.time()
        wait_s = self.s.dispatch_cooldown_s - (t - sess.last_dispatch)
        if sess.last_dispatch and wait_s > 0:
            return [text_message(f"One flight at a time: please wait {wait_s:.0f} more seconds before dispatching again, then approve once more.")]
        self.restore(ctx)
        refused = self.active.refuse(sender)
        if refused:
            return [text_message(f"I cannot dispatch this one: {refused}. Approve again once that is done.")]
        order_id = uuid.uuid4().hex[:8]
        sess.order_id = order_id
        sess.vehicle_id = None
        sess.stage = "flying"
        sess.last_dispatch = t
        self.active.add(sender, order_id, t)
        self.persist(ctx)
        order = FlightOrder(order_id=order_id, preset_id=pid, mission_id=req.mission_id, mission_text=req.text, place=req.place, altitude_m=40.0, reply_to=ctx.agent.address)
        status = await ctx.send(self.flight, order)
        ctx.logger.info(f"order {order_id} → flight agent: {status.status}")
        note = f" (swapped {', '.join(f'{k} → {v}' for k, v in sess.swaps.items())}; the simulator flies the stored hangar build, the swap changes its battery model only once you re-pack it)" if sess.swaps else ""
        return [text_message(f"Dispatching {pid} to the simulator{note}. I will report as it packs, takes off and flies.")]

    async def end_flight(self, ctx: Context, sender: str, sess: Session) -> list[ChatMessage]:
        """The user is done: stop their vehicle now and free the slot."""
        self.restore(ctx)
        f = self.active.end(sender)
        if f is None:
            return [text_message("You have no drone in the simulator right now. Tell me a job and I will find one.")]
        self.persist(ctx)
        if not f.vehicle_id:
            return [text_message("Your drone is still being set up; I will stop it as soon as it is in the simulator.")]
        sess.vehicle_id = None  # the sweep then stops it without a second "stopped" message
        sess.stage = "idle"
        self.save(ctx, sender, sess)
        await self.sweep(ctx)
        still = self.active.by_user.get(sender)
        if still is not None and still.vehicle_id == f.vehicle_id:
            return [text_message("I asked the simulator to stop your drone; it did not answer yet, I will keep trying.")]
        return [text_message(f"Done: your drone (vehicle {f.vehicle_id[:8]}…) has been stopped. Tell me the next job whenever you like.")]

    async def on_text(self, ctx: Context, sender: str, text: str) -> list[ChatMessage]:
        sess = self.load(ctx, sender)
        lowered = text.strip().lower()
        try:
            if lowered in ("", "hi", "hello", "help", "start") or lowered.startswith("what can you"):
                return [text_message(GREETING)]
            if wants_to_end(text):
                return await self.end_flight(ctx, sender, sess)
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
                    return [text_message("Ready for the next mission. What is the job? (One drone per person: say 'end flight' to stop the one in the air before the next one flies.)")]
                if is_new_job(text):
                    # A whole new job sentence (distance and time), not a command for the drone in the air.
                    sess.stage = "idle"
                    return await self.start(ctx, sender, sess, text)
                if action == "watch":
                    text = "status"
                # Pass pilot commands to the vehicle in the air through the copilot while a flight is on, locked to
                # this user's own vehicle: a sentence that names another vehicle cannot steer it.
                if not sess.vehicle_id:
                    return [text_message("Your drone is not in the air yet; I will report as soon as it is.")]
                try:
                    r = await self.api.intent(text, sess.vehicle_id, lock=True)
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
        refused = d.admit(sender, text)
        if refused:
            ctx.logger.info(f"{sender[:12]}…: not processed ({refused[:60]})")
            await ctx.send(sender, text_message(refused))
            return
        if ended and not text:
            ctx.storage.remove(f"session:{sender}")
            d.restore(ctx)
            if d.active.end(sender) is not None:  # the conversation is over: so is its drone
                d.persist(ctx)
                await d.sweep(ctx)
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
        if sender != d.flight:  # only our flight agent may speak into a user's chat
            ctx.logger.warning(f"ignored progress from {sender[:12]}…")
            return
        d.restore(ctx)
        user = d.active.user_for(msg.order_id)
        if user:
            await ctx.send(user, text_message(msg.text))

    @flight.on_message(FlightResult)
    async def on_result(ctx: Context, sender: str, msg: FlightResult) -> None:
        if sender != d.flight:
            ctx.logger.warning(f"ignored a result from {sender[:12]}…")
            return
        d.restore(ctx)
        user = d.active.user_for(msg.order_id)
        if not user:
            if msg.vehicle_id:  # an order this dispatcher no longer tracks: do not leave its vehicle running
                try:
                    await d.api.stop(msg.vehicle_id)
                except Exception as e:
                    ctx.logger.warning(f"stopping untracked vehicle {msg.vehicle_id}: {e}")
            return
        f = d.active.on_result(msg.order_id, msg.ok, msg.vehicle_id)
        d.persist(ctx)
        sess = d.load(ctx, user)
        ending = f is not None and f.end_requested
        sess.stage = "flying" if msg.ok and not ending else "idle"
        sess.vehicle_id = msg.vehicle_id if msg.ok and not ending else None
        d.save(ctx, user, sess)
        if not msg.ok or ending:
            if not msg.ok:
                await ctx.send(user, text_message(f"The flight did not start: {msg.summary}"))
            await d.sweep(ctx)  # a vehicle that started but will not fly is stopped at once
            return
        telemetry = json.loads(msg.telemetry_json or "{}")
        rows = [("Vehicle", msg.vehicle_name or ""), ("Design", msg.design_id or ""), ("3D map", msg.map_url or ""), ("Copilot", msg.copilot_url or "")]
        if telemetry.get("status"):
            rows.append(("Telemetry", str(telemetry["status"])))
        card = detail_card("In the air", rows, [("Fly another mission", {"action": "new"}), ("Keep watching", {"action": "watch"})])
        ttl = f"{s.dispatch_ttl_min:g} minute{'s' if s.dispatch_ttl_min != 1 else ''}"
        await ctx.send(user, text_message(f"{msg.summary} Map: {msg.map_url}. Copilot: {msg.copilot_url}. While it flies you can tell me things like 'return to launch' or 'what's the battery'. It stays in the simulator for {ttl}, then I stop it to make room for others; say 'end flight' to stop it sooner.", card))

    @agent.on_interval(period=SWEEP_PERIOD_S)
    async def reap(ctx: Context) -> None:
        try:
            await d.sweep(ctx)
        except Exception:  # never let the reaper die
            ctx.logger.exception("sweep failed")

    agent.include(chat, publish_manifest=True)
    agent.include(flight, publish_manifest=False)
    if s.payments:

        def is_open(order_id: str) -> bool:
            f = next((f for f in d.active.by_user.values() if f.order_id == order_id), None)
            return f is not None and f.vehicle_id is None  # ordered, not yet flown

        agent.include(
            buyer_protocol(
                s.payments_ledger,
                agent.wallet,
                seller=d.flight,
                seller_wallet=flight_wallet_address(s),
                max_amount=fet_to_atestfet(s.flight_price_fet),
                is_open=is_open,
            ),
            publish_manifest=True,
        )
    return agent, d


def main() -> None:
    s = load_settings()
    exit_if_unsafe(s)
    api = RenderApi(s.render_url, token=s.agent_token)
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
