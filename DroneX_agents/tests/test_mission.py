import json
from pathlib import Path

import pytest

from dronex_agents.mission import MissionRequest, find_swap, judge_candidate, kind_of, parse_request, parse_request_rules, rank, review_rows
from dronex_agents.render_api import Preset


def test_rule_parser_delivery():
    r = parse_request_rules("Deliver 2 kg of blood samples 6 km to UCSF within 20 minutes")
    assert r.kind == "delivery" and r.mission_id == "medical-delivery-15km"
    assert r.payload_g == 2000 and r.distance_km == 6 and r.time_min == 20
    assert r.place == "UCSF"
    assert r.missing() == []


def test_rule_parser_survey_and_missing():
    r = parse_request_rules("Survey 40 hectares of crops in 25 min")
    assert r.kind == "survey" and r.time_min == 25 and r.distance_km is None
    assert "distance_km" in r.missing() and "payload_g" not in r.missing()


def test_rule_parser_longrange_hours_and_metres():
    r = parse_request_rules("Fly a long range ridge run to Twin Peaks, 10000 m, in 0.25 h")
    assert r.kind == "longrange" and r.distance_km == 10 and r.time_min == 15 and r.place == "Twin Peaks"


def test_kind_of_sar():
    assert kind_of("search the hillside with a thermal camera for a missing hiker") == "sar"


async def test_model_parse_fills_and_rules_fallback():
    async def model(system: str, user: str) -> str:
        return 'Sure: {"kind": "survey", "payload_g": null, "distance_km": 8, "time_min": null, "place": "Candlestick Point", "launch": null}'

    r = await parse_request("Survey the fields near Candlestick Point within 25 minutes", model)
    assert r.kind == "survey" and r.distance_km == 8 and r.time_min == 25 and r.place == "Candlestick Point"

    async def broken(system: str, user: str) -> str:
        raise RuntimeError("no network")

    r2 = await parse_request("Deliver 500 g 6 km within 20 minutes", broken)
    assert r2.payload_g == 500 and r2.distance_km == 6


def test_judge_and_rank(catalog_json):
    req = MissionRequest(kind="longrange", mission_id="longrange-fpv-10km", text="", time_min=15)
    presets = [Preset.parse(p) for p in catalog_json["presets"]]
    cands = rank([judge_candidate(p, req) for p in presets])
    assert [c.preset_id for c in cands] == ["chimera7-longrange", "apex-5-freestyle-quad"]
    assert cands[0].passes and cands[0].why == "passes every check"
    assert not cands[1].passes and "Endurance" in cands[1].why
    # The request's own endurance target bites even when the mission row is ready.
    strict = MissionRequest(kind="longrange", mission_id="longrange-fpv-10km", text="", time_min=30)
    assert not judge_candidate(presets[0], strict).passes


async def test_find_swap_uses_verdict(mock_api, catalog_json, tmp_path: Path):
    (tmp_path / "batteries.json").write_text(json.dumps([{"id": "cnhl-black-6s-1300"}, {"id": "tattu-6s-4500-25c"}, {"id": "tattu-plus-6s-16000"}]))
    (tmp_path / "propellers.json").write_text(json.dumps([{"id": "apc-5x45-bn"}]))
    (tmp_path / "motors.json").write_text(json.dumps([{"id": "tmotor-f60-pro-iv"}]))
    req = MissionRequest(kind="delivery", mission_id="medical-delivery-15km", text="", payload_g=500, distance_km=6, time_min=20)
    preset = Preset.parse(catalog_json["presets"][0])
    swap = await find_swap(mock_api, preset, req, tmp_path)
    assert swap is not None
    assert swap.slot == "batteryId" and swap.to_id == "tattu-plus-6s-16000" and swap.row.ready
    assert "passes" in swap.describe()
    rows = review_rows("Chimera 7 with battery tattu-plus-6s-16000", swap.row, swap.verdict.summary, req, swap.verdict.warnings)
    labels = [l for l, _ in rows]
    assert "All-up weight" in labels and "Endurance" in labels and "Verdict" in labels and "Warning" in labels
    assert any("est." in v for _, v in rows)


async def test_find_swap_none(mock_api, catalog_json, tmp_path: Path):
    (tmp_path / "batteries.json").write_text(json.dumps([{"id": "cnhl-black-6s-1300"}, {"id": "gnb-3s-850"}]))
    req = MissionRequest(kind="delivery", mission_id="medical-delivery-15km", text="", time_min=20)
    assert await find_swap(mock_api, Preset.parse(catalog_json["presets"][1]), req, tmp_path) is None


def test_new_job_vs_command_for_the_flying_drone():
    from dronex_agents.dispatcher import is_new_job

    assert is_new_job("deliver 2 kg blood samples 6 km in 20 min")
    assert is_new_job("I need to run a 160 km/h aerobatic FPV sprint over 2 km, back in 5 minutes")
    assert not is_new_job("return to launch")
    assert not is_new_job("go to UCSF at 40 metres")
