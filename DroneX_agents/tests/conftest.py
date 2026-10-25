import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from dronex_agents.render_api import RenderApi

HERE = Path(__file__).resolve().parent


def mission(mid: str, name: str, ready: bool, checks: list[dict[str, Any]], hover: float, auw: float = 1500.0) -> dict[str, Any]:
    return {
        "mission": {"id": mid, "name": name, "targetDistance_km": 10, "targetEndurance_min": 15, "maxAllowableWeight_g": 25000},
        "ready": ready,
        "failing": sum(1 for c in checks if c["status"] == "fail"),
        "notJudged": 0,
        "checks": checks,
        "summary": {"auw_g": auw, "thrustPerMotor_g": 1800, "hoverTWR": 4.6, "hoverPower_W": 244, "hoverTime_min": hover, "maxCurrent_A": 100, "feasible": True},
    }


PASS = {"key": "endurance", "label": "Endurance", "status": "pass", "have": "19 min", "want": "≥ 15 min", "reason": "19 min of mixed flying, needs 15 min"}
FAIL_W = {"key": "weight", "label": "Weight", "status": "fail", "have": "1559 g", "want": "≤ 249 g", "reason": "1559 g all-up, 1310 g over the 249 g limit"}
FAIL_E = {"key": "endurance", "label": "Endurance", "status": "fail", "have": "9 min", "want": "≥ 15 min", "reason": "9 min of mixed flying, needs 15 min"}


def preset(pid: str, name: str, rows: list[dict[str, Any]], battery: str = "cnhl-black-6s-1300") -> dict[str, Any]:
    return {
        "id": pid,
        "name": name,
        "note": "",
        "source": "",
        "build": {"airframeId": "apex-5-freestyle", "motorId": "tmotor-f60-pro-iv", "propellerId": "apc-5x45-bn", "batteryId": battery, "payloadId": None, "missionId": rows[0]["mission"]["id"]},
        "sim": {"vehicle": "multicopter", "frame": "X", "span_m": 0.35, "params": [{"name": "BATT_CAPACITY", "value": 1300}]},
        "summary": rows[0]["summary"],
        "readiness": {"ready": rows[0]["ready"], "title": "x", "lines": []},
        "missions": rows,
        "warnings": [],
    }


@pytest.fixture
def catalog_json() -> dict[str, Any]:
    return {
        "presets": [
            preset("chimera7-longrange", "Chimera 7 long range", [mission("longrange-fpv-10km", "10 km ridge run", True, [PASS], 19.0), mission("medical-delivery-15km", "15 km medical", False, [FAIL_E], 9.0)]),
            preset("apex-5-freestyle-quad", "Apex 5 freestyle", [mission("longrange-fpv-10km", "10 km ridge run", False, [FAIL_E], 6.0), mission("medical-delivery-15km", "15 km medical", False, [FAIL_E, FAIL_W], 5.0)]),
        ],
        "missions": [{"id": "longrange-fpv-10km", "name": "10 km ridge run", "description": "", "targetDistance_km": 10, "targetEndurance_min": 15}, {"id": "medical-delivery-15km", "name": "15 km medical", "description": "", "targetDistance_km": 15, "targetEndurance_min": 20}],
    }


@pytest.fixture
def mock_api(catalog_json: dict[str, Any]) -> RenderApi:
    """A RenderApi over a mock transport: /api/verdict makes the 16000 mAh battery pass everything."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/catalog":
            return httpx.Response(200, json=catalog_json)
        if path == "/api/verdict":
            body = json.loads(request.content or b"{}")
            swaps = body.get("swaps", {})
            pid = body.get("presetId", "x")
            good = swaps.get("batteryId") == "tattu-plus-6s-16000"
            rows = [mission("medical-delivery-15km", "15 km medical", good, [PASS] if good else [FAIL_E], 25.0 if good else 9.0, auw=2800), mission("longrange-fpv-10km", "10 km ridge run", True, [PASS], 25.0 if good else 19.0)]
            return httpx.Response(200, json={"build": {"airframeId": "apex-5-freestyle", "batteryId": swaps.get("batteryId", "cnhl-black-6s-1300")}, "summary": rows[0]["summary"], "readiness": {"ready": good, "title": "", "lines": []}, "missions": rows, "warnings": ["Discharge: near the pack's limit"] if good else [], "_pid": pid})
        if path == "/api/sim/designs":
            return httpx.Response(200, json={"designs": [{"id": "s-aaaaaaaaaaaa", "name": "Chimera 7", "basedOn": "chimera7-longrange", "createdAt": "2026-10-25T00:00:00Z", "profile": {"vehicle": "multicopter", "frame": "X", "span_m": 0.5}}, {"id": "s-bbbbbbbbbbbb", "name": "Chimera 7 newer", "basedOn": "chimera7-longrange", "createdAt": "2026-10-25T01:00:00Z", "profile": {"vehicle": "multicopter", "frame": "X", "span_m": 0.5}}]})
        if path.startswith("/api/sim/refly/"):
            return httpx.Response(200, json={"id": path.rsplit("/", 1)[1], "name": "Chimera 7 newer", "vehicleId": "veh-1234567890", "linkId": "li1", "url": "http://127.0.0.1:45010/?vehicle=veh-1234567890"})
        if path == "/api/copilot/intent":
            body = json.loads(request.content or b"{}")
            return httpx.Response(200, json={"reply": f"ok: {body.get('text')}", "actions": [{"tool": "status", "args": {}, "result": "fine"}], "vehicleId": body.get("vehicleId")})
        if path.startswith("/api/airspace"):
            return httpx.Response(404, json={"error": "no airspace"})
        return httpx.Response(404, json={"error": "nope"})

    return RenderApi("http://render.test", transport=httpx.MockTransport(handler))
