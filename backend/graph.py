"""
Vibe Check — LangGraph orchestration (v2)
-----------------------------------------
Real StateGraph with:
  - 6 named nodes
  - Proper parallel fan-out after aggregate_node (insight + Agent-2 branch)
  - Conditional edge: skip Agent-2 if no primary comments
  - Graceful partial failure: every node catches its own errors
  - In-memory cache keyed by video_id (TTL 10 min)
  - Status events via asyncio.Queue for SSE streaming
"""

from __future__ import annotations

import asyncio
import json
import logging
import operator
import time
from typing import Annotated, Any, Optional

from langgraph.graph import StateGraph, START, END
from typing_extensions import TypedDict

from backend.analysis import (
    fetch_comments,
    classify_all,
    aggregate_results,
    run_insight_agent,
    call_groq,
)
from backend.services import find_similar_video, fetch_video_comments

log = logging.getLogger("vibecheck.graph")

# ---------------------------------------------------------------------------
# In-memory result cache  (video_id → {result, ts})
# ---------------------------------------------------------------------------
_CACHE: dict[str, dict] = {}
_CACHE_TTL = 600  # seconds


def cache_get(video_id: str) -> Optional[dict]:
    entry = _CACHE.get(video_id)
    if entry and (time.time() - entry["ts"]) < _CACHE_TTL:
        log.info("Cache hit for %s", video_id)
        return entry["result"]
    return None


def cache_set(video_id: str, result: dict) -> None:
    _CACHE[video_id] = {"result": result, "ts": time.time()}


# ---------------------------------------------------------------------------
# Shared typed state
# ---------------------------------------------------------------------------
class VibeCheckState(TypedDict, total=False):
    video_id: str
    status_queue: Any  # asyncio.Queue[str] | None – for SSE

    primary_comments: list[str]
    primary_classifications: list[dict]
    primary_analysis: dict

    insight: str

    similar_video: dict
    similar_analysis: dict

    comparison: dict

    # Append-only list of non-fatal error messages
    errors: Annotated[list[str], operator.add]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def _emit(state: VibeCheckState, msg: str) -> None:
    q: asyncio.Queue | None = state.get("status_queue")
    if q is not None:
        await q.put(msg)


# ---------------------------------------------------------------------------
# Node 1: fetch_comments_node
# ---------------------------------------------------------------------------
async def fetch_comments_node(state: VibeCheckState) -> dict:
    video_id = state.get("video_id", "")
    await _emit(state, "fetching")
    try:
        comments = await fetch_comments(video_id)
        if not comments:
            return {"errors": ["No comments found on primary video."]}
        log.info("Fetched %d comments for %s", len(comments), video_id)
        return {"primary_comments": comments}
    except Exception as exc:
        log.warning("fetch_comments_node error: %s", exc)
        return {"errors": [f"Fetch failed: {exc}"]}


# ---------------------------------------------------------------------------
# Node 2: classify_node  (Agent 1 — Deep Classifier)
# ---------------------------------------------------------------------------
async def classify_node(state: VibeCheckState) -> dict:
    comments = state.get("primary_comments")
    if not comments:
        return {"errors": ["classify_node skipped: no comments."]}
    await _emit(state, "classifying")
    try:
        classified = await classify_all(comments)
        return {"primary_classifications": classified}
    except Exception as exc:
        log.warning("classify_node error: %s", exc)
        return {"errors": [f"Classification failed: {exc}"]}


# ---------------------------------------------------------------------------
# Node 3: aggregate_node
# ---------------------------------------------------------------------------
async def aggregate_node(state: VibeCheckState) -> dict:
    classified = state.get("primary_classifications")
    if not classified:
        return {"errors": ["aggregate_node skipped: no classifications."]}
    await _emit(state, "aggregating")
    try:
        agg = aggregate_results(classified)
        return {"primary_analysis": agg}
    except Exception as exc:
        log.warning("aggregate_node error: %s", exc)
        return {"errors": [f"Aggregation failed: {exc}"]}


# ---------------------------------------------------------------------------
# Node 4: narrative_node  (Insight Agent)
# ---------------------------------------------------------------------------
async def narrative_node(state: VibeCheckState) -> dict:
    agg = state.get("primary_analysis")
    if not agg:
        return {"errors": ["narrative_node skipped: no primary analysis."]}
    await _emit(state, "insight")
    try:
        narrative = await run_insight_agent(agg)
        return {"insight": narrative}
    except Exception as exc:
        log.warning("narrative_node error: %s", exc)
        return {
            "insight": "AI narrative temporarily unavailable.",
            "errors": [f"Insight agent failed: {exc}"],
        }


# ---------------------------------------------------------------------------
# Node 5a: find_similar_node  (start of Agent 2 branch)
# ---------------------------------------------------------------------------
async def find_similar_node(state: VibeCheckState) -> dict:
    video_id = state.get("video_id", "")
    await _emit(state, "similar_video")
    try:
        res = await find_similar_video(video_id)
        if res.get("status") != "success":
            return {"errors": [f"Similar video: {res.get('error', 'not found')}"]}
        return {"similar_video": res["similar_video"]}
    except Exception as exc:
        log.warning("find_similar_node error: %s", exc)
        return {"errors": [f"find_similar failed: {exc}"]}


