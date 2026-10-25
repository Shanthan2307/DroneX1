"""The public-launch limits (docs/DEPLOY.md items 22-27, 38): who may order flights, how many, for how long, how
often a stranger may write, what the model may cost, and which configurator calls carry the agent token."""

import json
import logging
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from uagents_core.contrib.protocols.payment import CommitPayment, Funds, RequestPayment

from dronex_agents.addresses import address_of, dispatcher_address, flight_address, flight_wallet_address, wallet_address_of
from dronex_agents.config import DEFAULT_SEEDS, exit_if_unsafe, load_settings, unsafe_seeds
from dronex_agents.dispatcher import Dispatcher, Session
from dronex_agents.flight import FlightRunner, OrderGate
from dronex_agents.limits import ActiveFlights, ModelBudget, RateLimiter, prune_index
from dronex_agents.mission import parse_request, parse_request_rules
from dronex_agents.payment import CURRENCY, check_commit, check_request, fet_to_atestfet
from dronex_agents.protocol import FlightOrder
from dronex_agents.render_api import AGENT_HEADER, RenderApi, RenderApiError, SimulatorFull
from dronex_agents.run import log_to_stdout

ENV_KEYS = [
    "DRONEX_RENDER_URL", "DRONEX_PUBLIC_URL", "DRONEX_AGENT_TOKEN", "DRONEX_MAILBOX", "DRONEX_FLEET_MAILBOX", "DRONEX_FLIGHT_MAILBOX",
    "DRONEX_DISPATCHER_SEED", "DRONEX_FLEET_SEED", "DRONEX_FLIGHT_SEED", "DRONEX_PAYMENTS", "DRONEX_DISPATCH_MAX_ACTIVE",
    "DRONEX_DISPATCH_TTL_MIN", "DRONEX_DISPATCH_DAILY_MODEL_CALLS", "DRONEX_DISPATCH_COOLDOWN_S", "DRONEX_DISPATCH_MAX_INPUT_CHARS",
]


_MP: list[pytest.MonkeyPatch] = []


def _clear(mp: pytest.MonkeyPatch) -> None:
    # load_dotenv writes into os.environ; setenv first so monkeypatch restores the original state afterwards.
    for k in ENV_KEYS:
        mp.setenv(k, "")
        mp.delenv(k)


@pytest.fixture
def clean_env(monkeypatch):
    _clear(monkeypatch)
    _MP.append(monkeypatch)
    yield monkeypatch
    _MP.remove(monkeypatch)


def settings(tmp_path: Path, text: str = ""):
    """Settings from exactly `text` (each call starts from a clean environment)."""
    _clear(_MP[-1])
    env = tmp_path / ".env.local"
    env.write_text(text)
    return load_settings(env_file=env)


# -- settings: URLs, token, seeds (items 23, 25, 26) ---------------------------------------------------------------
def test_defaults_split_api_and_public_urls(clean_env, tmp_path):
    s = settings(tmp_path)
    assert s.render_url == "http://127.0.0.1:3000" and s.public_url == s.render_url
    assert not s.payments and not s.payments_ledger  # payments stay off unless asked for
    assert (s.dispatch_max_active, s.dispatch_ttl_min, s.dispatch_daily_model_calls) == (3, 10.0, 500)
    assert (s.dispatch_rate_per_min, s.dispatch_rate_per_day) == (10, 100)
    s2 = settings(tmp_path, "DRONEX_RENDER_URL=http://127.0.0.1:3000\nDRONEX_PUBLIC_URL=https://dronex.example/\nDRONEX_AGENT_TOKEN=tok-123\nDRONEX_DISPATCH_MAX_ACTIVE=5\nDRONEX_DISPATCH_TTL_MIN=2.5\n")
    assert s2.public_url == "https://dronex.example" and s2.render_url == "http://127.0.0.1:3000"
    assert s2.agent_token == "tok-123" and "tok-123" not in repr(s2)
    assert s2.dispatch_max_active == 5 and s2.dispatch_ttl_min == 2.5


