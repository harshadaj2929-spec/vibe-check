import os
import re
import httpx
from typing import Dict, Any

YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "")

STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", 
    "with", "is", "are", "this", "that", "how", "what", "why", 
    "from", "by", "vs", "video", "official", "new"
}

def tokenize(text: str) -> set:
    """Extract meaningful lowercase alphanumeric tokens."""
    if not text:
        return set()
    words = re.findall(r'[a-z0-9]+', text.lower())
    return {w for w in words if w not in STOPWORDS}

def score_candidate(orig_title_tokens: set, orig_tag_tokens: set, c_title: str) -> dict:
    """
    Calculates deterministic similarity score.
    Returns dict with score and intersection count for tie-breaking.
    """
    c_tokens = tokenize(c_title)
    if not c_tokens:
        return {"score": 0.0, "intersection": 0}
        
    title_intersection = orig_title_tokens.intersection(c_tokens)
    tag_intersection = orig_tag_tokens.intersection(c_tokens)
    
    union_len = len(orig_title_tokens.union(c_tokens))
    
    # Base score: Title Jaccard similarity
    title_score = len(title_intersection) / union_len if union_len > 0 else 0.0
    
    # Tag boost: percentage of candidate tokens that match original tags
    tag_score = len(tag_intersection) / len(c_tokens) if c_tokens else 0.0
    
    # Total score (tags are secondary to title overlap)
    total_score = title_score + (0.3 * tag_score)
    
    return {
        "score": total_score,
        "intersection": len(title_intersection)
    }

async def find_similar_video(video_id: str) -> Dict[str, Any]:
    """
    Fetch metadata for a given YouTube video and find one similar video.
    Returns a dictionary with status, original_video, and similar_video details.
    """
    if not YOUTUBE_API_KEY:
        return {"status": "error", "error": "YouTube API key not configured"}
        
    videos_url = "https://www.googleapis.com/youtube/v3/videos"
    search_url = "https://www.googleapis.com/youtube/v3/search"
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        # 1. Fetch current video metadata
        vid_params = {
            "part": "snippet",
            "id": video_id,
            "key": YOUTUBE_API_KEY
        }
        try:
            vid_resp = await client.get(videos_url, params=vid_params)
            vid_resp.raise_for_status()
            vid_data = vid_resp.json()
        except Exception as e:
            return {"status": "error", "error": f"Failed to fetch original video metadata: {str(e)}"}
            
        items = vid_data.get("items", [])
        if not items:
            return {"status": "error", "error": "Original video not found or is private"}
            
        snippet = items[0].get("snippet", {})
        orig_title = snippet.get("title", "")
        orig_channel = snippet.get("channelTitle", "")
        orig_tags = snippet.get("tags", [])
        
        if not orig_title:
            return {"status": "error", "error": "Original video missing title"}
            
        original_video_info = {
            "video_id": video_id,
            "title": orig_title,
            "channel_title": orig_channel
        }
        
        # 2. Construct search query
        query_parts = [orig_title]
        if orig_tags:
            query_parts.extend(orig_tags[:3])
            
        search_query = " ".join(query_parts)
        search_query = search_query[:450]
        
        search_params = {
            "part": "snippet",
            "q": search_query,
            "type": "video",
            "maxResults": 10,
            "key": YOUTUBE_API_KEY
        }
        
        try:
            search_resp = await client.get(search_url, params=search_params)
            search_resp.raise_for_status()
            search_data = search_resp.json()
        except Exception as e:
            return {"status": "error", "error": f"YouTube search API failed: {str(e)}"}
            
        search_items = search_data.get("items", [])
        if not search_items:
            return {"status": "error", "error": "No sufficiently similar video found"}
            
        # 3. Score candidates
        orig_title_tokens = tokenize(orig_title)
        orig_tag_tokens = set()
        for tag in orig_tags:
            orig_tag_tokens.update(tokenize(tag))
            
        scored_candidates = []
        
        for item in search_items:
            candidate_id = item.get("id", {}).get("videoId")
            if not candidate_id:
                continue
                
            if candidate_id == video_id:
                continue
                
            c_snippet = item.get("snippet", {})
            c_title = c_snippet.get("title", "")
            c_channel = c_snippet.get("channelTitle", "")
            
            if not c_title:
                continue
                
            score_data = score_candidate(orig_title_tokens, orig_tag_tokens, c_title)
            
            scored_candidates.append({
                "video_id": candidate_id,
                "title": c_title,
                "channel_title": c_channel,
                "score": score_data["score"],
                "intersection": score_data["intersection"]
            })
            
        if not scored_candidates:
            return {"status": "error", "error": "No sufficiently similar video found"}
            
        # 4. Tie-breaking and thresholding
        scored_candidates.sort(key=lambda x: (-x["score"], -x["intersection"], x["video_id"]))
        
        best_candidate = scored_candidates[0]
        
        # Require a threshold of 0.15 (at least ~15% vocabulary/tag score overlap).
        if best_candidate["score"] < 0.15:
            return {"status": "error", "error": "No sufficiently similar video found"}
            
        final_candidate = {
            "video_id": best_candidate["video_id"],
            "title": best_candidate["title"],
            "channel_title": best_candidate["channel_title"],
            "score": round(best_candidate["score"], 3)
        }
            
        return {
            "status": "success",
            "original_video": original_video_info,
            "similar_video": final_candidate
        }

