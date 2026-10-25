"""Connect the running DroneX agents to Agentverse as mailbox agents: the inspector's "Connect → Mailbox" click,
from the terminal.

Needs an Agentverse API key (agentverse.ai → Profile → API Keys) as AGENTVERSE_API_KEY in DroneX_render/.env.local
or the environment, and the agents running with their mailbox on (DroneX_agents/dev.sh; DRONEX_MAILBOX=1 is the
default for the dispatcher). Each agent proves its identity to Agentverse itself, through its own /connect route;
the key never leaves this machine except to Agentverse.

    DroneX_agents/.venv/bin/python DroneX_agents/scripts/connect_agentverse.py             # the dispatcher
    DroneX_agents/.venv/bin/python DroneX_agents/scripts/connect_agentverse.py --all       # fleet and flight too
    DroneX_agents/.venv/bin/python DroneX_agents/scripts/connect_agentverse.py --status    # what Agentverse sees
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dronex_agents.addresses import dispatcher_address, fleet_addresses, flight_address  # noqa: E402
from dronex_agents.config import load_settings  # noqa: E402

ALMANAC = "https://agentverse.ai/v1/almanac/agents"


def status(address: str) -> str:
    try:
        r = httpx.get(f"{ALMANAC}/{address}", timeout=15)
    except httpx.HTTPError as e:
        return f"Agentverse not reachable ({e.__class__.__name__})"
    if r.status_code == 404:
        return "not in the Almanac"
    d = r.json()
    urls = ", ".join(e.get("url", "") for e in d.get("endpoints", []))
    return f"{d.get('status')} · {d.get('type')} · {urls}"


def connect(port: int, token: str) -> str:
    try:
        r = httpx.post(f"http://127.0.0.1:{port}/connect", json={"user_token": token, "agent_type": "mailbox"}, timeout=60)
    except httpx.HTTPError:
        return f"no agent on port {port}; start it with DroneX_agents/dev.sh"
    d = r.json() if r.headers.get("content-type", "").startswith("application/json") else {"detail": r.text}
    return "connected" if d.get("success") else f"refused: {d.get('detail') or d}"


def main() -> int:
    s = load_settings()
    targets = [("dispatcher", dispatcher_address(s), s.dispatcher_port)]
    if "--all" in sys.argv:
        targets.append(("flight", flight_address(s), s.flight_port))
        # The fleet runs in one Bureau on one port; /connect there answers for the Bureau, not each drone.
        targets += [(f"fleet {pid}", addr, None) for pid, addr in fleet_addresses(s).items()]
    if "--status" in sys.argv:
        for name, addr, _ in targets:
            print(f"{name:<40} {addr}  {status(addr)}")
        return 0
    token = os.environ.get("AGENTVERSE_API_KEY", "").strip()
    if not token:
        print("AGENTVERSE_API_KEY is not set: create one at agentverse.ai → Profile → API Keys and put it in DroneX_render/.env.local", file=sys.stderr)
        return 2
    failed = 0
    for name, addr, port in targets:
        if port is None:
            print(f"{name:<40} skipped (fleet agents talk to the dispatcher locally; DRONEX_FLEET_MAILBOX=1 and the inspector to list them)")
            continue
        out = connect(port, token)
        failed += out != "connected"
        print(f"{name:<40} {addr}  {out}")
    print("\nAgentverse now sees:")
    for name, addr, port in targets:
        if port is not None:
            print(f"  {name:<38} {status(addr)}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
