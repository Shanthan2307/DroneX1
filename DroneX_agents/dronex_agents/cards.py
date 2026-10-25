"""ASI:One Interactive Cards, as the Agent Chat Protocol carries them.

A card is a `MetadataContent` block in a `ChatMessage` whose `metadata` (a dict of strings) holds:
    card_protocol_version  "1"
    requires_card_interaction  "true"  (absent or "false" for a purely informational card, with is_terminal "true")
    card_kind   "form" | "carousel" | "review" | "detail"
    card_payload  the payload as a JSON string, at most 64 KB
Payload shapes follow docs.agentverse.ai "Predefined card schemas". The user's answer comes back as a TextContent:
either a JSON object (direct @mention) or the planner's prose that repeats every identifier of the clicked
selection; `parse_card_response` accepts both.
"""

from __future__ import annotations

import json
import re
from typing import Any

from uagents_core.contrib.protocols.chat import MetadataContent

CARD_PAYLOAD_MAX_BYTES = 64 * 1024
CARD_KINDS = ("form", "carousel", "review", "detail")
FORM_FIELD_KINDS = ("text", "number", "email", "select", "checkbox")


class CardError(ValueError):
    pass


def _validate(kind: str, payload: dict[str, Any]) -> None:
    if kind not in CARD_KINDS:
        raise CardError(f"unknown card kind {kind!r}")
    if kind == "form":
        for f in payload.get("fields", []):
            if f.get("kind") not in FORM_FIELD_KINDS:
                raise CardError(f"form field {f.get('name')!r}: kind {f.get('kind')!r} is not one of {FORM_FIELD_KINDS}")
            if f.get("kind") == "select" and not f.get("options"):
                raise CardError(f"form field {f.get('name')!r}: a select needs options")
        if "submit_cta" not in payload or "selection" not in payload["submit_cta"]:
            raise CardError("a form needs a submit_cta with a selection")
    if kind == "review":
        for k in ("summary_rows", "approve_cta", "reject_cta"):
            if k not in payload:
                raise CardError(f"a review card needs {k}")
    if kind == "carousel" and not payload.get("items"):
        raise CardError("a carousel needs items")
    if kind == "detail" and "ctas" not in payload:
        raise CardError("a detail card needs ctas")


def card_content(kind: str, payload: dict[str, Any], *, interactive: bool = True, width_px: int | None = None) -> MetadataContent:
    """The MetadataContent block for one card. Raises CardError on a shape ASI:One would reject."""
    _validate(kind, payload)
    text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    if len(text.encode("utf-8")) > CARD_PAYLOAD_MAX_BYTES:
        raise CardError(f"card payload is {len(text)} bytes, over the 64 KB limit")
    meta: dict[str, str] = {
        "card_protocol_version": "1",
        "requires_card_interaction": "true" if interactive else "false",
        "card_kind": kind,
        "card_payload": text,
    }
    if not interactive:
        meta["is_terminal"] = "true"
    if width_px is not None:
        meta["preferred_drawer_width_px"] = str(max(320, min(800, int(width_px))))
    return MetadataContent(type="metadata", metadata=meta)


# ---- builders -------------------------------------------------------------------------------------------------


def form_card(title: str, fields: list[dict[str, Any]], submit_label: str = "Continue", action: str = "submit") -> MetadataContent:
    return card_content("form", {"title": title, "fields": fields, "submit_cta": {"label": submit_label, "selection": {"action": action}}})


def text_field(name: str, label: str, *, required: bool = False) -> dict[str, Any]:
    return {"name": name, "kind": "text", "label": label, "required": required}


def number_field(name: str, label: str, *, required: bool = False) -> dict[str, Any]:
    return {"name": name, "kind": "number", "label": label, "required": required}


def select_field(name: str, label: str, options: list[tuple[str, str]], *, required: bool = False) -> dict[str, Any]:
    return {"name": name, "kind": "select", "label": label, "required": required, "options": [{"value": v, "label": l} for v, l in options]}


def carousel_card(title: str, subtitle: str, items: list[dict[str, Any]]) -> MetadataContent:
    return card_content("carousel", {"title": title, "subtitle": subtitle, "items": items}, width_px=720)


