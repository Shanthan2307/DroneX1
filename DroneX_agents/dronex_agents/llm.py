"""The ASI:One model (or any OpenAI-compatible endpoint), used for two things only: turning the user's words into
a structured request, and phrasing a short reply. Verdicts, candidates and flights are code."""

from __future__ import annotations

from typing import Awaitable, Callable

from .config import Settings

ModelCall = Callable[[str, str], Awaitable[str]]


def make_model_call(s: Settings) -> ModelCall | None:
    if not s.has_model:
        return None
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=s.intent_api_key, base_url=s.intent_api_base)

    async def call(system: str, user: str) -> str:
        r = await client.chat.completions.create(
            model=s.intent_model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.1,
            max_tokens=400,
        )
        return (r.choices[0].message.content or "").strip()

    return call
