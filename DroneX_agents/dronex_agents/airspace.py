"""The shared airspace (SpacetimeDB track), through the configurator's /api/airspace routes.

Optional: when the track is not running every call returns None and the flight goes ahead without a corridor,
saying so. The contract (DroneX_render/src/app/api/airspace):
    GET  /api/airspace            → {vehicles, positions, corridors, incidents, missions}
    POST /api/airspace/corridor   {vehicleId, from:{lat,lon}, to:{lat,lon}, minAltM, maxAltM, widthM, ttlS}
                                  → 200 {granted: true, corridor} | 409 {granted: false, corridor: {reason...}}
    POST /api/airspace/mission    {vehicleId, missionId, agent, status} → {mission}
The reducer decides a corridor atomically against every corridor another vehicle holds; this module only asks.
"""

from __future__ import annotations

from dataclasses import dataclass

from .render_api import RenderApi, RenderApiError

BAND_M = 10.0  # the altitude band reserved around the cruise height, ± this
WIDTH_M = 60.0
TTL_S = 900


@dataclass
class CorridorAnswer:
    """`granted` is None when the airspace is not running (fly without a reservation)."""

    granted: bool | None
    line: str


async def reserve_corridor(api: RenderApi, *, vehicle_id: str, name: str, start: tuple[float, float], end: tuple[float, float], altitude_m: float) -> CorridorAnswer:
    body = {
        "vehicleId": vehicle_id,
        "from": {"lat": start[0], "lon": start[1]},
        "to": {"lat": end[0], "lon": end[1]},
        "minAltM": max(altitude_m - BAND_M, 0.0),
        "maxAltM": altitude_m + BAND_M,
        "widthM": WIDTH_M,
        "ttlS": TTL_S,
    }
    try:
        r = await api.request_corridor(body)
    except RenderApiError as e:
        return CorridorAnswer(None, f"corridor: the shared airspace did not answer ({e}); flying without a reservation")
    if r is None:
        return CorridorAnswer(None, "corridor: the shared airspace is not running (SpacetimeDB track off); flying without a reservation")
    c = r.get("corridor") or {}
    band = f"{body['minAltM']:g}–{body['maxAltM']:g} m"
    if r.get("granted"):
        return CorridorAnswer(True, f"corridor to {name} reserved in the shared airspace (#{c.get('id', '?')}, {band} above home)")
    return CorridorAnswer(False, f"corridor to {name} refused by the shared airspace: {c.get('reason') or 'it overlaps another vehicle'}")
