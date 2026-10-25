"""End to end through ASI:One itself: the ASI:One agentic model (`asi1`) is asked to use DroneX Dispatch, the way a
judge would in the ASI:One chat, and the conversation is printed. Proves the Agentverse listing, the mailbox and
the chat protocol together; run it after scripts/connect_agentverse.py, with the agents running.

Uses INTENT_API_KEY (the ASI:One key) from DroneX_render/.env.local. Agents can answer later than the model does,
so like the ASI:One docs it polls with "Any update?" on the same session until the reply changes.

The model's words are not proof: when it cannot reach an agent it may write a plausible "agent response" itself
(seen on 2026-10-25 before the mailbox was connected). So the verdict comes from the dispatcher's own log: did a
chat message from ASI:One arrive while this ran? Pass --log <path> if the dispatcher logs elsewhere.

    DroneX_agents/.venv/bin/python DroneX_agents/scripts/asi1_e2e.py ["<first message>" ["<follow-up>" ...]]
"""

from __future__ import annotations

import sys
import time
import uuid
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dronex_agents.addresses import dispatcher_address  # noqa: E402
from dronex_agents.config import load_settings  # noqa: E402

POLL_S = 5.0
POLLS = 24  # about two minutes per turn, as in the ASI:One agentic-LLM guide


def main() -> int:
    s = load_settings()
    if not s.intent_api_key:
        print("INTENT_API_KEY (the ASI:One key) is not set in DroneX_render/.env.local", file=sys.stderr)
        return 2
    addr = dispatcher_address(s)
    args = sys.argv[1:]
    log = Path(__file__).resolve().parents[1] / "logs" / "dispatcher.log"
    if "--log" in args:
        i = args.index("--log")
        log = Path(args[i + 1])
        del args[i : i + 2]
    start = log.stat().st_size if log.exists() else 0
    turns = args or [
        f"Use the agent {addr} (DroneX Dispatch): I need to run a 160 km/h aerobatic FPV sprint over 2 km, back in 5 minutes.",
    ]
    session = str(uuid.uuid4())
    headers = {"Authorization": f"Bearer {s.intent_api_key}", "x-session-id": session}
    base = s.intent_api_base.rstrip("/")
    history: list[dict[str, str]] = []
    with httpx.Client(timeout=120) as http:

        def ask(text: str) -> str:
            history.append({"role": "user", "content": text})
            r = http.post(f"{base}/chat/completions", headers=headers, json={"model": "asi1", "messages": history, "stream": False})
            r.raise_for_status()
            reply = r.json()["choices"][0]["message"]["content"] or ""
            history.append({"role": "assistant", "content": reply})
            return reply

        print(f"session {session} · dispatcher {addr}")
        for text in turns:
            print(f"\n▶ {text}")
            reply = ask(text)
            print(f"◀ {reply}")
            for _ in range(POLLS):
                time.sleep(POLL_S)
                nxt = ask("Any update?")
                if nxt.strip() != reply.strip():
                    print(f"◀ {nxt}")
                    reply = nxt
                    if "dronex" in nxt.lower() or "hangar" in nxt.lower() or "verdict" in nxt.lower():
                        break
    seen = ""
    if log.exists():
        with log.open("rb") as f:
            f.seek(start)
            seen = f.read().decode("utf-8", "replace")
    arrived = [ln for ln in seen.splitlines() if "[DroneX Dispatch]: agent1" in ln and "…:" in ln]
    print(f"\n{'PASS' if arrived else 'FAIL'}: {len(arrived)} message(s) from ASI:One reached the dispatcher ({log})")
    for ln in arrived[:5]:
        print(f"  {ln.split(']: ', 1)[-1][:160]}")
    return 0 if arrived else 1


if __name__ == "__main__":
    raise SystemExit(main())