def test_refuses_public_seeds_only_with_a_mailbox(clean_env, tmp_path):
    on = settings(tmp_path)  # DRONEX_MAILBOX defaults to on
    why = unsafe_seeds(on)
    assert why and "DRONEX_DISPATCHER_SEED" in why and "DRONEX_MAILBOX=0" in why
    with pytest.raises(SystemExit):
        exit_if_unsafe(on)
    off = settings(tmp_path, "DRONEX_MAILBOX=0\n")
    assert unsafe_seeds(off) is None
    exit_if_unsafe(off)  # local development keeps working
    one_left = settings(tmp_path, "DRONEX_DISPATCHER_SEED=a-long-random-seed\nDRONEX_FLEET_SEED=another\n")
    assert unsafe_seeds(one_left) is not None and "DRONEX_FLIGHT_SEED" in unsafe_seeds(one_left) and "DRONEX_FLEET_SEED" not in unsafe_seeds(one_left)
    explicit_default = settings(tmp_path, f"DRONEX_DISPATCHER_SEED=x1\nDRONEX_FLEET_SEED=x2\nDRONEX_FLIGHT_SEED={DEFAULT_SEEDS['flight']}\n")
    assert unsafe_seeds(explicit_default) is not None
    rotated = settings(tmp_path, "DRONEX_DISPATCHER_SEED=x1\nDRONEX_FLEET_SEED=x2\nDRONEX_FLIGHT_SEED=x3\n")
    assert unsafe_seeds(rotated) is None


def test_log_to_stdout_flag(monkeypatch):
    monkeypatch.delenv("DRONEX_LOG_STDOUT", raising=False)
    assert not log_to_stdout()
    monkeypatch.setenv("DRONEX_LOG_STDOUT", "1")
    assert log_to_stdout()


# -- the configurator client: token, stop, lockVehicle, 503 (items 22, 23, 24) -------------------------------------
def recording_api(seen: list[httpx.Request], refly_status: int = 200, token: str = "tok-abc") -> RenderApi:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        path = request.url.path
        if path.startswith("/api/sim/refly/"):
            if refly_status == 503:
                return httpx.Response(503, json={"error": "simulator full, try again in a few minutes"})
            return httpx.Response(200, json={"id": "s-1", "name": "x", "vehicleId": "veh-1"})
        if path.startswith("/api/sim/stop/"):
            return httpx.Response(200, json={"ok": True})
        if path == "/api/copilot/intent":
            body = json.loads(request.content)
            return httpx.Response(200, json={"reply": "ok", "actions": [], "vehicleId": body.get("lockVehicle")})
        if path == "/api/sim/designs":
            return httpx.Response(200, json={"designs": [{"id": "s-1", "name": "Chimera 7", "basedOn": "chimera7-longrange", "createdAt": "", "profile": {}}]})
        if path.startswith("/api/airspace"):
            return httpx.Response(503, json={"error": "off"})
        return httpx.Response(200, json={"presets": [], "missions": []})

    return RenderApi("http://render.test", transport=httpx.MockTransport(handler), token=token)


async def test_every_configurator_call_carries_the_agent_token():
    seen: list[httpx.Request] = []
    api = recording_api(seen)
    await api.catalog()
    await api.designs()
    await api.refly("s-1")
    await api.stop("veh-1")
    await api.intent("status", "veh-1", lock=True)
    await api.airspace()
    await api.record_mission(vehicle_id="veh-1", mission_id="m", agent="a", status="flying")
    assert len(seen) == 7 and all(r.headers.get(AGENT_HEADER) == "tok-abc" for r in seen)
    assert [r for r in seen if r.url.path == "/api/sim/stop/veh-1" and r.method == "POST"]
    no_token: list[httpx.Request] = []
    await recording_api(no_token, token="").catalog()
    assert AGENT_HEADER not in no_token[0].headers


async def test_intent_is_locked_to_the_users_vehicle():
    seen: list[httpx.Request] = []
    api = recording_api(seen)
    await api.intent("fly vehicle veh-OTHER to UCSF", "veh-1", lock=True)
    body = json.loads(seen[0].content)
    assert body["lockVehicle"] == "veh-1" and body["vehicleId"] == "veh-1"
    with pytest.raises(RenderApiError):
        await api.intent("status", None, lock=True)


async def test_simulator_full_is_one_polite_answer_without_retries():
    seen: list[httpx.Request] = []
    api = recording_api(seen, refly_status=503)
    with pytest.raises(SimulatorFull):
        await api.refly("s-1")
    seen.clear()

    async def progress(_t: str) -> None:
        return None

    s = load_settings(env_file=Path("/nonexistent/.env.local"))
    o = FlightOrder(order_id="o1", preset_id="chimera7-longrange", mission_id="m", mission_text="x", reply_to="agent1x")
    r = await FlightRunner(s, api, poll_s=0).run(None, o, progress)
    assert not r.ok and "full" in r.summary and "try again in a few minutes" in r.summary
    assert sum(1 for q in seen if q.url.path.startswith("/api/sim/refly/")) == 1


