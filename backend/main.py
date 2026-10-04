"""
Vibe Check — FastAPI Backend
Sentiment analysis agent pipeline for YouTube comments.
"""

import os
import re
import asyncio
import logging
from typing import Optional
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

# ──────────────────────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(levelname)s │ %(message)s")
log = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# Environment
# ──────────────────────────────────────────────────────────────────────────────
YOUTUBE_API_KEY = os.environ["YOUTUBE_API_KEY"]
HF_TOKEN = os.environ["HF_TOKEN"]
GROQ_API_KEY = os.environ["GROQ_API_KEY"]

HF_MODEL_URL = (
    "https://api-inference.huggingface.co/models/harshu2929/vibe-check-xlm-roberta"
)
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.1-8b-instant"

YOUTUBE_COMMENTS_URL = "https://www.googleapis.com/youtube/v3/commentThreads"
MAX_COMMENTS = 200

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

http_client: httpx.AsyncClient = None   # type: ignore

@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient(timeout=60.0)
    log.info("HTTP client initialised")
    yield
    await http_client.aclose()
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
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def extract_video_id(url: str) -> str:
    """Parse any YouTube URL format or bare video ID."""
    url = url.strip()
    # youtu.be/ID
    m = re.search(r"youtu\.be/([A-Za-z0-9_-]{11})", url)
    if m:
        return m.group(1)
    # youtube.com/watch?v=ID
    m = re.search(r"[?&]v=([A-Za-z0-9_-]{11})", url)
    if m:
        return m.group(1)
    # youtube.com/shorts/ID or embed/ID
    m = re.search(r"(?:shorts|embed)/([A-Za-z0-9_-]{11})", url)
    if m:
        return m.group(1)
    # Bare video ID
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", url):
        return url
    raise ValueError(f"Cannot extract video ID from: {url!r}")


async def fetch_comments(video_id: str) -> list[str]:
    """Fetch up to MAX_COMMENTS top-level comments from YouTube Data API v3."""
    comments: list[str] = []
    page_token: Optional[str] = None

    while len(comments) < MAX_COMMENTS:
        params = {
            "part": "snippet",
            "videoId": video_id,
            "maxResults": min(100, MAX_COMMENTS - len(comments)),
            "order": "relevance",
            "textFormat": "plainText",
            "key": YOUTUBE_API_KEY,
        }
        if page_token:
            params["pageToken"] = page_token

        resp = await http_client.get(YOUTUBE_COMMENTS_URL, params=params)

        if resp.status_code == 403:
            data = resp.json()
            reason = (
                data.get("error", {})
                    .get("errors", [{}])[0]
                    .get("reason", "unknown")
            )
            if reason == "commentsDisabled":
                raise HTTPException(400, "Comments are disabled for this video.")
            if reason == "quotaExceeded":
                raise HTTPException(429, "YouTube API quota exceeded. Try again tomorrow.")
            raise HTTPException(403, f"YouTube API error: {reason}")

        resp.raise_for_status()
        data = resp.json()

        for item in data.get("items", []):
            text = (
                item["snippet"]["topLevelComment"]["snippet"]["textDisplay"]
            )
            if text.strip():
                comments.append(text.strip())

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    if not comments:
        raise HTTPException(404, "No comments found for this video.")

    return comments


async def classify_comment(comment: str, semaphore: asyncio.Semaphore) -> dict:
    """Call HF Inference API for a single comment. Returns label + score."""
    async with semaphore:
        for attempt in range(3):
            try:
                resp = await http_client.post(
                    HF_MODEL_URL,
                    headers={"Authorization": f"Bearer {HF_TOKEN}"},
                    json={"inputs": comment},
                    timeout=30.0,
                )
                if resp.status_code == 503:
                    # Model loading — wait and retry
                    wait = resp.json().get("estimated_time", 20)
                    log.info("HF model loading, waiting %.0fs …", wait)
                    await asyncio.sleep(min(wait, 30))
                    continue
                resp.raise_for_status()
                result = resp.json()
                # HF returns [[{label, score}, ...]] for sequence classification
                if isinstance(result, list) and isinstance(result[0], list):
                    best = max(result[0], key=lambda x: x["score"])
                else:
                    best = max(result, key=lambda x: x["score"])
                return {"text": comment, "label": best["label"].lower(), "score": best["score"]}
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                if attempt == 2:
                    log.warning("HF classify failed after 3 attempts: %s", exc)
                    return {"text": comment, "label": "neutral", "score": 0.5}
                await asyncio.sleep(2 ** attempt)
        return {"text": comment, "label": "neutral", "score": 0.5}


async def classify_all(comments: list[str]) -> list[dict]:
    """Classify all comments concurrently with a semaphore to avoid rate limits."""
    semaphore = asyncio.Semaphore(5)   # max 5 concurrent HF calls
    tasks = [classify_comment(c, semaphore) for c in comments]
    return await asyncio.gather(*tasks)


