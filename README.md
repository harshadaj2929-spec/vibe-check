---
title: Vibe Check
emoji: 🎛️
colorFrom: purple
colorTo: indigo
sdk: docker
pinned: false
license: mit
---

# Vibe Check ◈ YouTube Comment Sentiment Analyser

**Vibe Check** is a full-stack agentic app that fetches a YouTube video's comments, classifies their sentiment using a fine-tuned multilingual transformer (xlm-roberta), and generates a human-readable narrative using a Groq LLM agent. Users can also ask follow-up questions about the comment section via a built-in RAG Q&A agent.

---

## Features

| Feature | Detail |
|---|---|
| **Sentiment Classifier** | xlm-roberta-base fine-tuned on Hindi/English/Gujarati YouTube comments, called via HF Inference API |
| **Insight Agent** | Groq `llama-3.1-8b-instant` — generates a 2-4 sentence narrative summary |
| **Q&A Agent** | RAG-style — pass question + comments to Groq, get an answer grounded in the comments |
| **Visual** | Animated arc gauge, live EQ bars, typewriter narrative, dark theme |
| **Multilingual** | Works on Hindi/English/Gujarati code-mixed comments |

---

## Setup (Local Development)

### 1. Clone the repo
```bash
git clone https://huggingface.co/spaces/<YOUR_HF_USERNAME>/vibe-check
cd vibe-check
```

### 2. Install dependencies
```bash
pip install -r backend/requirements.txt
```

### 3. Set environment variables

Create a `.env` file in the project root (never commit this):

```
YOUTUBE_API_KEY=your_youtube_data_api_v3_key
HF_TOKEN=your_huggingface_access_token
GROQ_API_KEY=your_groq_api_key
```

Then load it before running:
```bash
# On Linux/macOS
export $(cat .env | xargs)

# On Windows PowerShell
Get-Content .env | ForEach-Object { $parts = $_ -split '=', 2; [System.Environment]::SetEnvironmentVariable($parts[0], $parts[1]) }
```

### 4. Run the backend
```bash
uvicorn backend.main:app --reload --port 8000
```

Open `http://localhost:8000` — the frontend is served automatically.

---

## Deployment on Hugging Face Spaces (Free, ~10 min)

### Step 1 — Create the Space

1. Go to [huggingface.co/new-space](https://huggingface.co/new-space)
2. Choose:
   - **Space name**: `vibe-check`
   - **SDK**: Docker
   - **Visibility**: Public
3. Click **Create Space**

### Step 2 — Add secrets

In your Space → **Settings → Variables and Secrets**, add:

| Secret name | Value |
|---|---|
| `YOUTUBE_API_KEY` | Your YouTube Data API v3 key |
| `HF_TOKEN` | Your Hugging Face access token |
| `GROQ_API_KEY` | Your Groq API key |

> ⚠️ Use the **Secrets** section (not Variables) — secrets are never exposed in logs.

### Step 3 — Push the code

```bash
# If not already a git repo
git init
git add .
git commit -m "Initial commit"

# Add HF Spaces as remote
git remote add space https://huggingface.co/spaces/<YOUR_HF_USERNAME>/vibe-check

# Push (use your HF token as the password)
git push space main
```

The Space will build and deploy automatically. Check **Logs** for build status. First build takes ~3-5 minutes.

### Step 4 — Access

Your app will be live at: `https://<YOUR_HF_USERNAME>-vibe-check.hf.space`

---

## Architecture

```
User Browser
     │
     ▼
FastAPI (backend/main.py)          serves /static/* + index.html
     │
     ├── GET /api/health
     │
     ├── POST /api/analyze
     │     ├── YouTube Data API v3  (fetch comments)
     │     ├── HF Inference API     (xlm-roberta classify, concurrency=5)
     │     └── Groq API             (insight narrative)
     │
     └── POST /api/qa
           └── Groq API             (RAG Q&A with comments as context)
```

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `YOUTUBE_API_KEY` | ✅ | YouTube Data API v3 key |
| `HF_TOKEN` | ✅ | Hugging Face token (for Inference API) |
| `GROQ_API_KEY` | ✅ | Groq API key (free tier works) |

---

## Error Handling

| Scenario | Response |
|---|---|
| Comments disabled | `400 Comments are disabled for this video.` |
| YouTube quota exceeded | `429 YouTube API quota exceeded. Try again tomorrow.` |
| HF model cold start | Automatic retry with wait (up to 30s) |
| Groq rate limit | `429 Groq rate limit hit. Please wait a moment.` |
| Invalid YouTube URL | `400 Cannot extract video ID from: …` |
| No comments found | `404 No comments found for this video.` |

---

## Model

**harshu2929/vibe-check-xlm-roberta** — 3-class sentiment classifier:
- Base: `xlm-roberta-base`
- Labels: `positive`, `neutral`, `negative`
- Training data: Hindi-English-Gujarati code-mixed YouTube comments
- Inference: Hugging Face Inference API (no local loading)
