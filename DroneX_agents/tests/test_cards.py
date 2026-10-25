import json

import pytest

from dronex_agents.cards import CardError, card_content, carousel_card, carousel_item, detail_card, form_card, number_field, numbers_from, parse_card_response, review_card, select_field, text_field


def meta(c):
    return c.metadata


def test_form_card_shape():
    c = form_card("Mission", [select_field("kind", "Kind", [("delivery", "Delivery")], required=True), number_field("distance_km", "Distance"), text_field("place", "Place")], submit_label="Go")
    m = meta(c)
    assert m["card_protocol_version"] == "1"
    assert m["requires_card_interaction"] == "true"
    assert m["card_kind"] == "form"
    payload = json.loads(m["card_payload"])
    assert payload["title"] == "Mission"
    assert payload["submit_cta"] == {"label": "Go", "selection": {"action": "submit"}}
    kinds = {f["kind"] for f in payload["fields"]}
    assert kinds <= {"text", "number", "email", "select", "checkbox"}
    assert payload["fields"][0]["options"] == [{"value": "delivery", "label": "Delivery"}]


def test_form_rejects_bad_field_kind():
    with pytest.raises(CardError):
        card_content("form", {"title": "x", "fields": [{"name": "a", "kind": "slider", "label": "A"}], "submit_cta": {"label": "ok", "selection": {"action": "submit"}}})


def test_form_rejects_select_without_options():
    with pytest.raises(CardError):
        form_card("x", [{"name": "k", "kind": "select", "label": "K", "options": []}])


def test_carousel_shape_and_width():
    item = carousel_item("chimera7-longrange", "Chimera 7", "1559 g", badges=[("READY", "success")], secondary_text="passes", cta_label="Choose", selection={"action": "select", "preset_id": "chimera7-longrange"})
    c = carousel_card("Candidates", "1 of 2 pass", [item])
    m = meta(c)
    assert m["card_kind"] == "carousel"
    assert m["preferred_drawer_width_px"] == "720"
    p = json.loads(m["card_payload"])
    assert p["items"][0]["badges"] == [{"label": "READY", "variant": "success"}]
    assert p["items"][0]["primary_cta"]["selection"]["preset_id"] == "chimera7-longrange"


def test_carousel_needs_items():
    with pytest.raises(CardError):
        carousel_card("x", "y", [])


def test_review_shape():
    c = review_card("Chimera 7", [("All-up weight", "1559 g"), ("Verdict", "READY")], approve_selection={"action": "confirm", "preset_id": "c7"})
    p = json.loads(meta(c)["card_payload"])
    assert p["summary_rows"][0] == {"label": "All-up weight", "value": "1559 g"}
    assert p["approve_cta"]["primary"] is True
    assert p["approve_cta"]["selection"] == {"action": "confirm", "preset_id": "c7"}
    assert p["reject_cta"]["selection"] == {"action": "cancel"}


def test_detail_shape_and_terminal():
    c = detail_card("In the air", [("Vehicle", "x")], [("Fly another", {"action": "new"}), ("Watch", {"action": "watch"})], interactive=False)
    m = meta(c)
    assert m["requires_card_interaction"] == "false"
    assert m["is_terminal"] == "true"
    p = json.loads(m["card_payload"])
    assert p["ctas"][0]["primary"] is True and "primary" not in p["ctas"][1]


def test_payload_size_limit():
    with pytest.raises(CardError):
        detail_card("big", [("k", "v" * 70000)], [("ok", {"action": "x"})])


def test_parse_json_response():
    assert parse_card_response('{"action":"select","preset_id":"chimera7-longrange"}') == {"action": "select", "preset_id": "chimera7-longrange"}
    assert parse_card_response('The user submitted the form: {"distance_km": "10", "time_min": 15, "action": "submit"}')["distance_km"] == "10"


def test_parse_prose_response():
    r = parse_card_response("The user selected the Chimera 7 (preset_id: chimera7-longrange) and chose to continue.", known_ids=["apex-5-freestyle-quad", "chimera7-longrange"], known_keys=["preset_id", "action"])
    assert r["preset_id"] == "chimera7-longrange"
    assert r["id"] == "chimera7-longrange"
    assert r["action"] == "select"
    assert parse_card_response("The user approved the review card (action: confirm).")["action"] == "confirm"
    assert parse_card_response("They rejected it.")["action"] == "cancel"
    assert parse_card_response("yes, fly it")["action"] == "confirm"


def test_numbers_from():
    assert numbers_from({"distance_km": "6.5"}, "distance_km") == 6.5
    assert numbers_from({"time_min": "about 20 minutes"}, "time_min") == 20
    assert numbers_from({}, "time_min") is None
