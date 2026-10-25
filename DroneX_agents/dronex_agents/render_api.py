"""A typed client for the configurator's JSON routes (DroneX_render/src/app/api).

GET  /api/catalog               every hangar drone judged: summary, readiness, mission matrix, sim profile
POST /api/verdict               a build (or preset + swaps) judged the same way
GET  /api/sim/designs           designs already packed and sent to the simulator (what the flight agent can fly)
POST /api/sim/refly/<id>        start a stored design as a new simulated vehicle
GET  /api/sim/vehicles/<id>      a vehicle's state and telemetry, with `ready` (GPS fix, EKF good)
POST /api/sim/vehicles/<id>      one copilot tool run directly (takeoff, goto_place, return_to_launch...), no model
POST /api/copilot/intent        a sentence → a Core RPC tool call → receipt (take off, go to, mode, status...)
GET  /api/airspace              the shared airspace (SpacetimeDB track); optional, degrades when absent
POST /api/airspace/corridor     a corridor from the airspace's reducer: granted, or refused (409) with the reason
POST /api/airspace/mission      record which agent gave which vehicle which mission, and its status

Every number returned is the configurator's own: a dataset field or dronePhysics.js over dataset fields.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx


class RenderApiError(RuntimeError):
    pass


@dataclass
class Summary:
    auw_g: float | None
    thrust_per_motor_g: float | None
    hover_twr: float | None
    hover_power_w: float | None
    hover_time_min: float | None
    max_current_a: float | None
    feasible: bool

    @staticmethod
    def parse(d: dict[str, Any]) -> "Summary":
        return Summary(
            auw_g=d.get("auw_g"),
            thrust_per_motor_g=d.get("thrustPerMotor_g"),
            hover_twr=d.get("hoverTWR"),
            hover_power_w=d.get("hoverPower_W"),
            hover_time_min=d.get("hoverTime_min"),
            max_current_a=d.get("maxCurrent_A"),
            feasible=bool(d.get("feasible")),
        )


@dataclass
class Check:
    key: str
    label: str
    status: str  # pass | fail | not-judged
    have: str
    want: str
    reason: str

    @staticmethod
    def parse(d: dict[str, Any]) -> "Check":
        return Check(key=str(d.get("key", "")), label=str(d.get("label", d.get("key", ""))), status=str(d.get("status", "")), have=str(d.get("have", "")), want=str(d.get("want", "")), reason=str(d.get("reason", "")))


@dataclass
class MissionRow:
    mission_id: str
    mission_name: str
    ready: bool
    failing: int
    not_judged: int
    checks: list[Check]
    summary: Summary
    target_distance_km: float | None
    target_endurance_min: float | None
    max_weight_g: float | None

    @staticmethod
    def parse(d: dict[str, Any]) -> "MissionRow":
        m = d.get("mission", {})
        return MissionRow(
            mission_id=str(m.get("id", "")),
            mission_name=str(m.get("name", m.get("id", ""))),
            ready=bool(d.get("ready")),
            failing=int(d.get("failing", 0)),
            not_judged=int(d.get("notJudged", 0)),
            checks=[Check.parse(c) for c in d.get("checks", [])],
            summary=Summary.parse(d.get("summary", {})),
            target_distance_km=m.get("targetDistance_km"),
            target_endurance_min=m.get("targetEndurance_min"),
            max_weight_g=m.get("maxAllowableWeight_g"),
        )

    def failing_checks(self) -> list[Check]:
        return [c for c in self.checks if c.status == "fail"]


@dataclass
class Readiness:
    ready: bool
    title: str
    lines: list[dict[str, Any]]

    @staticmethod
    def parse(d: dict[str, Any]) -> "Readiness":
        return Readiness(ready=bool(d.get("ready")), title=str(d.get("title", "")), lines=list(d.get("lines", [])))


@dataclass
class Preset:
    id: str
    name: str
    note: str
    build: dict[str, Any]
    sim: dict[str, Any]
    summary: Summary
    readiness: Readiness
    missions: list[MissionRow]
    warnings: list[str] = field(default_factory=list)

    @staticmethod
    def parse(d: dict[str, Any]) -> "Preset":
        return Preset(
            id=str(d["id"]),
            name=str(d.get("name", d["id"])),
            note=str(d.get("note") or ""),
            build=dict(d.get("build", {})),
            sim=dict(d.get("sim", {})),
            summary=Summary.parse(d.get("summary", {})),
            readiness=Readiness.parse(d.get("readiness", {})),
            missions=[MissionRow.parse(m) for m in d.get("missions", [])],
            warnings=[str(w) for w in d.get("warnings", [])],
        )

    def mission(self, mission_id: str) -> MissionRow | None:
        return next((m for m in self.missions if m.mission_id == mission_id), None)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "note": self.note,
            "build": self.build,
            "sim": self.sim,
            "summary": self.summary.__dict__,
            "readiness": {"ready": self.readiness.ready, "title": self.readiness.title, "lines": self.readiness.lines},
            "missions": [
                {
                    "mission": {"id": m.mission_id, "name": m.mission_name, "targetDistance_km": m.target_distance_km, "targetEndurance_min": m.target_endurance_min, "maxAllowableWeight_g": m.max_weight_g},
                    "ready": m.ready,
                    "failing": m.failing,
                    "notJudged": m.not_judged,
                    "checks": [c.__dict__ for c in m.checks],
                    "summary": {"auw_g": m.summary.auw_g, "thrustPerMotor_g": m.summary.thrust_per_motor_g, "hoverTWR": m.summary.hover_twr, "hoverPower_W": m.summary.hover_power_w, "hoverTime_min": m.summary.hover_time_min, "maxCurrent_A": m.summary.max_current_a, "feasible": m.summary.feasible},
                }
                for m in self.missions
            ],
            "warnings": self.warnings,
        }


@dataclass
class Verdict:
    build: dict[str, Any]
    summary: Summary
    readiness: Readiness
    missions: list[MissionRow]
    warnings: list[str]

    @staticmethod
    def parse(d: dict[str, Any]) -> "Verdict":
        return Verdict(
            build=dict(d.get("build", {})),
            summary=Summary.parse(d.get("summary", {})),
            readiness=Readiness.parse(d.get("readiness", {})),
            missions=[MissionRow.parse(m) for m in d.get("missions", [])],
            warnings=[str(w) for w in d.get("warnings", [])],
        )

    def mission(self, mission_id: str) -> MissionRow | None:
        return next((m for m in self.missions if m.mission_id == mission_id), None)


@dataclass
class Mission:
    id: str
    name: str
    description: str
    target_distance_km: float | None
    target_endurance_min: float | None
    max_weight_g: float | None

    @staticmethod
    def parse(d: dict[str, Any]) -> "Mission":
        return Mission(id=str(d["id"]), name=str(d.get("name", d["id"])), description=str(d.get("description", "")), target_distance_km=d.get("targetDistance_km"), target_endurance_min=d.get("targetEndurance_min"), max_weight_g=d.get("maxAllowableWeight_g"))


@dataclass
class Catalog:
    presets: list[Preset]
    missions: list[Mission]

    def preset(self, preset_id: str) -> Preset | None:
        return next((p for p in self.presets if p.id == preset_id), None)


@dataclass
class StoredDesign:
    id: str
    name: str
    based_on: str | None
    created_at: str
    vehicle: str
    frame: str
    span_m: float | None


@dataclass
class FlyResult:
    design_id: str
    name: str
    vehicle_id: str
    link_id: str
    url: str


@dataclass
class IntentResult:
    reply: str
    actions: list[dict[str, Any]]
    vehicle_id: str | None


@dataclass
class VehicleState:
    ready: bool
    vehicle: dict[str, Any]
    telemetry: dict[str, Any]
    place: dict[str, Any] | None = None

    @property
    def armed(self) -> bool:
        return bool(self.vehicle.get("armed"))

    @property
    def altitude_m(self) -> float | None:
        a = self.telemetry.get("altitudeAboveHomeM")
        return float(a) if isinstance(a, (int, float)) else None


class RenderApi:
    """Async client. Pass `transport` in tests (httpx.MockTransport) so nothing touches the network."""

    def __init__(self, base_url: str, timeout: float = 30.0, transport: httpx.AsyncBaseTransport | None = None):
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=timeout, transport=transport)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _json(self, method: str, path: str, **kw: Any) -> Any:
        try:
            r = await self._client.request(method, path, **kw)
        except httpx.HTTPError as e:
            raise RenderApiError(f"the configurator at {self.base_url} is not reachable ({e.__class__.__name__}); start it with ./dev.sh") from e
        if r.status_code == 404:
            raise RenderApiError(f"{method} {path}: not found (404)")
        try:
            body = r.json()
        except ValueError as e:
            raise RenderApiError(f"{method} {path}: not JSON (HTTP {r.status_code})") from e
        if r.status_code >= 400:
            raise RenderApiError(f"{method} {path}: HTTP {r.status_code}: {body.get('error', body) if isinstance(body, dict) else body}")
        return body

    async def catalog(self) -> Catalog:
        d = await self._json("GET", "/api/catalog")
        return Catalog(presets=[Preset.parse(p) for p in d.get("presets", [])], missions=[Mission.parse(m) for m in d.get("missions", [])])

    async def verdict(self, *, preset_id: str | None = None, swaps: dict[str, Any] | None = None, build: dict[str, Any] | None = None, mission_id: str | None = None) -> Verdict:
        body: dict[str, Any] = {}
        if build is not None:
            body["build"] = build
        else:
            body["presetId"] = preset_id
            if swaps:
                body["swaps"] = swaps
        if mission_id is not None:
            body["missionId"] = mission_id
        return Verdict.parse(await self._json("POST", "/api/verdict", json=body))

    async def designs(self) -> list[StoredDesign]:
        d = await self._json("GET", "/api/sim/designs")
        out = []
        for x in d.get("designs", []):
            p = x.get("profile", {})
            out.append(StoredDesign(id=str(x["id"]), name=str(x.get("name", x["id"])), based_on=x.get("basedOn"), created_at=str(x.get("createdAt", "")), vehicle=str(p.get("vehicle", "")), frame=str(p.get("frame", "")), span_m=p.get("span_m")))
        return out

    async def refly(self, design_id: str) -> FlyResult:
        d = await self._json("POST", f"/api/sim/refly/{design_id}", timeout=120.0)
        return FlyResult(design_id=str(d.get("id", design_id)), name=str(d.get("name", "")), vehicle_id=str(d["vehicleId"]), link_id=str(d.get("linkId", "")), url=str(d.get("url", "")))

    async def intent(self, text: str, vehicle_id: str | None = None) -> IntentResult:
        d = await self._json("POST", "/api/copilot/intent", json={"text": text, "vehicleId": vehicle_id}, timeout=90.0)
        return IntentResult(reply=str(d.get("reply", "")), actions=list(d.get("actions", [])), vehicle_id=d.get("vehicleId"))

    async def vehicle(self, vehicle_id: str, place: str | None = None) -> VehicleState:
        """The vehicle's state; with `place`, that place located near the vehicle as well (None when not found)."""
        d = await self._json("GET", f"/api/sim/vehicles/{vehicle_id}", params={"place": place} if place else None)
        return VehicleState(ready=bool(d.get("ready")), vehicle=dict(d.get("vehicle") or {}), telemetry=dict(d.get("telemetry") or {}), place=d.get("place"))

    async def tool(self, vehicle_id: str, tool: str, **args: Any) -> str:
        """One copilot tool on that vehicle, no model in between; returns the engine's receipt as text."""
        d = await self._json("POST", f"/api/sim/vehicles/{vehicle_id}", json={"tool": tool, "args": args}, timeout=60.0)
        return str(d.get("result", ""))

    async def _airspace(self, method: str, path: str, **kw: Any) -> tuple[int, dict[str, Any]] | None:
        """A call to the shared airspace routes: (status, body), or None when the SpacetimeDB track is not running
        (route missing, 503 from the route, or the configurator unreachable). Refusals (409) come back as data."""
        try:
            r = await self._client.request(method, path, **kw)
            body = r.json()
        except (httpx.HTTPError, ValueError):
            return None
        if r.status_code in (404, 503) or not isinstance(body, dict):
            return None
        return r.status_code, body

    async def airspace(self) -> dict[str, Any] | None:
        """The shared airspace snapshot, or None when the SpacetimeDB track is not running."""
        r = await self._airspace("GET", "/api/airspace")
        return r[1] if r and r[0] < 400 else None

    async def request_corridor(self, body: dict[str, Any]) -> dict[str, Any] | None:
        """{granted, corridor{status, reason, id...}} from the airspace's reducer, or None when it is not running."""
        r = await self._airspace("POST", "/api/airspace/corridor", json=body)
        if r is None:
            return None
        status, d = r
        if status >= 400 and "corridor" not in d:
            raise RenderApiError(f"POST /api/airspace/corridor: HTTP {status}: {d.get('error', d)}")
        return d

    async def record_mission(self, *, vehicle_id: str, mission_id: str, agent: str, status: str) -> bool:
        """Best effort: who gave which vehicle which mission, and where it stands, in the shared airspace."""
        r = await self._airspace("POST", "/api/airspace/mission", json={"vehicleId": vehicle_id, "missionId": mission_id, "agent": agent, "status": status})
        return r is not None and r[0] < 400
