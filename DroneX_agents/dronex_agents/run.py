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


def log_to_stdout() -> bool:
    """DRONEX_LOG_STDOUT=1: the children write to this process's stdout/stderr, so journald (systemd) collects and
    rotates them. Otherwise each writes DroneX_agents/logs/<name>.log, as in local development."""
    return os.environ.get("DRONEX_LOG_STDOUT", "").strip().lower() in {"1", "true", "yes", "on"}


def main() -> None:
    from .config import exit_if_unsafe, load_settings

    exit_if_unsafe(load_settings())  # fail once, here, with the reason, instead of three children dying
    stdout = log_to_stdout()
    if not stdout:
        LOGS.mkdir(exist_ok=True)
    children: list[tuple[str, subprocess.Popen[bytes]]] = []
    env = dict(os.environ)
    env.setdefault("PYTHONUNBUFFERED", "1")
    for name, module in PROCS:
        if stdout:
            p = subprocess.Popen([sys.executable, "-m", module], cwd=str(ROOT), env=env)
            print(f"[agents] {name} pid {p.pid} → stdout", flush=True)
        else:
            log = open(LOGS / f"{name}.log", "ab")
            p = subprocess.Popen([sys.executable, "-m", module], cwd=str(ROOT), env=env, stdout=log, stderr=subprocess.STDOUT)
            print(f"[agents] {name} pid {p.pid} → logs/{name}.log")
        children.append((name, p))
        time.sleep(1.5)  # the fleet and the flight agent are up before the dispatcher resolves them

    def stop(*_: object, code: int = 0) -> None:
        for name, p in children:
            if p.poll() is None:
                p.send_signal(signal.SIGTERM)
        sys.exit(code)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    where = "the output above" if stdout else "logs/dispatcher.log"
    print(f"[agents] running; the dispatcher's inspector link is in {where} (Connect → Mailbox once)", flush=True)
    while True:
        for name, p in children:
            if p.poll() is not None:
                print(f"[agents] {name} exited with {p.returncode}; see {'the output above' if stdout else f'logs/{name}.log'}", flush=True)
                stop(code=p.returncode or 1)
        time.sleep(2)


if __name__ == "__main__":
    main()
