"""
Shared analysis module for Vibe Check.
"""
import os
import re
import json
import asyncio
import logging
from typing import Optional

import httpx
from fastapi import HTTPException

log = logging.getLogger(__name__)

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
MAX_COMMENTS = 50
GROQ_CLASSIFY_BATCH_SIZE = int(os.environ.get("GROQ_CLASSIFY_BATCH_SIZE", "5"))

http_client: httpx.AsyncClient = None  # Will be set by main.py lifespan or test scripts

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
                "You are a strict JSON-only classifier. "
                "Classify each input comment on the following dimensions.\n\n"
                "1. 'sentiment': exactly 'positive', 'negative', or 'neutral'.\n"
                "2. 'flag': exactly 'hate', 'good', 'bad', or 'none'.\n"
                "3. 'mixed': boolean (true or false). Set to true ONLY if the comment contains multiple meaningful or conflicting signals (e.g. positive toward the video but hateful toward a person, or mixed positive/negative sentiments).\n"
                "4. 'confidence': float between 0.0 and 1.0 representing your confidence.\n"
                "5. 'evidence': A list of objects with 'text' and 'type'. For difficult or mixed comments, extract concise verbatim substrings from the original comment as evidence. For simple comments, you can return an empty list. The 'text' must be an EXACT substring of the input comment. 'type' should describe what the evidence supports.\n"
                "6. 'reason': A short explanation string of your classification.\n\n"
                "Flag Priority:\n"
                " - hate: targeted harassment, slurs, threats, abusive attacks.\n"
                " - good: substantive praise, constructive criticism, useful discussion.\n"
                " - bad: spam, promotional, irrelevant links, low quality.\n"
                " - none: no special flag applies.\n\n"
                "Rule: Negative sentiment is NOT automatically hate. Constructive criticism can be negative + good. "
                "Spam is bad. DO NOT classify merely based on keywords like 'hate' if the context does not support it (e.g. 'explaining hate speech' is not 'hate' flag).\n\n"
                "You must return ONLY a valid JSON object with a single key 'results' containing a list of objects. "
                f"The 'results' list MUST contain exactly {len(batch)} items in the exact same order as inputs.\n"
                "Schema per item: {\"sentiment\": \"...\", \"flag\": \"...\", \"mixed\": true/false, \"confidence\": 0.9, \"evidence\": [{\"text\": \"...\", \"type\": \"...\"}], \"reason\": \"...\"}"
            )
            if attempt > 1:
                system_prompt += "\nERROR: Your previous response was invalid. YOU MUST RETURN EXACTLY VALID JSON AND EXACTLY THE RIGHT NUMBER OF RESULTS WITH STRICT TYPING AND EXACT SUBSTRINGS FOR EVIDENCE."

            input_text = "Inputs to classify:\n"
            for i, c in enumerate(batch):
                trunc_c = c[:300] + "..." if len(c) > 300 else c
                input_text += f"{i+1}. {trunc_c}\n"

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
                if resp.status_code == 429:
                    if attempt == 2:
                        log.error("Groq API 429 rate limit hit on final attempt. Failing batch.")
                        return [{"text": c, "status": "error", "error": "Groq rate limit (429) exceeded."} for c in batch]
                    
                    wait_s = 8.0
                    if "Retry-After" in resp.headers:
                        try:
                            wait_s = float(resp.headers["Retry-After"]) + 1.0
                        except:
                            pass
                    else:
                        try:
                            err_data = resp.json()
                            msg = err_data.get("error", {}).get("message", "")
                            import re as _re
                            m = _re.search(r'in ([0-9.]+)s', msg)
                            if m:
                                wait_s = float(m.group(1)) + 1.0
                        except:
                            pass
                    log.warning(f"Groq 429 hit. Waiting {wait_s:.1f}s before retry...")
                    await asyncio.sleep(wait_s)
                    continue

                if not resp.is_success:
                    log.error(f"Groq API error {resp.status_code} in batch: {resp.text}")
                    resp.raise_for_status()
                    
                data = resp.json()
                content = data["choices"][0]["message"]["content"]
                parsed = json.loads(content)
                results = parsed.get("results", [])

                if isinstance(results, list) and len(results) == len(batch):
                    valid_sentiments = {"positive", "negative", "neutral"}
                    valid_flags = {"hate", "good", "bad", "none"}
                    out = []
                    
                    batch_valid = True
                    for comment, res in zip(batch, results):
                        if not isinstance(res, dict):
                            res = {}
                        
                        s_raw = str(res.get("sentiment", "")).strip().lower()
                        f_raw = str(res.get("flag", "")).strip().lower()
                        mixed = res.get("mixed")
                        confidence = res.get("confidence")
                        evidence = res.get("evidence", [])
                        
                        is_item_valid = True
                        if s_raw not in valid_sentiments or f_raw not in valid_flags:
                            is_item_valid = False
                        elif not isinstance(mixed, bool):
                            is_item_valid = False
                        elif not (isinstance(confidence, (int, float)) and 0.0 <= confidence <= 1.0):
                            is_item_valid = False
                        elif not isinstance(evidence, list):
                            is_item_valid = False
                        else:
                            for ev in evidence:
                                if not isinstance(ev, dict) or "text" not in ev or "type" not in ev:
                                    is_item_valid = False
                                    break
                                ev_text = str(ev.get("text", "")).strip()
                                if ev_text and ev_text.lower() not in comment.lower():
                                    is_item_valid = False
                                    break
                        
                        if not is_item_valid:
                            batch_valid = False
                            out.append({
                                "text": comment,
                                "status": "error",
                                "error": "Validation failed for comment classification format."
                            })
                        else:
                            out.append({
                                "text": comment,
                                "label": s_raw, # backward compat
                                "sentiment": s_raw,
                                "flag": f_raw,
                                "mixed": mixed,
                                "confidence": float(confidence),
                                "evidence": evidence,
                                "reason": str(res.get("reason", "")),
                                "score": 1.0,
                                "status": "success"
                            })
                            
                    if batch_valid:
                        return out
                    else:
                        if attempt == 2:
                            return out
                        log.warning("Groq batch validation failed. Retrying...")
                else:
                    log.warning(f"Groq batch length mismatch. Retrying...")
            except Exception as e:
                log.warning(f"Groq batch exception: {e}. Retrying...")

        log.warning("Groq batch failed after retries. Skipping batch.")
        return [{"text": c, "status": "error", "error": "Batch classification failed after retries"} for c in batch]


