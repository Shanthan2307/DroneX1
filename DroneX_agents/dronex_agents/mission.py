"""From a sentence to a mission request, and from the hangar to ranked candidates and the swap that fixes one.

Code decides. The model (when there is a key) only turns words into a structured request; the rule parser does the
same without it. Which drone passes is read from the configurator's mission matrix; a swap is proposed only after
the configurator has re-judged it through /api/verdict.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from .render_api import Catalog, Check, MissionRow, Preset, RenderApi, Verdict

# What a request is about → the catalog mission whose requirements the physics is judged against.
MISSION_KINDS: dict[str, tuple[str, tuple[str, ...]]] = {
    "delivery": ("medical-delivery-15km", ("deliver", "delivery", "courier", "medical", "blood", "sample", "vaccine", "package", "parcel", "clinic", "hospital", "transit")),
    "survey": ("multispectral-survey-hex", ("survey", "mapping", "map ", "crop", "field", "farm", "multispectral", "ndvi", "orthomosaic", "hectare", "acre")),
    "longrange": ("longrange-fpv-10km", ("long range", "long-range", "ridge", "10 km", "cruise", "far", "distance run")),
    "sprint": ("fpv-sprint-160kmh", ("sprint", "race", "freestyle", "aerobatic", "fast", "160")),
    "sar": ("sar-thermal-grid-40min", ("search", "rescue", "thermal", "missing", "grid", "loiter", "fire", "wildfire")),
    "inspection": ("sub-250-urban-scan", ("inspect", "inspection", "urban", "building", "roof", "bridge", "sub-250", "250 g", "indoor")),
}

_NUM = r"(\d+(?:[.,]\d+)?)"


@dataclass
class MissionRequest:
    kind: str
    mission_id: str
    text: str
    payload_g: float | None = None
    distance_km: float | None = None
    time_min: float | None = None
    place: str | None = None
    launch: str | None = None

    def missing(self) -> list[str]:
        out = []
        if self.kind in ("delivery",) and self.payload_g is None:
            out.append("payload_g")
        if self.distance_km is None:
            out.append("distance_km")
        if self.time_min is None:
            out.append("time_min")
        return out

    def to_json(self) -> str:
        return json.dumps(asdict(self))

    @staticmethod
    def from_json(s: str) -> "MissionRequest":
        return MissionRequest(**json.loads(s))

    def describe(self) -> str:
        bits = [f"a {self.kind} mission"]
        if self.payload_g is not None:
            bits.append(f"{self.payload_g:.0f} g payload")
        if self.distance_km is not None:
            bits.append(f"{self.distance_km:g} km")
        if self.time_min is not None:
            bits.append(f"within {self.time_min:g} min")
        if self.place:
            bits.append(f"to {self.place}")
        return ", ".join(bits)


def _num(pattern: str, text: str, scale: float = 1.0) -> float | None:
    m = re.search(pattern, text, flags=re.IGNORECASE)
    if not m:
        return None
    return float(m.group(1).replace(",", ".")) * scale


def kind_of(text: str) -> str:
    t = text.lower()
    best, score = "delivery", 0
    for kind, (_, words) in MISSION_KINDS.items():
        n = sum(1 for w in words if w in t)
        if n > score:
            best, score = kind, n
    return best


def parse_request_rules(text: str) -> MissionRequest:
    """A rule parser for the demo sentences: payload (kg/g), distance (km/m), time (min/h), a place after 'to'."""
    kind = kind_of(text)
    payload = _num(rf"{_NUM}\s*kg\b", text, 1000) or _num(rf"{_NUM}\s*(?:g|grams?)\b", text)
    distance = _num(rf"{_NUM}\s*km\b", text) or _num(rf"{_NUM}\s*(?:kilomet(?:er|re)s?)", text)
    if distance is None:
        metres = _num(rf"{_NUM}\s*(?:m|metres?|meters?)\b(?!\w)", text)
        if metres is not None and metres > 200:
            distance = metres / 1000
    time_min = _num(rf"{_NUM}\s*(?:min|mins|minutes?)\b", text)
    if time_min is None:
        hours = _num(rf"{_NUM}\s*(?:h|hr|hrs|hours?)\b", text)
        time_min = hours * 60 if hours is not None else None
    place = None
    pm = re.search(r"\bto (?:the |a )?([A-Z][\w'&.\- ]{2,60}?)(?=[,.;]| within| in \d| under| at \d| by | and |$)", text)
    if pm:
        place = pm.group(1).strip()
    launch = None
    lm = re.search(r"\bfrom (?:the |a )?([A-Z][\w'&.\- ]{2,60}?)(?=[,.;]| to | within| in \d|$)", text)
    if lm:
        launch = lm.group(1).strip()
    return MissionRequest(kind=kind, mission_id=MISSION_KINDS[kind][0], text=text, payload_g=payload, distance_km=distance, time_min=time_min, place=place, launch=launch)


PARSE_SYSTEM = (
    "You turn a drone mission request into JSON. Fields: kind (one of delivery, survey, longrange, sprint, sar, inspection), "
    "payload_g (grams, number or null), distance_km (number or null), time_min (minutes, number or null), place (destination as written, or null), "
    "launch (start place, or null). Convert units (2 kg = 2000 g; 1 h = 60 min). Never invent a number the user did not give. Answer with the JSON object only."
)

ModelCall = Callable[[str, str], Awaitable[str]]


async def parse_request(text: str, model_call: ModelCall | None) -> MissionRequest:
    """The model when there is one (JSON out), then the rule parser fills anything the model left null."""
    rules = parse_request_rules(text)
    if model_call is None:
        return rules
    try:
        raw = await model_call(PARSE_SYSTEM, text)
        m = re.search(r"\{[\s\S]*\}", raw)
        data = json.loads(m.group(0)) if m else {}
    except Exception:
        return rules
    kind = data.get("kind") if data.get("kind") in MISSION_KINDS else rules.kind

    def num(k: str, fallback: float | None) -> float | None:
        v = data.get(k)
        return float(v) if isinstance(v, (int, float)) else fallback

    return MissionRequest(
        kind=kind,
        mission_id=MISSION_KINDS[kind][0],
        text=text,
        payload_g=num("payload_g", rules.payload_g),
        distance_km=num("distance_km", rules.distance_km),
        time_min=num("time_min", rules.time_min),
        place=(data.get("place") if isinstance(data.get("place"), str) and data.get("place") else rules.place),
        launch=(data.get("launch") if isinstance(data.get("launch"), str) and data.get("launch") else rules.launch),
    )


# ---- candidates -------------------------------------------------------------------------------------------------


@dataclass
class Candidate:
    preset_id: str
    name: str
    passes: bool
    mission_ready: bool
    failing: list[Check]
    request_notes: list[str]
    hover_time_min: float | None
    hover_twr: float | None
    auw_g: float | None
    preset: dict[str, Any] = field(default_factory=dict)

    @property
    def why(self) -> str:
        parts = [f"{c.label}: {c.reason}" for c in self.failing] + self.request_notes
        return "; ".join(parts) if parts else "passes every check"


def judge_candidate(preset: Preset, req: MissionRequest, row: MissionRow | None = None) -> Candidate:
    """The configurator's mission row for the mapped mission, plus the request's own endurance target."""
    row = row or preset.mission(req.mission_id)
    failing = row.failing_checks() if row else []
    notes: list[str] = []
    hover = row.summary.hover_time_min if row else preset.summary.hover_time_min
    if req.time_min is not None and hover is not None and hover < req.time_min:
        notes.append(f"Endurance: {hover:.0f} min hover (est.) is under the {req.time_min:g} min you asked for")
    passes = bool(row and row.ready) and not notes
    return Candidate(
        preset_id=preset.id,
        name=preset.name,
        passes=passes,
        mission_ready=bool(row and row.ready),
        failing=failing,
        request_notes=notes,
        hover_time_min=hover,
        hover_twr=row.summary.hover_twr if row else preset.summary.hover_twr,
        auw_g=row.summary.auw_g if row else preset.summary.auw_g,
        preset=preset.to_dict(),
    )


def rank(cands: list[Candidate]) -> list[Candidate]:
    return sorted(cands, key=lambda c: (not c.passes, not c.mission_ready, len(c.failing) + len(c.request_notes), -(c.hover_time_min or 0)))


# ---- swaps ------------------------------------------------------------------------------------------------------


def part_ids(data_dir: Path, kind: str) -> list[str]:
    """Record ids from the dataset itself (never typed here), e.g. kind = 'batteries' | 'propellers' | 'motors'."""
    f = data_dir / f"{kind}.json"
    try:
        return [str(r["id"]) for r in json.loads(f.read_text("utf-8")) if isinstance(r, dict) and "id" in r]
    except (OSError, ValueError):
        return []


SWAP_SLOTS = (("payloadId", "payloads"), ("batteryId", "batteries"), ("propellerId", "propellers"), ("motorId", "motors"))


@dataclass
class Swap:
    preset_id: str
    slot: str
    from_id: str
    to_id: str
    verdict: Verdict
    row: MissionRow

    def describe(self) -> str:
        return f"swap {self.slot.replace('Id', '')} {self.from_id} → {self.to_id}: {self.row.mission_name} passes ({self.row.summary.hover_time_min:.0f} min hover est., {self.row.summary.auw_g:.0f} g)" if self.row.summary.hover_time_min is not None and self.row.summary.auw_g is not None else f"swap {self.slot} {self.from_id} → {self.to_id}"


async def find_swap(api: RenderApi, preset: Preset, req: MissionRequest, data_dir: Path, *, max_tries: int = 40) -> Swap | None:
    """One-part swaps on the payloads, batteries, propellers, then motors shelves; the first that the configurator
    judges ready for the mapped mission (and that meets the request's own endurance) wins. Every try is /api/verdict."""
    tries = 0
    for slot, shelf in SWAP_SLOTS:
        current = str(preset.build.get(slot, ""))
        for pid in part_ids(data_dir, shelf):
            if pid == current:
                continue
            tries += 1
            if tries > max_tries:
                return None
            try:
                v = await api.verdict(preset_id=preset.id, swaps={slot: pid}, mission_id=req.mission_id)
            except Exception:
                continue
            row = v.mission(req.mission_id)
            if not row or not row.ready:
                continue
            if req.time_min is not None and row.summary.hover_time_min is not None and row.summary.hover_time_min < req.time_min:
                continue
            return Swap(preset_id=preset.id, slot=slot, from_id=current, to_id=pid, verdict=v, row=row)
    return None


def review_rows(name: str, row: MissionRow | None, summary_fallback: Any, req: MissionRequest, warnings: list[str]) -> list[tuple[str, str]]:
    """The review card's rows: the physics numbers against what the request needs, each labelled est."""
    s = row.summary if row else summary_fallback
    rows: list[tuple[str, str]] = [("Drone", name), ("Mission", f"{row.mission_name if row else req.mission_id}")]
    if s.auw_g is not None:
        limit = f" (limit {row.max_weight_g:.0f} g)" if row and row.max_weight_g else ""
        rows.append(("All-up weight", f"{s.auw_g:.0f} g{limit}"))
    if s.hover_twr is not None:
        rows.append(("Hover thrust-to-weight", f"{s.hover_twr:.2f}× (est.)"))
    if s.hover_power_w is not None:
        rows.append(("Hover power", f"{s.hover_power_w:.0f} W (est.)"))
    if s.hover_time_min is not None:
        need = f" · you need {req.time_min:g} min" if req.time_min is not None else (f" · mission needs {row.target_endurance_min:g} min" if row and row.target_endurance_min else "")
        rows.append(("Endurance", f"{s.hover_time_min:.0f} min hover (est.){need}"))
    if req.distance_km is not None or (row and row.target_distance_km):
        dist = req.distance_km if req.distance_km is not None else row.target_distance_km  # type: ignore[union-attr]
        rows.append(("Distance", f"{dist:g} km required"))
    if req.payload_g is not None:
        rows.append(("Payload", f"{req.payload_g:.0f} g requested"))
    if row:
        for c in row.checks:
            if c.status == "fail":
                rows.append((f"✗ {c.label}", c.reason))
        rows.append(("Verdict", "READY" if row.ready else f"NOT READY · {row.failing} check(s) failing"))
    for w in warnings[:3]:
        rows.append(("Warning", w))
    return rows
