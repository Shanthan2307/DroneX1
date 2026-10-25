"""Start the three agent processes (fleet, flight, dispatcher) and keep them up; logs in DroneX_agents/logs."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
LOGS = ROOT / "logs"
PROCS = [("fleet", "dronex_agents.fleet"), ("flight", "dronex_agents.flight"), ("dispatcher", "dronex_agents.dispatcher")]


def main() -> None:
    LOGS.mkdir(exist_ok=True)
    children: list[tuple[str, subprocess.Popen[bytes]]] = []
    env = dict(os.environ)
    env.setdefault("PYTHONUNBUFFERED", "1")
    for name, module in PROCS:
        log = open(LOGS / f"{name}.log", "ab")
        p = subprocess.Popen([sys.executable, "-m", module], cwd=str(ROOT), env=env, stdout=log, stderr=subprocess.STDOUT)
        children.append((name, p))
        print(f"[agents] {name} pid {p.pid} → logs/{name}.log")
        time.sleep(1.5)  # the fleet and the flight agent are up before the dispatcher resolves them

    def stop(*_: object) -> None:
        for name, p in children:
            if p.poll() is None:
                p.send_signal(signal.SIGTERM)
        sys.exit(0)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    print("[agents] running; the dispatcher's inspector link is in logs/dispatcher.log (Connect → Mailbox once)")
    while True:
        for name, p in children:
            if p.poll() is not None:
                print(f"[agents] {name} exited with {p.returncode}; see logs/{name}.log")
                stop()
        time.sleep(2)


if __name__ == "__main__":
    main()