async def classify_all(comments: list[str]) -> list[dict]:
    """Classify all comments using batched Groq API calls."""
    batches = [
        comments[i: i + GROQ_CLASSIFY_BATCH_SIZE]
        for i in range(0, len(comments), GROQ_CLASSIFY_BATCH_SIZE)
    ]
    log.info("Classifying %d comments in %d batches via Groq", len(comments), len(batches))

    # Limit concurrent Groq calls to avoid rate limits
    semaphore = asyncio.Semaphore(1)  # Reduced concurrency for reliability (Groq 429)
    tasks = [classify_batch_groq(b, semaphore) for b in batches]
    batch_results = await asyncio.gather(*tasks)

    # Flatten and return only validly classified comments
    return [item for batch in batch_results for item in batch]



def aggregate_results(classified: list[dict]) -> dict:
    """Build counts, percentages, vibe score, and top-3 per class."""
    valid_items = []
    failed_count = 0
    valid_sentiments = {"positive", "negative", "neutral"}
    valid_flags = {"hate", "good", "bad", "none"}

    for item in classified:
        if item.get("status", "success") != "success":
            failed_count += 1
            continue
            
        s = item.get("sentiment")
        f = item.get("flag")
        
        if s not in valid_sentiments or f not in valid_flags:
            # Missing or invalid inner fields are treated as classification failures
            failed_count += 1
            continue
            
        valid_items.append(item)

    s_counts = {"positive": 0, "neutral": 0, "negative": 0}
    f_counts = {"hate": 0, "good": 0, "bad": 0, "none": 0}
    buckets: dict[str, list[dict]] = {"positive": [], "neutral": [], "negative": []}

    for item in valid_items:
        # Sentiment aggregation
        s = item["sentiment"]
        s_counts[s] += 1
        buckets[s].append(item)
        
        # Flag aggregation
        f = item["flag"]
        f_counts[f] += 1

    total_valid = len(valid_items)

    if total_valid == 0:
        s_percentages = {"positive": 0.0, "neutral": 0.0, "negative": 0.0}
        f_percentages = {"hate": 0.0, "good": 0.0, "bad": 0.0, "none": 0.0}
        vibe_score = 0
    else:
        s_percentages = {k: round(v / total_valid * 100, 1) for k, v in s_counts.items()}
        f_percentages = {k: round(v / total_valid * 100, 1) for k, v in f_counts.items()}
        vibe_score = round((s_counts["positive"] - s_counts["negative"]) / total_valid * 100)

    top: dict[str, list[str]] = {}
    for label, items in buckets.items():
        sorted_items = sorted(items, key=lambda x: x.get("score", 0.0), reverse=True)
        top[label] = [i["text"] for i in sorted_items[:3]]

    return {
        # Backward compatibility for existing UI and Insight Agent
        "counts": s_counts,
        "percentages": s_percentages,
        "vibe_score": vibe_score,
        "total": total_valid,
        "failed_count": failed_count,
        "top_comments": top,
        
        # New independent dimensional stats
        "sentiment_counts": s_counts,
        "sentiment_percentages": s_percentages,
        "flag_counts": f_counts,
        "flag_percentages": f_percentages,
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
        log.warning(f"Groq 429 limit hit. Body: {resp.text}")
        raise HTTPException(429, "Groq rate limit hit. Please wait a moment and try again.")
    if not resp.is_success:
        log.error(f"Groq API error {resp.status_code}: {resp.text}")
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