def aggregate_results(classified: list[dict]) -> dict:
    """Build counts, percentages, vibe score, and top-3 per class."""
    counts = {"positive": 0, "neutral": 0, "negative": 0}
    buckets: dict[str, list[dict]] = {"positive": [], "neutral": [], "negative": []}

    for item in classified:
        label = item["label"]
        if label not in counts:
            label = "neutral"
        counts[label] += 1
        buckets[label].append(item)

    total = len(classified) or 1

    percentages = {k: round(v / total * 100, 1) for k, v in counts.items()}
    vibe_score = round((counts["positive"] - counts["negative"]) / total * 100)

    top: dict[str, list[str]] = {}
    for label, items in buckets.items():
        sorted_items = sorted(items, key=lambda x: x["score"], reverse=True)
        top[label] = [i["text"] for i in sorted_items[:3]]

    return {
        "counts": counts,
        "percentages": percentages,
        "vibe_score": vibe_score,
        "total": total,
        "top_comments": top,
    }


async def call_groq(messages: list[dict], max_tokens: int = 500) -> str:
    """Call Groq chat completions and return text content."""
    payload = {
        "model": GROQ_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.7,
    }
    resp = await http_client.post(
        GROQ_URL,
        headers={
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=30.0,
    )
    if resp.status_code == 429:
        raise HTTPException(429, "Groq rate limit hit. Please wait a moment and try again.")
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"].strip()


async def run_insight_agent(agg: dict) -> str:
    """Generate a human-readable narrative from aggregated sentiment data."""
    top = agg["top_comments"]

    def fmt_comments(label: str) -> str:
        items = top.get(label, [])
        if not items:
            return "  (none)"
        return "\n".join(f"  • {c[:200]}" for c in items)

    system = (
        "You are Vibe Check, an AI that reads YouTube comment sentiment data "
        "and writes a short, engaging narrative. "
        "Be conversational and honest. 2-4 sentences total. "
        "Use plain English — no bullet points, no headers. "
        "Don't start with 'Sure!' or 'Great!'. Go straight to the insight."
    )

    user = f"""Here is the sentiment analysis for a YouTube video ({agg['total']} comments analysed):

Positive: {agg['counts']['positive']} ({agg['percentages']['positive']}%)
Neutral: {agg['counts']['neutral']} ({agg['percentages']['neutral']}%)
Negative: {agg['counts']['negative']} ({agg['percentages']['negative']}%)
Vibe Score: {agg['vibe_score']} / 100

Top positive comments:
{fmt_comments('positive')}

Top neutral comments:
{fmt_comments('neutral')}

Top negative comments:
{fmt_comments('negative')}

Write a 2-4 sentence vibe summary. Mention what viewers liked, what they're unhappy about (if anything), and give an overall verdict."""

    return await call_groq([
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ], max_tokens=400)


async def run_qa_agent(question: str, comments: list[str]) -> str:
    """Answer a follow-up question using comments as context (simple RAG)."""
    # Take up to 80 comments as context (token budget)
    context_comments = comments[:80]
    context = "\n".join(f"- {c[:250]}" for c in context_comments)

    system = (
        "You are Vibe Check's Q&A assistant. "
        "You answer questions about a YouTube video's comment section. "
        "Base your answer strictly on the comments provided. "
        "Be concise (2-5 sentences). Conversational tone."
    )

    user = f"""Here are comments from the YouTube video:
{context}

User question: {question}

Answer based only on the comments above."""

    return await call_groq([
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ], max_tokens=350)


# ──────────────────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────────────────

@app.post("/api/analyze")
async def analyze(req: AnalyzeRequest):
    """Main pipeline: fetch → classify → aggregate → insight narrative."""
    # Step 1: Parse video ID
    try:
        video_id = extract_video_id(req.url)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    log.info("Analyzing video: %s", video_id)

    # Step 2: Fetch comments
    comments = await fetch_comments(video_id)
    log.info("Fetched %d comments", len(comments))

    # Step 3: Classify via HF Inference API
    classified = await classify_all(comments)
    log.info("Classified %d comments", len(classified))

    # Step 4: Aggregate
    agg = aggregate_results(classified)
    log.info("Vibe score: %d", agg["vibe_score"])

    # Step 5: Insight Agent (Groq)
    try:
        narrative = await run_insight_agent(agg)
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("Insight agent failed: %s", exc)
        narrative = "The AI narrative is temporarily unavailable. Check the sentiment breakdown above."

    return {
        "video_id": video_id,
        "total_comments": agg["total"],
        "counts": agg["counts"],
        "percentages": agg["percentages"],
        "vibe_score": agg["vibe_score"],
        "top_comments": agg["top_comments"],
        "narrative": narrative,
        "raw_comments": comments,   # returned for Q&A agent frontend cache
    }


@app.post("/api/qa")
async def qa(req: QARequest):
    """Q&A Agent — answer a follow-up question about a video's comments."""
    if not req.question.strip():
        raise HTTPException(400, "Question cannot be empty.")
    if not req.comments:
        raise HTTPException(400, "No comments provided for context.")

    try:
        answer = await run_qa_agent(req.question, req.comments)
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