def carousel_item(item_id: str, title: str, subtitle: str, *, badges: list[tuple[str, str]], secondary_text: str, cta_label: str, selection: dict[str, Any], image: str | None = None) -> dict[str, Any]:
    item: dict[str, Any] = {
        "id": item_id,
        "title": title,
        "subtitle": subtitle,
        "badges": [{"label": label, "variant": variant} for label, variant in badges],
        "secondary_text": secondary_text,
        "primary_cta": {"label": cta_label, "selection": selection},
    }
    if image:
        item["image"] = image
    return item


def review_card(title: str, rows: list[tuple[str, str]], *, approve_label: str = "Approve and fly", reject_label: str = "Not this one", approve_selection: dict[str, Any] | None = None, reject_selection: dict[str, Any] | None = None) -> MetadataContent:
    return card_content(
        "review",
        {
            "title": title,
            "summary_rows": [{"label": l, "value": v} for l, v in rows],
            "approve_cta": {"label": approve_label, "primary": True, "selection": approve_selection or {"action": "confirm"}},
            "reject_cta": {"label": reject_label, "selection": reject_selection or {"action": "cancel"}},
        },
        width_px=560,
    )


def detail_card(title: str, rows: list[tuple[str, str]], ctas: list[tuple[str, dict[str, Any]]], *, hero_image: str | None = None, sub_options: dict[str, Any] | None = None, interactive: bool = True) -> MetadataContent:
    payload: dict[str, Any] = {"title": title, "summary_rows": [{"label": l, "value": v} for l, v in rows], "ctas": [{"label": l, "selection": s, **({"primary": True} if i == 0 else {})} for i, (l, s) in enumerate(ctas)]}
    if hero_image:
        payload["hero_image"] = hero_image
    if sub_options:
        payload["sub_options"] = sub_options
    return card_content("detail", payload, interactive=interactive, width_px=560)


# ---- parsing the answer ---------------------------------------------------------------------------------------

_JSON_OBJ = re.compile(r"\{[\s\S]*\}")
_KV = re.compile(r"\b([a-z][a-z0-9_]{1,40})\b\s*(?:=|:|is|was|→|->)\s*[\"'`]?([A-Za-z0-9][A-Za-z0-9_.\-]{0,80})")


def parse_card_response(text: str, *, known_ids: list[str] | None = None, known_keys: list[str] | None = None) -> dict[str, Any]:
    """The selection the user made, from JSON text or from the planner's prose.

    JSON wins when the text is (or contains) an object. Otherwise identifiers are picked out: any `known_ids`
    mentioned, `key: value` pairs for `known_keys`, and an `action` of confirm/cancel/submit/select from the words.
    """
    text = (text or "").strip()
    out: dict[str, Any] = {}
    m = _JSON_OBJ.search(text)
    if m:
        try:
            obj = json.loads(m.group(0))
            if isinstance(obj, dict):
                out.update(obj)
                return out
        except ValueError:
            pass
    lowered = text.lower()
    for key in known_keys or []:
        km = re.search(rf"\b{re.escape(key)}\b\s*(?:=|:|is|was|of|→|->)?\s*[\"'`]?([A-Za-z0-9][A-Za-z0-9_.\-]{0,80})", text, flags=re.IGNORECASE)
        if km:
            out[key] = km.group(1)
    for kv in _KV.finditer(text):
        k, v = kv.group(1), kv.group(2)
        if (known_keys is None or k in known_keys) and k not in out:
            out[k] = v
    for cand in known_ids or []:
        if cand.lower() in lowered:
            out.setdefault("id", cand)
            break
    if "action" not in out:
        if re.search(r"\b(approve|approved|confirm|confirmed|yes|go ahead|fly it|proceed)\b", lowered):
            out["action"] = "confirm"
        elif re.search(r"\b(reject|rejected|cancel|cancelled|no thanks|not this|decline)\b", lowered):
            out["action"] = "cancel"
        elif re.search(r"\b(submit|submitted)\b", lowered):
            out["action"] = "submit"
        elif re.search(r"\b(select|selected|chose|chosen|pick|picked)\b", lowered):
            out["action"] = "select"
    return out


def numbers_from(answer: dict[str, Any], key: str) -> float | None:
    v = answer.get(key)
    if v is None or v == "":
        return None
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        m = re.search(r"-?\d+(?:\.\d+)?", str(v))
        return float(m.group(0)) if m else None
