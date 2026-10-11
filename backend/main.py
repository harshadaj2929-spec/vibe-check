"""
Vibe Check — FastAPI Backend (v2)
Sentiment analysis agent pipeline for YouTube comments.
"""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import backend.analysis as analysis

# ──────────────────────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
log = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# Pydantic models
# ──────────────────────────────────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    url: str

class QARequest(BaseModel):
    question: str
    comments: list[str]  # passed from frontend cache (already fetched)

# ──────────────────────────────────────────────────────────────────────────────
# App lifespan — shared httpx client
# ──────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    analysis.http_client = httpx.AsyncClient(timeout=60.0)
    log.info("HTTP client initialised")
    yield
    await analysis.http_client.aclose()
    log.info("HTTP client closed")

# ──────────────────────────────────────────────────────────────────────────────
# App
# ──────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="Vibe Check", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────────────────

@app.post("/api/analyze")
async def analyze(req: AnalyzeRequest):
    """Main pipeline: LangGraph multi-agent analysis."""
    try:
        video_id = analysis.extract_video_id(req.url)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    log.info("Analyzing video: %s", video_id)

    from backend.graph import run_vibe_check_graph

    try:
        state = await run_vibe_check_graph(video_id)
    except Exception as exc:
        log.error("Graph execution failed: %s", exc)
        raise HTTPException(500, f"Analysis failed: {exc}")

    if "primary_analysis" not in state:
        raise HTTPException(
            500,
            f"Primary analysis could not complete. Errors: {state.get('errors', [])}",
        )

    agg = state["primary_analysis"]
    narrative = state.get("insight", "The AI narrative is temporarily unavailable.")
    comments = state.get("primary_comments", [])

    return {
        "video_id": video_id,
        "total_comments": agg.get("total", 0),
        "failed_count": agg.get("failed_count", 0),
        "counts": agg.get("counts", {}),
        "percentages": agg.get("percentages", {}),
        "sentiment_counts": agg.get("sentiment_counts", {}),
        "sentiment_percentages": agg.get("sentiment_percentages", {}),
        "flag_counts": agg.get("flag_counts", {}),
        "flag_percentages": agg.get("flag_percentages", {}),
        "vibe_score": agg.get("vibe_score", 0),
        "top_comments": agg.get("top_comments", {}),
        "narrative": narrative,  # top-level key, not nested
        "raw_comments": comments,
        "classified_comments": state.get("primary_classifications", []),
        "similar_video": state.get("similar_video"),
        "similar_analysis": state.get("similar_analysis"),
        "comparison": state.get("comparison"),
        "errors": state.get("errors", []),
    }


@app.get("/api/analyze/stream")
async def analyze_stream(url: str):
    """
    SSE endpoint: streams agent-step names as the graph progresses.
    Frontend listens and updates the stepper UI.
    Events: fetching | classifying | aggregating | insight | similar_video | comparing | done
    """
    try:
        video_id = analysis.extract_video_id(url)
    except ValueError as exc:
        async def _err():
            yield f"data: {{\"error\": \"{exc}\"}}\n\n"
        return StreamingResponse(_err(), media_type="text/event-stream")

    from backend.graph import run_vibe_check_graph

    queue: asyncio.Queue[str] = asyncio.Queue()

    async def run():
        try:
            await run_vibe_check_graph(video_id, status_queue=queue)
        finally:
            await queue.put("done")

    asyncio.create_task(run())

    async def event_generator():
        while True:
            step = await queue.get()
            yield f"data: {json.dumps({'step': step})}\n\n"
            if step == "done":
                break

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/api/qa")
async def qa(req: QARequest):
    """Q&A Agent — answer a follow-up question about a video's comments."""
    if not req.question.strip():
        raise HTTPException(400, "Question cannot be empty.")
    if not req.comments:
        raise HTTPException(400, "No comments provided for context.")

    try:
        answer = await analysis.run_qa_agent(req.question, req.comments)
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("QA agent failed: %s", exc)
        raise HTTPException(500, "Q&A agent encountered an error. Please try again.")

    return {"answer": answer}


@app.get("/api/health")
async def health():
    return {"status": "ok"}


# ──────────────────────────────────────────────────────────────────────────────
# Static frontend
# ──────────────────────────────────────────────────────────────────────────────

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

if os.path.isdir(FRONTEND_DIR):
    app.mount(
        "/static",
        StaticFiles(directory=os.path.join(FRONTEND_DIR, "static")),
        name="static",
    )

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        """Serve index.html for all non-API paths (SPA routing)."""
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
