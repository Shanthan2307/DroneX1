"""Settings for the three agents, from DroneX_render/.env.local (the one env file the whole project shares).

Nothing here is secret by itself; the keys are read from the environment and never logged. Missing keys degrade:
no INTENT_API_KEY means the dispatcher parses requests with its rule-based parser instead of the ASI:One model.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / "DroneX_render" / ".env.local"
DATA_DIR = ROOT / "DroneX_render" / "prototype" / "drone-assembly" / "src" / "data" / "drone"

# The hangar, in the dataset's order. The fleet agents' seeds derive from these ids, so the dispatcher can compute
# every fleet address without a registry.
PRESET_IDS = [
    "apex-5-freestyle-quad",
    "apex-5-urban-light",
    "apex-5-medical-courier",
    "eclipson-model-a-scout",
    "cinelog25-urban-whoop",
    "chimera7-longrange",
    "tarot-x6-mapping",
    "vtbird-vtol-mapping",
]

DEFAULT_SEEDS = {
    "dispatcher": "dronex dispatcher development seed change me",
    "fleet": "dronex fleet development seed change me",
    "flight": "dronex flight development seed change me",
}


def _env(key: str, default: str = "") -> str:
    v = os.environ.get(key, "")
    return v if v.strip() else default


def _flag(key: str, default: bool) -> bool:
    v = os.environ.get(key)
    if v is None or not v.strip():
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    render_url: str
    intent_api_base: str
    intent_api_key: str
    intent_model: str
    dispatcher_seed: str
    fleet_seed: str
    flight_seed: str
    dispatcher_port: int = 8001
    fleet_port: int = 8002
    flight_port: int = 8003
    host: str = "127.0.0.1"
    mailbox: bool = True
    fleet_mailbox: bool = False
    flight_mailbox: bool = False
    payments: bool = False
    payments_ledger: bool = False
    flight_price_fet: str = "0.5"
    data_dir: Path = DATA_DIR
    preset_ids: tuple[str, ...] = field(default_factory=lambda: tuple(PRESET_IDS))
    sim_ui_url: str = "http://127.0.0.1:45010"
    using_default_seeds: bool = False

    @property
    def fleet_endpoint(self) -> str:
        return f"http://{self.host}:{self.fleet_port}/submit"

    @property
    def flight_endpoint(self) -> str:
        return f"http://{self.host}:{self.flight_port}/submit"

    @property
    def dispatcher_endpoint(self) -> str:
        return f"http://{self.host}:{self.dispatcher_port}/submit"

    @property
    def has_model(self) -> bool:
        return bool(self.intent_api_key)

    def fleet_seed_for(self, preset_id: str) -> str:
        return f"{self.fleet_seed}:{preset_id}"


def load_settings(env_file: Path | None = ENV_FILE) -> Settings:
    if env_file is not None and env_file.exists():
        load_dotenv(env_file, override=False)
    seeds = {k: _env(f"DRONEX_{k.upper()}_SEED", DEFAULT_SEEDS[k]) for k in DEFAULT_SEEDS}
    return Settings(
        render_url=_env("DRONEX_RENDER_URL", "http://localhost:3000").rstrip("/"),
        intent_api_base=_env("INTENT_API_BASE", "https://api.asi1.ai/v1"),
        intent_api_key=_env("INTENT_API_KEY"),
        intent_model=_env("INTENT_MODEL", "asi1-mini"),
        dispatcher_seed=seeds["dispatcher"],
        fleet_seed=seeds["fleet"],
        flight_seed=seeds["flight"],
        dispatcher_port=int(_env("DRONEX_DISPATCHER_PORT", "8001")),
        fleet_port=int(_env("DRONEX_FLEET_PORT", "8002")),
        flight_port=int(_env("DRONEX_FLIGHT_PORT", "8003")),
        mailbox=_flag("DRONEX_MAILBOX", True),
        fleet_mailbox=_flag("DRONEX_FLEET_MAILBOX", False),
        flight_mailbox=_flag("DRONEX_FLIGHT_MAILBOX", False),
        payments=_flag("DRONEX_PAYMENTS", False),
        payments_ledger=_flag("DRONEX_PAYMENTS_LEDGER", False),
        flight_price_fet=_env("DRONEX_FLIGHT_PRICE_FET", "0.5"),
        data_dir=Path(_env("DRONEX_DATA_DIR", str(DATA_DIR))),
        sim_ui_url=_env("DRONEX_SIM_UI_URL", "http://127.0.0.1:45010").rstrip("/"),
        using_default_seeds=any(seeds[k] == DEFAULT_SEEDS[k] for k in seeds),
    )


def describe_missing(s: Settings) -> list[str]:
    """What is not configured, in the user's words, for the startup banner."""
    out: list[str] = []
    if not s.has_model:
        out.append("INTENT_API_KEY is not set: requests are parsed by rules, not by the ASI:One model (get a key at https://asi1.ai/dashboard/api-keys)")
    if s.using_default_seeds:
        out.append("DRONEX_*_SEED are not set: agent addresses use development seeds (fine locally; set your own for stable public addresses)")
    return out
