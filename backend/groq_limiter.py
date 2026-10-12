"""
backend/groq_limiter.py
-----------------------
Single shared asyncio.Semaphore(1) for ALL Groq LLM calls across the app.
Import and use via:

    from backend.groq_limiter import groq_sem
    async with groq_sem():
        ...

Using one semaphore ensures the narrative branch and the Agent-2 classify
branch never hit Groq simultaneously, preventing 429s on the free tier.
"""
import asyncio

_SEM: asyncio.Semaphore | None = None


def groq_sem() -> asyncio.Semaphore:
    """Return the process-wide Groq semaphore (lazy-init, event-loop-safe)."""
    global _SEM
    if _SEM is None:
        _SEM = asyncio.Semaphore(1)
    return _SEM