# ---------------------------------------------------------------------------
# Node 5b: classify_similar_node  (fetch + reuse Agent 1)
# ---------------------------------------------------------------------------
async def classify_similar_node(state: VibeCheckState) -> dict:
    sim = state.get("similar_video")
    if not sim:
        return {"errors": ["classify_similar skipped: no similar video."]}

    sim_id = sim.get("video_id", "")
    try:
        # Fetch – cap at 25 comments, truncate to 300 chars each
        cr = await fetch_video_comments(sim_id, max_comments=25)
        if cr.get("status") != "success" or not cr.get("comments"):
            return {"errors": [f"Similar video comments unavailable: {cr.get('error')}"]}

        raw = [c[:300] for c in cr["comments"]]
        classified = await classify_all(raw)
        agg = aggregate_results(classified)

        return {
            "similar_analysis": {
                "sentiment_counts": agg.get("sentiment_counts", {}),
                "sentiment_percentages": agg.get("sentiment_percentages", {}),
                "flag_counts": agg.get("flag_counts", {}),
                "flag_percentages": agg.get("flag_percentages", {}),
                "total": agg.get("total", 0),
                "failed_count": agg.get("failed_count", 0),
                "top_comments": agg.get("top_comments", {}),
                "vibe_score": agg.get("vibe_score", 0),
            }
        }
    except Exception as exc:
        log.warning("classify_similar_node error: %s", exc)
        return {"errors": [f"Similar classification failed: {exc}"]}


# ---------------------------------------------------------------------------
# Node 5c: compare_node  (Comparison Agent)
# ---------------------------------------------------------------------------
async def compare_node(state: VibeCheckState) -> dict:
    await _emit(state, "comparing")
    primary = state.get("primary_analysis")
    similar = state.get("similar_analysis")

    if not primary or not similar:
        return {
            "comparison": {
                "status": "partial",
                "summary": "Comparison unavailable — no similar video was found.",
                "winner": None,
                "reason": None,
                "sentiment_comparison": None,
                "vibe_comparison": None,
            }
        }

    p_sent = primary.get("sentiment_percentages", {})
    s_sent = similar.get("sentiment_percentages", {})
    p_flag = primary.get("flag_percentages", {})
    s_flag = similar.get("flag_percentages", {})
    p_vibe = primary.get("vibe_score", 0)
    s_vibe = similar.get("vibe_score", 0)

    base: dict[str, Any] = {
        "status": "success",
        "sentiment_comparison": {"primary": p_sent, "similar": s_sent},
        "safety_comparison": {"primary": p_flag, "similar": s_flag},
        "vibe_comparison": {
            "primary": p_vibe,
            "similar": s_vibe,
            "difference": p_vibe - s_vibe,
        },
    }

    # LLM narrative
    system = (
        "You are Vibe Check's Comparison Analyzer. "
        "Given sentiment statistics for two YouTube videos, respond with ONLY valid JSON:\n"
        '{"summary": "2-3 sentences comparing both videos", '
        '"winner": "primary|similar|tie", '
        '"reason": "one short sentence"}'
    )
    user = f"Primary vs Similar:\n{json.dumps(base, indent=2)}"

    try:
        raw = await call_groq(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            max_tokens=400,
        )
        # Strip markdown fences if present
        cleaned = raw.strip()
        if "```" in cleaned:
            cleaned = cleaned.split("```")[1]
            if cleaned.startswith("json"):
                cleaned = cleaned[4:]
        llm = json.loads(cleaned)
        base["summary"] = llm.get("summary", "")
        base["winner"] = llm.get("winner", "tie")
        base["reason"] = llm.get("reason", "")
    except Exception as exc:
        log.warning("compare_node LLM failed: %s — using deterministic fallback", exc)
        diff = p_vibe - s_vibe
        base["status"] = "partial"
        base["winner"] = "primary" if diff > 0 else ("similar" if diff < 0 else "tie")
        base["summary"] = (
            "The primary and similar videos show different audience sentiment patterns."
        )
        base["reason"] = "Deterministic fallback used (AI rate-limited)."
        base["errors"] = [str(exc)]

    return {"comparison": base}


# ---------------------------------------------------------------------------
# Conditional routing after fetch
# ---------------------------------------------------------------------------
def should_classify(state: VibeCheckState) -> str:
    if state.get("primary_comments"):
        return "classify"
    return END  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Build the graph
# ---------------------------------------------------------------------------
def build_graph() -> Any:
    b = StateGraph(VibeCheckState)

    b.add_node("fetch", fetch_comments_node)
    b.add_node("classify", classify_node)
    b.add_node("aggregate", aggregate_node)
    b.add_node("narrative", narrative_node)
    b.add_node("find_similar", find_similar_node)
    b.add_node("classify_similar", classify_similar_node)
    b.add_node("compare", compare_node)

    b.add_edge(START, "fetch")

    # Conditional: only classify if we have comments
    b.add_conditional_edges("fetch", should_classify, {"classify": "classify", END: END})

    b.add_edge("classify", "aggregate")

    # Fan-out after aggregate: narrative + Agent-2 branch in parallel
    b.add_edge("aggregate", "narrative")
    b.add_edge("aggregate", "find_similar")

    # Agent-2 sequential sub-chain
    b.add_edge("find_similar", "classify_similar")
    b.add_edge("classify_similar", "compare")

    # Narrative also feeds compare (compare waits for both branches)
    b.add_edge("narrative", "compare")

    b.add_edge("compare", END)

    return b.compile()


# Singleton graph (built once)
_GRAPH = None


def get_graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_graph()
    return _GRAPH


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
async def run_vibe_check_graph(
    video_id: str,
    status_queue: "asyncio.Queue[str] | None" = None,
) -> dict:
    cached = cache_get(video_id)
    if cached:
        if status_queue:
            for step in ["fetching", "classifying", "aggregating", "insight", "similar_video", "comparing"]:
                await status_queue.put(step)
        return cached

    graph = get_graph()
    state: VibeCheckState = {"video_id": video_id}
    if status_queue is not None:
        state["status_queue"] = status_queue

    final = await graph.ainvoke(state)
    # Remove the queue from cached state
    final.pop("status_queue", None)
    cache_set(video_id, final)
    return final