"""Limits for a dispatcher that strangers reach from ASI:One (DEPLOY.md items 22 and 27).

Pure bookkeeping, no I/O: the dispatcher calls these with the current time and acts on the answer, so every limit
is testable without a running agent.

    RateLimiter    messages per sender per minute and per day
    ModelBudget    model calls per UTC day, across every sender; past the cap the rule parser answers
    ActiveFlights  one Dispatch vehicle per user, at most N in total, and when each vehicle is due to be stopped
    prune_index    which sessions have been idle longer than the cutoff
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

ModelCall = Callable[[str, str], Awaitable[str]]

MINUTE_S = 60.0
DAY_S = 86400.0


class RateLimiter:
    """At most `per_min` messages in any 60 s and `per_day` in any 24 h, per sender."""

    def __init__(self, per_min: int, per_day: int):
        self.per_min = per_min
        self.per_day = per_day
        self._hits: dict[str, deque[float]] = {}

    def check(self, sender: str, now: float | None = None) -> str | None:
        """Records the message and returns None when it is allowed; otherwise why not (the message is not counted)."""
        t = time.time() if now is None else now
        hits = self._hits.setdefault(sender, deque())
        while hits and hits[0] <= t - DAY_S:
            hits.popleft()
        if len(hits) >= self.per_day:
            return f"you have sent {self.per_day} messages today, which is the daily limit. Please come back tomorrow."
        last_minute = sum(1 for h in hits if h > t - MINUTE_S)
        if last_minute >= self.per_min:
            return f"that is more than {self.per_min} messages a minute. Please wait a minute and try again."
        hits.append(t)
        return None

    def prune(self, now: float | None = None) -> None:
        t = time.time() if now is None else now
        for sender in [k for k, v in self._hits.items() if not v or v[-1] <= t - DAY_S]:
            del self._hits[sender]


class BudgetExhausted(RuntimeError):
    pass


class ModelBudget:
    """A global cap on model calls per UTC day. A wrapped call past the cap raises, and parse_request falls back to
    the rule parser, so users still get answers; only the paid model stops."""

    def __init__(self, daily: int, clock: Callable[[], datetime] | None = None):
        self.daily = daily
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._day = ""
        self.used = 0

    def take(self) -> bool:
        day = self._clock().strftime("%Y-%m-%d")
        if day != self._day:
            self._day, self.used = day, 0
        if self.used >= self.daily:
            return False
        self.used += 1
        return True

    def wrap(self, model: ModelCall | None) -> ModelCall | None:
        if model is None:
            return None

        async def call(system: str, user: str) -> str:
            if not self.take():
                raise BudgetExhausted(f"the daily model budget ({self.daily} calls) is used up")
            return await model(system, user)

        return call


@dataclass
class ActiveFlight:
    user: str
    order_id: str
    created: float
    vehicle_id: str | None = None
    stop_at: float | None = None  # None while the flight agent has not reported a result
    stop_attempts: int = 0
    end_requested: bool = False


class ActiveFlights:
    """Every Dispatch vehicle that holds a slot, by ASI:One user. A slot is taken when the order goes out and freed
    when the vehicle is stopped (TTL after the result, at once after a failure, or when the user ends the flight).
    An order that never gets a result frees its slot after `pending_timeout_s`. JSON round-trips through agent
    storage so a restart still stops the vehicles it knew about."""

    def __init__(self, max_active: int, ttl_s: float, pending_timeout_s: float = 900.0, max_stop_attempts: int = 5):
        self.max_active = max_active
        self.ttl_s = ttl_s
        self.pending_timeout_s = pending_timeout_s
        self.max_stop_attempts = max_stop_attempts
        self.by_user: dict[str, ActiveFlight] = {}

    # -- admission ----------------------------------------------------------------------------------------------
    def refuse(self, user: str) -> str | None:
        mine = self.by_user.get(user)
        if mine is not None:
            if mine.vehicle_id:
                return f"you already have a drone in the simulator (vehicle {mine.vehicle_id[:8]}…). Say 'end flight' to stop it, or wait until it is stopped"
            return "your previous order is still being set up in the simulator; wait for it to finish"
        if len(self.by_user) >= self.max_active:
            return f"the simulator is busy with {len(self.by_user)} other flights right now (the limit is {self.max_active}). Please try again in a few minutes"
        return None

    def add(self, user: str, order_id: str, now: float | None = None) -> None:
        self.by_user[user] = ActiveFlight(user=user, order_id=order_id, created=time.time() if now is None else now)

    def user_for(self, order_id: str) -> str | None:
        return next((f.user for f in self.by_user.values() if f.order_id == order_id), None)

    # -- lifecycle -----------------------------------------------------------------------------------------------
    def on_result(self, order_id: str, ok: bool, vehicle_id: str | None, now: float | None = None) -> ActiveFlight | None:
        """The flight agent reported. A flying vehicle is stopped `ttl_s` later; a failed one with a vehicle at once;
        a failed one without a vehicle frees its slot now."""
        t = time.time() if now is None else now
        f = next((f for f in self.by_user.values() if f.order_id == order_id), None)
        if f is None:
            return None
        if not vehicle_id:
            del self.by_user[f.user]
            return f
        f.vehicle_id = vehicle_id
        f.stop_at = t + self.ttl_s if ok and not f.end_requested else t
        return f

    def end(self, user: str, now: float | None = None) -> ActiveFlight | None:
        """The user ended the flight (or the session): stop the vehicle at the next sweep."""
        f = self.by_user.get(user)
        if f is None:
            return None
        if not f.vehicle_id:
            f.end_requested = True  # still being set up: stop it as soon as the result brings the vehicle id
            return f
        f.stop_at = time.time() if now is None else now
        return f

    def due(self, now: float | None = None) -> tuple[list[ActiveFlight], list[ActiveFlight]]:
        """(vehicles to stop now, orders that never got a result and are dropped)."""
        t = time.time() if now is None else now
        stop = [f for f in self.by_user.values() if f.vehicle_id and f.stop_at is not None and f.stop_at <= t]
        stale = [f for f in self.by_user.values() if not f.vehicle_id and f.created <= t - self.pending_timeout_s]
        for f in stale:
            del self.by_user[f.user]
        return stop, stale

    def stopped(self, f: ActiveFlight) -> None:
        self.by_user.pop(f.user, None)

    def stop_failed(self, f: ActiveFlight, now: float | None = None) -> bool:
        """The stop route failed: try again in a minute, up to `max_stop_attempts`. False when giving up (the
        engine-side backstop has to clean it up)."""
        f.stop_attempts += 1
        if f.stop_attempts >= self.max_stop_attempts:
            self.by_user.pop(f.user, None)
            return False
        f.stop_at = (time.time() if now is None else now) + 60.0
        return True

    # -- storage -------------------------------------------------------------------------------------------------
    def to_json(self) -> list[dict[str, Any]]:
        return [asdict(f) for f in self.by_user.values()]

    def load_json(self, data: Any) -> None:
        self.by_user = {}
        for d in data if isinstance(data, list) else []:
            try:
                f = ActiveFlight(**d)
            except TypeError:
                continue
            self.by_user[f.user] = f


def prune_index(index: dict[str, float], max_age_s: float, now: float | None = None) -> list[str]:
    """Senders whose sessions were last touched more than `max_age_s` ago (removed from `index`)."""
    t = time.time() if now is None else now
    old = [k for k, ts in index.items() if not isinstance(ts, (int, float)) or ts <= t - max_age_s]
    for k in old:
        del index[k]
    return old