# -- the flight agent accepts orders from the dispatcher only (item 22) ---------------------------------------------
def test_order_gate():
    disp = address_of("test dispatcher seed")
    gate = OrderGate(disp, max_running=2)
    o = lambda oid, reply="agent1qattacker": FlightOrder(order_id=oid, preset_id="p", mission_id="m", mission_text="x", reply_to=reply)
    assert "dispatcher only" in gate.refuse(address_of("someone else"), o("a"))
    assert gate.refuse(disp, o("a")) is None  # a forged reply_to is ignored (replies go to the dispatcher), not fatal
    gate.running.add("a")
    assert "already" in gate.refuse(disp, o("a"))
    gate.hold(o("b"))
    assert "busy" in gate.refuse(disp, o("c"))
    gate._pending_at["b"] -= OrderGate.PENDING_TTL_S + 1  # an unpaid quote expires
    assert gate.refuse(disp, o("c")) is None and "b" not in gate.pending


# -- rate limits, model budget, sessions (item 27) -----------------------------------------------------------------
def test_rate_limiter_per_minute_and_per_day():
    r = RateLimiter(per_min=10, per_day=100)
    t = 1_000_000.0
    assert all(r.check("u", t + i) is None for i in range(10))
    assert "a minute" in r.check("u", t + 10)
    assert r.check("other", t + 10) is None  # per sender
    assert r.check("u", t + 61) is None  # the minute has passed
    day = RateLimiter(per_min=1000, per_day=100)
    assert all(day.check("u", t + i) is None for i in range(100))
    assert "daily limit" in day.check("u", t + 200)
    assert day.check("u", t + 86400 + 1) is None
    day.prune(t + 3 * 86400)
    assert "u" not in day._hits


async def test_model_budget_caps_calls_per_day_then_rules_answer():
    calls: list[str] = []

    async def model(system: str, user: str) -> str:
        calls.append(user)
        return '{"kind": "survey", "distance_km": 3, "time_min": 9}'

    today = [datetime(2026, 10, 25, 12, tzinfo=timezone.utc)]
    budget = ModelBudget(2, clock=lambda: today[0])
    wrapped = budget.wrap(model)
    text = "Fly a 10 km ridge run to Twin Peaks within 15 minutes"
    assert (await parse_request(text, wrapped)).distance_km == 3
    await parse_request(text, wrapped)
    third = await parse_request(text, wrapped)
    assert len(calls) == 2 and third.distance_km == parse_request_rules(text).distance_km == 10
    today[0] = datetime(2026, 10, 26, 0, 1, tzinfo=timezone.utc)
    await parse_request(text, wrapped)
    assert len(calls) == 3
    assert ModelBudget(5).wrap(None) is None


def test_prune_index():
    idx = {"old": 0.0, "new": 100_000.0}
    assert prune_index(idx, 86400.0, now=100_001.0) == ["old"] and idx == {"new": 100_000.0}


# -- active vehicles: one per user, N in total, stopped after the TTL (items 22, 39) ---------------------------------
def test_active_flights_admission_ttl_and_storage():
    a = ActiveFlights(max_active=2, ttl_s=600)
    assert a.refuse("u1") is None
    a.add("u1", "o1", now=0)
    assert "still being set up" in a.refuse("u1")
    a.add("u2", "o2", now=0)
    assert "busy" in a.refuse("u3")
    f = a.on_result("o1", ok=True, vehicle_id="veh-1", now=10)
    assert f.stop_at == 610 and "already have a drone" in a.refuse("u1")
    assert a.due(now=600) == ([], [])
    stop, _ = a.due(now=611)
    assert [x.vehicle_id for x in stop] == ["veh-1"]
    a.stopped(stop[0])
    assert a.refuse("u1") is None and "u1" not in a.by_user
    # a failed start with a vehicle is stopped at once; without one the slot frees right away
    a.add("u1", "o3", now=20)
    assert a.on_result("o3", ok=False, vehicle_id="veh-3", now=30).stop_at == 30
    a.on_result("o2", ok=False, vehicle_id=None, now=30)
    assert "u2" not in a.by_user
    # restart: the registry comes back from storage
    b = ActiveFlights(max_active=2, ttl_s=600)
    b.load_json(json.loads(json.dumps(a.to_json())))
    assert b.by_user["u1"].vehicle_id == "veh-3"
    # an order that never gets a result frees its slot after the timeout
    b.add("u4", "o4", now=0)
    _, stale = b.due(now=b.pending_timeout_s + 1)
    assert [x.order_id for x in stale] == ["o4"] and "u4" not in b.by_user
    # ending before the result: stopped as soon as the vehicle exists
    b.add("u5", "o5", now=0)
    b.end("u5")
    assert b.on_result("o5", ok=True, vehicle_id="veh-5", now=50).stop_at == 50
    # the stop route keeps failing: retried, then given up so the slot is not held forever
    f5 = b.by_user["u5"]
    assert all(b.stop_failed(f5, now=60) for _ in range(b.max_stop_attempts - 1))
    assert not b.stop_failed(f5, now=60) and "u5" not in b.by_user


