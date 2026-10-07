"""
Vibe Check — FastAPI Backend
Sentiment analysis agent pipeline for YouTube comments.
"""

import os
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

import backend.analysis as analysis

# ──────────────────────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(levelname)s │ %(message)s")
log = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# Pydantic models
# ──────────────────────────────────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    url: str

class QARequest(BaseModel):
    video_id: str
    question: str
    comments: list[str]          # passed from frontend cache (already fetched)

# ──────────────────────────────────────────────────────────────────────────────
# App lifespan — shared httpx client
# ──────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    analysis.http_client = httpx.AsyncClient(timeout=60.0)
    log.info("HTTP client initialised in analysis module")
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
    """Main pipeline: fetch + classify + aggregate + insight narrative."""
    try:
        video_id = analysis.extract_video_id(req.url)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    log.info("Analyzing video: %s", video_id)

    from backend.graph import run_vibe_check_graph

    try:
        state = await run_vibe_check_graph(video_id)
        if "primary_analysis" not in state:
            raise RuntimeError(f"LangGraph failed to produce primary analysis. Errors: {state.get('errors')}")

        agg = state["primary_analysis"]
        narrative = state.get("insight", "The AI narrative is temporarily unavailable.")
        comments = state.get("primary_comments", [])

        return {
            "video_id": video_id,
            "total_comments": agg["total"],
            "failed_count": agg.get("failed_count", 0),
            
            "counts": agg["counts"],
            "percentages": agg["percentages"],
            "sentiment_counts": agg.get("sentiment_counts", {}),
            "sentiment_percentages": agg.get("sentiment_percentages", {}),
            "flag_counts": agg.get("flag_counts", {}),
            "flag_percentages": agg.get("flag_percentages", {}),
            
            "vibe_score": agg["vibe_score"],
            "top_comments": agg["top_comments"],
            "narrative": narrative,
            "raw_comments": comments,   # returned for Q&A agent frontend cache
            
            "similar_video": state.get("similar_video"),
            "similar_analysis": state.get("similar_analysis"),
            "comparison": state.get("comparison"),
            "errors": state.get("errors", [])
        }
    except Exception as exc:
        log.warning("LangGraph execution failed, falling back to linear analysis: %s", exc)
        try:
            comments = await analysis.fetch_comments(video_id)
            classified = await analysis.classify_all(comments)
            agg = analysis.aggregate_results(classified)

            try:
                narrative = await analysis.run_insight_agent(agg)
            except Exception as e:
                log.warning("Insight agent failed: %s", e)
                narrative = "The AI narrative is temporarily unavailable."

            return {
                "video_id": video_id,
                "total_comments": agg["total"],
                "failed_count": agg.get("failed_count", 0),
                "counts": agg["counts"],
                "percentages": agg["percentages"],
                "sentiment_counts": agg.get("sentiment_counts", {}),
                "sentiment_percentages": agg.get("sentiment_percentages", {}),
                "flag_counts": agg.get("flag_counts", {}),
                "flag_percentages": agg.get("flag_percentages", {}),
                "vibe_score": agg["vibe_score"],
                "top_comments": agg["top_comments"],
                "narrative": narrative,
                "raw_comments": comments,
            }
        except HTTPException:
            raise
        except Exception as fallback_exc:
            raise HTTPException(500, f"Analysis failed: {fallback_exc}")

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
# Static frontend — serve from /frontend/static
# ──────────────────────────────────────────────────────────────────────────────

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

if os.path.isdir(FRONTEND_DIR):
    app.mount(
        "/static",
        StaticFiles(directory=os.path.join(FRONTEND_DIR, "static")),
        name="static",
    )

    @app.get("/", include_in_schema=False)
    async def serve_index():
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
