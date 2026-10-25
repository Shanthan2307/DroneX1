import json
from typing import Any

import httpx

from pathlib import Path

from dronex_agents.config import load_settings
from dronex_agents.flight import FlightRunner
from dronex_agents.protocol import FlightOrder
from dronex_agents.render_api import RenderApi


def sim(states: list[dict[str, Any]], calls: list[tuple[str, dict[str, Any]]], corridor: str | None = None) -> RenderApi:
    """A configurator whose vehicle walks through `states` (one per GET) and records every tool call, airspace
    request and mission record in `calls`. `corridor` is the airspace's answer: None (not running), granted, refused."""
    seq = iter(states)
    last: dict[str, Any] = states[0]

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal last
        path = request.url.path
        if path == "/api/sim/designs":
            return httpx.Response(200, json={"designs": [{"id": "s-1", "name": "Chimera 7", "basedOn": "chimera7-longrange", "createdAt": "2026-10-25T00:00:00Z", "profile": {}}]})
        if path.startswith("/api/sim/refly/"):
            return httpx.Response(200, json={"id": "s-1", "name": "Chimera 7", "vehicleId": "veh-1", "linkId": "l", "url": ""})
        if path == "/api/sim/vehicles/veh-1" and request.method == "GET":
            last = next(seq, last)
            place = request.url.params.get("place")
            return httpx.Response(200, json={**last, "place": {"name": place, "detail": "", "latitudeDeg": 37.80, "longitudeDeg": -122.41} if place else None})
        if path.startswith("/api/airspace"):
            if corridor is None:
                return httpx.Response(503, json={"error": "airspace not running"})
            body = json.loads(request.content or b"{}")
            calls.append((path, body))
            if path == "/api/airspace/corridor":
                ok = corridor == "granted"
                return httpx.Response(200 if ok else 409, json={"granted": ok, "corridor": {"id": 7, "status": corridor, "reason": "" if ok else "overlaps corridor #3 of another vehicle"}})
            return httpx.Response(200, json={"mission": body})
        if path == "/api/sim/vehicles/veh-1":
            body = json.loads(request.content)
            calls.append((body["tool"], body["args"]))
            return httpx.Response(200, json={"tool": body["tool"], "result": f"{body['tool']}: accepted"})
        return httpx.Response(404, json={"error": "nope"})

    return RenderApi("http://render.test", transport=httpx.MockTransport(handler))


def state(ready: bool, alt: float | None = None, armed: bool = False) -> dict[str, Any]:
    return {"ready": ready, "vehicle": {"armed": armed, "mode": "GUIDED"}, "telemetry": {"latitudeDeg": 37.8, "longitudeDeg": -122.4, "altitudeAboveHomeM": alt, "gpsSatellites": 10 if ready else 0, "ekfStatus": "Good" if ready else "Bad"}}


def order(place: str | None = "UCSF") -> FlightOrder:
    return FlightOrder(order_id="o1", preset_id="chimera7-longrange", mission_id="m", mission_text="deliver", altitude_m=40, place=place, reply_to="agent1x")


async def run(api: RenderApi, o: FlightOrder):
    said: list[str] = []

    async def progress(text: str) -> None:
        said.append(text)

    r = await FlightRunner(load_settings(env_file=Path("/nonexistent/.env.local")), api, poll_s=0).run(None, o, progress)
    return r, said


async def test_waits_for_prearm_then_takes_off_and_goes(monkeypatch):
    monkeypatch.setattr("dronex_agents.flight.asyncio.sleep", _no_sleep)
    calls: list[tuple[str, dict[str, Any]]] = []
    api = sim([state(False), state(False), state(True, 0), state(True, 25, True), state(True, 30, True)], calls)
    r, said = await run(api, order())
    assert r.ok, r.summary
    assert [c[0] for c in calls] == ["takeoff", "goto_place"]  # airspace off: no corridor, still flies
    assert calls[0][1]["altitude_m"] == 30 and calls[1][1] == {"place": "UCSF", "altitude_m": 40}
    assert any("GPS fix and EKF good" in s for s in said) and any("airborne" in s for s in said)


async def test_never_ready_reports_instead_of_arming(monkeypatch):
    monkeypatch.setattr("dronex_agents.flight.asyncio.sleep", _no_sleep)
    monkeypatch.setattr("dronex_agents.flight.READY_TIMEOUT_S", 0)
    calls: list[tuple[str, dict[str, Any]]] = []
    r, _ = await run(sim([state(False)], calls), order())
    assert not r.ok and "GPS fix" in r.summary and calls == []


async def test_retries_takeoff_when_it_does_not_climb(monkeypatch):
    monkeypatch.setattr("dronex_agents.flight.asyncio.sleep", _no_sleep)
    monkeypatch.setattr("dronex_agents.flight.CLIMB_TIMEOUT_S", 0)
    calls: list[tuple[str, dict[str, Any]]] = []
    r, _ = await run(sim([state(True, 0)], calls), order(None))
    assert not r.ok and [c[0] for c in calls] == ["takeoff"] * 3


async def test_corridor_granted_then_goes_and_records_the_mission(monkeypatch):
    monkeypatch.setattr("dronex_agents.flight.asyncio.sleep", _no_sleep)
    calls: list[tuple[str, dict[str, Any]]] = []
    r, said = await run(sim([state(True, 0), state(True, 30, True)], calls, corridor="granted"), order())
    assert r.ok and "toward UCSF" in r.summary
    kinds = [c[0] for c in calls]
    assert kinds == ["/api/airspace/mission", "takeoff", "/api/airspace/corridor", "goto_place", "/api/airspace/mission"]
    req = calls[2][1]
    assert req["from"] == {"lat": 37.8, "lon": -122.4} and req["to"] == {"lat": 37.80, "lon": -122.41} and req["minAltM"] == 30 and req["maxAltM"] == 50
    assert [c[1]["status"] for c in calls if c[0] == "/api/airspace/mission"] == ["accepted", "flying"]
    assert any("reserved" in s for s in said)


async def test_corridor_refused_holds_instead_of_going(monkeypatch):
    monkeypatch.setattr("dronex_agents.flight.asyncio.sleep", _no_sleep)
    calls: list[tuple[str, dict[str, Any]]] = []
    r, said = await run(sim([state(True, 0), state(True, 30, True)], calls, corridor="refused"), order())
    assert r.ok and "toward" not in r.summary and "not going to UCSF" in r.summary
    assert "goto_place" not in [c[0] for c in calls]
    assert any("overlaps corridor #3" in s for s in said)


async def _no_sleep(_s: float) -> None:
    return None