from fastapi import HTTPException
from backend.analysis import fetch_comments, classify_all, aggregate_results

async def fetch_video_comments(video_id: str, max_comments: int = 50) -> dict:
    """
    Reusable wrapper for fetching comments.
    Catches HTTPExceptions from the main fetcher and returns a controlled dict.
    """
    try:
        comments = await fetch_comments(video_id)
        return {"status": "success", "comments": comments[:max_comments]}
    except HTTPException as e:
        return {"status": "error", "error": e.detail}
    except Exception as e:
        return {"status": "error", "error": str(e)}

async def analyze_similar_video(video_id: str) -> dict:
    """
    Finds a similar video, fetches its comments, classifies them, and aggregates the results.
    Reuses existing Agent 1 (classifier) and Aggregator exactly.
    """
    # 1. Find similar video
    sim_res = await find_similar_video(video_id)
    if sim_res.get("status") != "success":
        return sim_res
        
    sim_video = sim_res["similar_video"]
    sim_id = sim_video["video_id"]
    
    # 2. Fetch comments for the similar video
    comments_res = await fetch_video_comments(sim_id)
    if comments_res.get("status") != "success":
        return {
            "status": "error",
            "error": f"Failed to fetch comments for similar video: {comments_res.get('error')}"
        }
        
    comments = comments_res.get("comments", [])
    if not comments:
        return {
            "status": "error",
            "error": "No comments found on similar video."
        }
        
    # 3. Classify comments using EXISTING Stage 2 classifier
    try:
        classified = await classify_all(comments)
    except Exception as e:
        return {
            "status": "error",
            "error": f"Classification failed: {str(e)}"
        }
        
    # 4. Aggregate results using EXISTING Stage 3 aggregator
    try:
        agg = aggregate_results(classified)
    except Exception as e:
        return {
            "status": "error",
            "error": f"Aggregation failed: {str(e)}"
        }
        
    # 5. Return controlled structure (no narrative generation here)
    return {
        "status": "success",
        "similar_video": sim_video,
        "analysis": {
            "sentiment_counts": agg.get("sentiment_counts", {}),
            "sentiment_percentages": agg.get("sentiment_percentages", {}),
            "flag_counts": agg.get("flag_counts", {}),
            "flag_percentages": agg.get("flag_percentages", {}),
            "total": agg.get("total", 0),
            "failed_count": agg.get("failed_count", 0),
            "top_comments": agg.get("top_comments", {}),
            "vibe_score": agg.get("vibe_score", 0)
        }
    }
