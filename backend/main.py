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
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "")
GROQ_API_KEY    = os.environ.get("GROQ_API_KEY", "")

_missing = [k for k, v in {
    "YOUTUBE_API_KEY": YOUTUBE_API_KEY,
    "GROQ_API_KEY":    GROQ_API_KEY,
}.items() if not v]
if _missing:
    raise RuntimeError(f"Missing required environment variables: {', '.join(_missing)}")


GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "openai/gpt-oss-20b"

YOUTUBE_COMMENTS_URL = "https://www.googleapis.com/youtube/v3/commentThreads"
MAX_COMMENTS = 100               # limit for free tier Groq
GROQ_CLASSIFY_BATCH_SIZE = 15    # comments per Groq API call for classification

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


import json

async def classify_batch_groq(batch: list[str], semaphore: asyncio.Semaphore) -> list[dict]:
    """Call Groq to classify a batch of comments."""
    async with semaphore:
        for attempt in range(1, 3):
            system_prompt = (
                "You are a strict JSON-only sentiment classification API. "
                "Classify the sentiment of each input comment as exactly 'positive', 'negative', or 'neutral'. "
                "You must return ONLY a valid JSON object with a single key 'labels' containing a list of strings. "
                f"The 'labels' list MUST contain exactly {len(batch)} items, in the exact same order as the inputs."
            )
            if attempt > 1:
                system_prompt += " ERROR: Your previous response was invalid or had the wrong number of labels. YOU MUST RETURN EXACTLY VALID JSON AND EXACTLY THE RIGHT NUMBER OF LABELS."

            input_text = "Inputs to classify:\n"
            for i, c in enumerate(batch):
                input_text += f"{i+1}. {c}\n"

            payload = {
                "model": GROQ_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": input_text}
                ],
                "response_format": {"type": "json_object"},
                "temperature": 0.0
            }

            try:
                resp = await http_client.post(
                    GROQ_URL,
                    headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
                    json=payload,
                    timeout=45.0
                )
                resp.raise_for_status()
                data = resp.json()
                content = data["choices"][0]["message"]["content"]
                parsed = json.loads(content)
                labels = parsed.get("labels", [])

                if isinstance(labels, list) and len(labels) == len(batch):
                    valid_labels = {"positive", "negative", "neutral"}
                    out = []
                    for comment, label in zip(batch, labels):
                        lbl = str(label).strip().lower()
                        if lbl not in valid_labels:
                            lbl = "neutral"
                        out.append({"text": comment, "label": lbl, "score": 1.0})
                    return out
                else:
                    log.warning(f"Groq batch length mismatch. Expected {len(batch)}, got {len(labels) if isinstance(labels, list) else 'invalid'}. Retrying...")
            except Exception as e:
                log.warning(f"Groq batch exception: {e}. Retrying...")

        log.warning("Groq batch failed after retries. Skipping batch.")
        return []

async def classify_all(comments: list[str]) -> list[dict]:
    """Classify all comments using batched Groq API calls."""
    batches = [
        comments[i: i + GROQ_CLASSIFY_BATCH_SIZE]
        for i in range(0, len(comments), GROQ_CLASSIFY_BATCH_SIZE)
    ]
    log.info("Classifying %d comments in %d batches via Groq", len(comments), len(batches))

    # Limit concurrent Groq calls to avoid rate limits
    semaphore = asyncio.Semaphore(2)
    tasks = [classify_batch_groq(b, semaphore) for b in batches]
    batch_results = await asyncio.gather(*tasks)

    # Flatten and return only validly classified comments
    return [item for batch in batch_results for item in batch]



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
