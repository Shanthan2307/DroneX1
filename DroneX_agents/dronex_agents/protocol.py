"""Messages between the DroneX agents: the dispatcher asks the fleet what each drone can do and orders the flight
agent to fly. Every field that carries a verdict is the configurator's JSON, passed through untouched."""

from __future__ import annotations

from uagents import Model


class CapabilityQuery(Model):
    """Dispatcher → fleet agent: can you do this? `mission_id` is the catalog mission the request maps to."""

    request_id: str
    mission_id: str
    payload_g: float | None = None
    distance_km: float | None = None
    time_min: float | None = None


class CapabilityReply(Model):
    """Fleet agent → dispatcher: the preset (configurator JSON) and whether the mapped mission is ready."""

    request_id: str
    preset_id: str
    name: str
    ready: bool
    failing: int
    failing_summary: str
    preset_json: str


class FlightOrder(Model):
    """Dispatcher → flight agent: fly this hangar drone on this mission."""

    order_id: str
    preset_id: str
    design_id: str | None = None
    mission_id: str
    mission_text: str
    place: str | None = None
    altitude_m: float = 40.0
    reply_to: str


class FlightProgress(Model):
    order_id: str
    text: str


class FlightResult(Model):
    order_id: str
    ok: bool
    vehicle_id: str | None = None
    vehicle_name: str | None = None
    design_id: str | None = None
    map_url: str | None = None
    copilot_url: str | None = None
    telemetry_json: str = "{}"
    summary: str = ""


class PaymentQuote(Model):
    """Dispatcher → flight agent: ask what a flight costs (when payments are on)."""

    order_id: str