# -- the dispatcher end to end over a fake context --------------------------------------------------------------------
class Storage:
    def __init__(self):
        self.d: dict[str, Any] = {}

    def get(self, k):
        return self.d.get(k)

    def set(self, k, v):
        self.d[k] = v

    def remove(self, k):
        self.d.pop(k, None)


class Ctx:
    def __init__(self, address: str):
        self.storage = Storage()
        self.logger = logging.getLogger("test")
        self.agent = SimpleNamespace(address=address)
        self.sent: list[tuple[str, Any]] = []

    async def send(self, to: str, msg: Any):
        self.sent.append((to, msg))
        return SimpleNamespace(status="delivered")


def texts(msgs) -> str:
    return " ".join(c.text for m in msgs for c in m.content if getattr(c, "type", "") == "text")


@pytest.fixture
def dispatcher_and_calls(clean_env, tmp_path):
    s = replace(settings(tmp_path, "DRONEX_MAILBOX=0\n"), dispatch_max_active=1, dispatch_cooldown_s=60, dispatch_max_input_chars=200, dispatch_ttl_min=10)
    seen: list[httpx.Request] = []
    d = Dispatcher(s, recording_api(seen), None)
    return d, seen


def ready_for_review(d: Dispatcher, ctx: Ctx, user: str) -> Session:
    sess = d.load(ctx, user)
    sess.request = parse_request_rules("Fly a 10 km ridge run to Twin Peaks within 15 minutes")
    sess.chosen = "chimera7-longrange"
    sess.stage = "await_review"
    d.save(ctx, user, sess)
    return sess


async def test_dispatcher_admit_rate_and_length(dispatcher_and_calls):
    d, _ = dispatcher_and_calls
    assert d.admit("u", "x" * 201, now=0) and "too long" in d.admit("u", "x" * 201, now=0)
    assert d.admit("v", "hello", now=0) is None
    for i in range(9):
        d.admit("w", "hi", now=10 + i)
    assert d.admit("w", "hi", now=19) is None and "a minute" in d.admit("w", "hi", now=20)


async def test_dispatcher_one_vehicle_per_user_cooldown_and_global_cap(dispatcher_and_calls):
    d, _ = dispatcher_and_calls
    ctx = Ctx(dispatcher_address(d.s))
    approve = json.dumps({"action": "confirm"})
    ready_for_review(d, ctx, "alice")
    out = await d.on_text(ctx, "alice", approve)
    assert "Dispatching" in texts(out)
    order = next(m for to, m in ctx.sent if to == d.flight)
    assert order.reply_to == ctx.agent.address and d.active.user_for(order.order_id) == "alice"
    # the same user again, at once: cooldown
    ready_for_review(d, ctx, "alice")
    assert "wait" in texts(await d.on_text(ctx, "alice", approve))
    # another user while the only slot is taken: the global cap
    ready_for_review(d, ctx, "bob")
    assert "busy" in texts(await d.on_text(ctx, "bob", approve))
    assert len([1 for to, _ in ctx.sent if to == d.flight]) == 1
    # alice past the cooldown, with her order still open: one vehicle per user
    sess = ready_for_review(d, ctx, "alice")
    sess.last_dispatch -= 120
    d.save(ctx, "alice", sess)
    assert "still being set up" in texts(await d.on_text(ctx, "alice", approve))
    assert json.loads(ctx.storage.get("active_flights"))[0]["user"] == "alice"  # persisted for a restart


