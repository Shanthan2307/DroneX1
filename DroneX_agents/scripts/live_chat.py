"""Talk to a locally running dispatcher the way ASI:One does, from a throwaway agent on this machine.

    DroneX_agents/.venv/bin/python scripts/live_chat.py "Fly a 10 km ridge run to Twin Peaks within 15 minutes" "chimera7-longrange" "approve"

Each argument is sent as one ChatMessage once the previous replies have settled; every reply (text and the
card metadata) is printed. Needs the three agents running with DRONEX_MAILBOX=0 (local endpoints) or with the
mailbox on (the dispatcher still has a local endpoint rule here).

With --via-agentverse the client ignores the local rule and resolves the dispatcher through the Almanac, so the
messages go through its Agentverse mailbox, the path ASI:One uses: a test of the mailbox without ASI:One.
"""

from __future__ import annotations

import asyncio
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from uagents import Agent, Context, Protocol  # noqa: E402
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage, MetadataContent, StartSessionContent, TextContent, chat_protocol_spec  # noqa: E402

from dronex_agents.addresses import LocalFirstResolver, dispatcher_address, local_rules  # noqa: E402
from dronex_agents.config import load_settings  # noqa: E402

s = load_settings()
via_agentverse = "--via-agentverse" in sys.argv
rules = {k: v for k, v in local_rules(s).items() if not (via_agentverse and k == dispatcher_address(s))}
me = Agent(name="live-chat-client", seed="dronex live chat client seed", port=8009, endpoint="http://127.0.0.1:8009/submit", resolve=LocalFirstResolver(rules), enable_agent_inspector=False, publish_agent_details=False, report_events=False)
chat = Protocol(spec=chat_protocol_spec)
FULL_CARDS = "--full-cards" in sys.argv
lines = [a for a in sys.argv[1:] if a not in ("--via-agentverse", "--full-cards")] or ["Fly a 10 km ridge run to Twin Peaks within 15 minutes"]
state = {"i": 0, "last": 0.0}


@chat.on_message(ChatMessage)
async def on_msg(ctx: Context, sender: str, msg: ChatMessage) -> None:
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
    for c in msg.content:
        if isinstance(c, TextContent):
            print(f"\n◀ {c.text}")
        elif isinstance(c, MetadataContent):
            kind = c.metadata.get("card_kind")
            payload = json.loads(c.metadata.get("card_payload", "{}"))
            print(f"  [card {kind}] {json.dumps(payload) if FULL_CARDS else json.dumps(payload)[:700]}")
    state["last"] = asyncio.get_event_loop().time()


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement) -> None:
    pass


@me.on_interval(period=2.0)
async def tick(ctx: Context) -> None:
    now = asyncio.get_event_loop().time()
    if state["i"] < len(lines) and now - state["last"] > 6.0:
        text = lines[state["i"]]
        state["i"] += 1
        state["last"] = now
        print(f"\n▶ {text}")
        content = [TextContent(type="text", text=text)]
        if state["i"] == 1:
            content.insert(0, StartSessionContent(type="start-session"))
        await ctx.send(dispatcher_address(s), ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid.uuid4(), content=content))
    elif state["i"] >= len(lines) and now - state["last"] > 120.0:
        print("\n(done)", flush=True)
        import os

        os._exit(0)  # a throwaway client: no graceful agent shutdown needed


me.include(chat)
if __name__ == "__main__":
    print(f"client {me.address} → dispatcher {dispatcher_address(s)}")
    me.run()
