import json

import httpx
import pytest

from dronex_agents.addresses import address_of, fleet_addresses, local_rules
from dronex_agents.config import Settings, load_settings
from dronex_agents.fleet import reply_for
from dronex_agents.flight import pick_design
from dronex_agents.mission import MissionRequest
from dronex_agents.protocol import CapabilityQuery
from dronex_agents.render_api import Preset, RenderApi, RenderApiError


async def test_render_api_catalog_and_verdict(mock_api):
    cat = await mock_api.catalog()
    assert [p.id for p in cat.presets] == ["chimera7-longrange", "apex-5-freestyle-quad"]
    assert cat.preset("chimera7-longrange").mission("longrange-fpv-10km").ready
    assert cat.missions[0].target_endurance_min == 15
    v = await mock_api.verdict(preset_id="chimera7-longrange", swaps={"batteryId": "tattu-plus-6s-16000"}, mission_id="medical-delivery-15km")
    assert v.mission("medical-delivery-15km").ready and v.warnings


async def test_render_api_designs_refly_intent_airspace(mock_api):
    designs = await mock_api.designs()
    assert len(designs) == 2 and designs[0].based_on == "chimera7-longrange"
    flown = await mock_api.refly("s-bbbbbbbbbbbb")
    assert flown.vehicle_id == "veh-1234567890" and flown.url.endswith(flown.vehicle_id)
    r = await mock_api.intent("take off to 30 metres", flown.vehicle_id)
    assert r.reply.startswith("ok") and r.vehicle_id == flown.vehicle_id
    assert await mock_api.airspace() is None
    assert await mock_api.request_corridor({"vehicleId": "x"}) is None


async def test_render_api_unreachable_message():
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    api = RenderApi("http://render.test", transport=httpx.MockTransport(down))
    with pytest.raises(RenderApiError) as e:
        await api.catalog()
    assert "not reachable" in str(e.value) and "dev.sh" in str(e.value)


def test_pick_design_prefers_newest_of_preset():
    from dronex_agents.render_api import StoredDesign

    d = [StoredDesign("s-1", "a", "chimera7-longrange", "2026-01-01", "multicopter", "X", 0.5), StoredDesign("s-2", "b", "chimera7-longrange", "2026-02-01", "multicopter", "X", 0.5), StoredDesign("s-3", "c", "apex-5-freestyle-quad", "2026-03-01", "multicopter", "X", 0.3)]
    assert pick_design(d, "chimera7-longrange", None).id == "s-2"
    assert pick_design(d, "chimera7-longrange", "s-1").id == "s-1"
    assert pick_design(d, "tarot-x6-mapping", None) is None


def test_fleet_reply(catalog_json):
    preset = Preset.parse(catalog_json["presets"][0])
    r = reply_for(preset, CapabilityQuery(request_id="r1", mission_id="longrange-fpv-10km", time_min=15))
    assert r.ready and r.failing == 0 and json.loads(r.preset_json)["id"] == "chimera7-longrange"
    r2 = reply_for(preset, CapabilityQuery(request_id="r1", mission_id="medical-delivery-15km", time_min=20))
    assert not r2.ready and "Endurance" in r2.failing_summary


def test_addresses_are_deterministic_and_local(monkeypatch, tmp_path):
    monkeypatch.delenv("DRONEX_DISPATCHER_SEED", raising=False)
    s = load_settings(env_file=tmp_path / "missing.env")
    assert s.using_default_seeds
    a = fleet_addresses(s)
    assert len(a) == 8 and all(v.startswith("agent1q") for v in a.values())
    assert a["chimera7-longrange"] == address_of(s.fleet_seed_for("chimera7-longrange"))
    rules = local_rules(s)
    assert rules[a["chimera7-longrange"]] == s.fleet_endpoint
    assert set(rules.values()) == {s.fleet_endpoint, s.flight_endpoint, s.dispatcher_endpoint}


def test_settings_from_env(monkeypatch, tmp_path):
    env = tmp_path / ".env.local"
    env.write_text("INTENT_API_KEY=sk-test\nDRONEX_RENDER_URL=http://x:1/\nDRONEX_PAYMENTS=1\nDRONEX_DISPATCHER_SEED=aaa\nDRONEX_FLEET_SEED=bbb\nDRONEX_FLIGHT_SEED=ccc\n")
    for k in ("INTENT_API_KEY", "DRONEX_RENDER_URL", "DRONEX_PAYMENTS", "DRONEX_DISPATCHER_SEED", "DRONEX_FLEET_SEED", "DRONEX_FLIGHT_SEED"):
        monkeypatch.delenv(k, raising=False)
    s = load_settings(env_file=env)
    assert s.has_model and s.render_url == "http://x:1" and s.payments and not s.using_default_seeds


def test_pick_design_prefers_the_hangar_original_over_modified_copies():
    from dronex_agents.render_api import StoredDesign

    mk = lambda i, name, at: StoredDesign(id=i, name=name, based_on="apex", created_at=at, vehicle="multicopter", frame="X", span_m=0.2)  # noqa: E731
    designs = [mk("s-old", "Apex 5", "2026-10-24T00:00:00Z"), mk("s-mod", "Apex 5 (modified)", "2026-10-25T00:00:00Z")]
    assert pick_design(designs, "apex", None).id == "s-old"
    assert pick_design([designs[1]], "apex", None).id == "s-mod"