async def test_dispatcher_stops_the_vehicle_after_the_ttl_and_locks_commands(dispatcher_and_calls):
    d, seen = dispatcher_and_calls
    ctx = Ctx(dispatcher_address(d.s))
    ready_for_review(d, ctx, "alice")
    await d.on_text(ctx, "alice", json.dumps({"action": "confirm"}))
    order_id = d.load(ctx, "alice").order_id
    f = d.active.on_result(order_id, ok=True, vehicle_id="veh-1", now=1000)
    sess = d.load(ctx, "alice")
    sess.vehicle_id, sess.stage = "veh-1", "flying"
    d.save(ctx, "alice", sess)
    # a pilot command goes to her vehicle only
    await d.on_text(ctx, "alice", "what's the battery")
    intent = next(r for r in seen if r.url.path == "/api/copilot/intent")
    assert json.loads(intent.content)["lockVehicle"] == "veh-1"
    # before the TTL nothing is stopped; after it the stop route runs and she is told
    await d.sweep(ctx, now=1000 + 599)
    assert not [r for r in seen if r.url.path.startswith("/api/sim/stop/")]
    await d.sweep(ctx, now=f.stop_at + 1)
    assert [r.url.path for r in seen if r.url.path.startswith("/api/sim/stop/")] == ["/api/sim/stop/veh-1"]
    assert "alice" not in d.active.by_user and d.load(ctx, "alice").stage == "idle"
    assert any(to == "alice" and "stopped" in texts([m]) for to, m in ctx.sent)


async def test_dispatcher_end_flight_stops_at_once(dispatcher_and_calls):
    d, seen = dispatcher_and_calls
    ctx = Ctx(dispatcher_address(d.s))
    ready_for_review(d, ctx, "alice")
    await d.on_text(ctx, "alice", json.dumps({"action": "confirm"}))
    d.active.on_result(d.load(ctx, "alice").order_id, ok=True, vehicle_id="veh-9")
    out = await d.on_text(ctx, "alice", "end flight")
    assert "stopped" in texts(out) and "/api/sim/stop/veh-9" in [r.url.path for r in seen]
    assert d.active.refuse("alice") is None


async def test_dispatcher_prunes_sessions_older_than_a_day(dispatcher_and_calls):
    d, _ = dispatcher_and_calls
    ctx = Ctx(dispatcher_address(d.s))
    d.save(ctx, "old", Session())
    d.save(ctx, "new", Session())
    index = json.loads(ctx.storage.get("session_index"))
    index["old"] -= 2 * 86400
    ctx.storage.set("session_index", json.dumps(index))
    assert d.prune_sessions(ctx, now=index["new"] + 10) == ["old"]
    assert ctx.storage.get("session:old") is None and ctx.storage.get("session:new") is not None


# -- payments (item 26) ---------------------------------------------------------------------------------------------
def test_payment_checks_buyer_and_seller(clean_env, tmp_path):
    s = settings(tmp_path, "DRONEX_MAILBOX=0\n")
    disp, flight, wallet = dispatcher_address(s), flight_address(s), flight_wallet_address(s)
    assert wallet.startswith("fetch1") and wallet == wallet_address_of(s.flight_seed)
    price = fet_to_atestfet("0.5")
    req = lambda amount=price, recipient=wallet, ref="o1", cur=CURRENCY: RequestPayment(accepted_funds=[Funds(amount=str(amount), currency=cur, payment_method="fetch-ledger")], recipient=recipient, deadline_seconds=120, reference=ref)
    ok = dict(seller=flight, seller_wallet=wallet, max_amount=price, is_open=lambda r: r == "o1")
    funds, why = check_request(flight, req(), **ok)
    assert funds is not None and why is None
    assert "not the flight agent" in check_request(disp, req(), **ok)[1]
    assert "wallet" in check_request(flight, req(recipient="fetch1someoneelse"), **ok)[1]
    assert "outside" in check_request(flight, req(amount=price * 10), **ok)[1]
    assert "no open order" in check_request(flight, req(ref="o2"), **ok)[1]
    assert "no price" in check_request(flight, req(cur="afet"), **ok)[1]
    commit = lambda amount=price, recipient=wallet: CommitPayment(funds=Funds(amount=str(amount), currency=CURRENCY, payment_method="fetch-ledger"), recipient=recipient, transaction_id="", reference="o1")
    assert check_commit(disp, commit(), buyer=disp, recipient=wallet, min_amount=price) is None
    assert "not the dispatcher" in check_commit(address_of("x"), commit(), buyer=disp, recipient=wallet, min_amount=price)
    assert "below the price" in check_commit(disp, commit(amount=1), buyer=disp, recipient=wallet, min_amount=price)
    assert "recipient" in check_commit(disp, commit(recipient="fetch1other"), buyer=disp, recipient=wallet, min_amount=price)
