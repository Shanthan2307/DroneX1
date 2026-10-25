"""Agent addresses derived from seeds, and a resolver that reaches the local agents without the Almanac.

The dispatcher, the fleet agents and the flight agent all run on this machine. Their addresses are deterministic
(seed → identity), so each side computes the others' addresses and endpoints from settings; the Almanac and the
mailbox are only needed for the ASI:One user, whose address the dispatcher learns from the incoming message.
"""

from __future__ import annotations

from uagents.crypto import Identity
from uagents.resolver import GlobalResolver, Resolver

from .config import Settings


def address_of(seed: str) -> str:
    return Identity.from_seed(seed, 0).address


def dispatcher_address(s: Settings) -> str:
    return address_of(s.dispatcher_seed)


def flight_address(s: Settings) -> str:
    return address_of(s.flight_seed)


def fleet_addresses(s: Settings) -> dict[str, str]:
    """preset id → the fleet agent's address."""
    return {pid: address_of(s.fleet_seed_for(pid)) for pid in s.preset_ids}


def local_rules(s: Settings) -> dict[str, str]:
    """address → endpoint for every agent on this machine."""
    rules = {dispatcher_address(s): s.dispatcher_endpoint, flight_address(s): s.flight_endpoint}
    for addr in fleet_addresses(s).values():
        rules[addr] = s.fleet_endpoint
    return rules


class LocalFirstResolver(Resolver):
    """Local agents by rule, everyone else (the ASI:One user, Agentverse) through the global resolver."""

    def __init__(self, rules: dict[str, str]):
        self._rules = rules
        self._global = GlobalResolver()

    async def resolve(self, destination: str) -> tuple[str | None, list[str]]:
        endpoint = self._rules.get(destination)
        if endpoint:
            return destination, [endpoint]
        return await self._global.resolve(destination)
