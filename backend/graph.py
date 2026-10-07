import json
import operator
from typing import TypedDict, Annotated, Any
from langgraph.graph import StateGraph, START, END

from backend.analysis import (
    fetch_comments,
    classify_all,
    aggregate_results,
    run_insight_agent,
    call_groq
)
from backend.services import analyze_similar_video

class VibeCheckState(TypedDict, total=False):
    video_id: str

    primary_comments: list[str]
    primary_classifications: list[dict]
    primary_analysis: dict
    insight: str

    similar_video: dict
    similar_analysis: dict

    comparison: dict

    errors: Annotated[list[str], operator.add]

async def primary_analysis_node(state: VibeCheckState) -> dict:
    video_id = state.get("video_id")
    if not video_id:
        return {"errors": ["No video_id provided"]}
        
    try:
        comments = await fetch_comments(video_id)
        if not comments:
            return {"errors": ["No comments found on primary video."]}
            
        classified = await classify_all(comments)
        agg = aggregate_results(classified)
        
        return {
            "primary_comments": comments,
            "primary_classifications": classified,
            "primary_analysis": agg
        }
    except Exception as e:
        return {"errors": [f"Primary analysis failed: {str(e)}"]}

async def insight_agent_node(state: VibeCheckState) -> dict:
    agg = state.get("primary_analysis")
    if not agg:
        return {"errors": ["Insight Agent skipped: no primary analysis."]}
        
    try:
        narrative = await run_insight_agent(agg)
        return {"insight": narrative}
    except Exception as e:
        return {"errors": [f"Insight agent failed: {str(e)}"]}

async def similar_video_node(state: VibeCheckState) -> dict:
    video_id = state.get("video_id")
    if not video_id:
        return {"errors": ["Similar video skipped: no video_id."]}
        
    try:
        res = await analyze_similar_video(video_id)
        if res.get("status") == "success":
            return {
                "similar_video": res["similar_video"],
                "similar_analysis": res["analysis"]
            }
        else:
            return {"errors": [f"Similar video unavailable: {res.get('error')}"]}
    except Exception as e:
        return {"errors": [f"Similar video agent failed: {str(e)}"]}

async def comparison_node(state: VibeCheckState) -> dict:
    primary = state.get("primary_analysis")
    similar = state.get("similar_analysis")
    
    if not primary or not similar:
        return {
            "comparison": {
                "summary": "Comparison unavailable because no sufficiently similar video was found or primary analysis failed.",
                "status": "partial"
            }
        }
        
    if primary.get("total_comments", 0) == 0 or similar.get("total", 0) == 0:
        return {
            "comparison": {
                "summary": "Comparison unavailable due to insufficient successfully classified comments.",
                "status": "partial"
            }
        }
        
    # 1. Deterministic Calculation
    p_sent = primary.get('sentiment_percentages', {})
    s_sent = similar.get('sentiment_percentages', {})
    
    p_flag = primary.get('flag_percentages', {})
    s_flag = similar.get('flag_percentages', {})
    
    p_vibe = primary.get('vibe_score', 0)
    s_vibe = similar.get('vibe_score', 0)
    
    base_structure = {
        "status": "success",
        "sentiment_comparison": {
            "primary": p_sent,
            "similar": s_sent,
            "difference": {
                "positive": round(p_sent.get("positive", 0.0) - s_sent.get("positive", 0.0), 1),
                "negative": round(p_sent.get("negative", 0.0) - s_sent.get("negative", 0.0), 1),
                "neutral": round(p_sent.get("neutral", 0.0) - s_sent.get("neutral", 0.0), 1)
            }
        },
        "safety_comparison": {
            "primary": p_flag,
            "similar": s_flag,
            "difference": {
                "hate": round(p_flag.get("hate", 0.0) - s_flag.get("hate", 0.0), 1),
                "good": round(p_flag.get("good", 0.0) - s_flag.get("good", 0.0), 1),
                "bad": round(p_flag.get("bad", 0.0) - s_flag.get("bad", 0.0), 1),
                "none": round(p_flag.get("none", 0.0) - s_flag.get("none", 0.0), 1)
            }
        },
        "vibe_comparison": {
            "primary": p_vibe,
            "similar": s_vibe,
            "difference": p_vibe - s_vibe
        }
    }
    
    # 2. LLM Call for narrative only
    system = (
        "You are Vibe Check's Comparison Analyzer. "
        "Review the deterministically calculated sentiment and safety statistics comparing a primary YouTube video with a similar video. "
        "Provide ONLY a valid JSON object with EXACTLY these three keys:\n"
        "{\n"
        '  "summary": "...",\n'
        '  "winner": "primary",\n'
        '  "reason": "..."\n'
        "}\n"
        "The summary should be 2-3 sentences. Winner must be 'primary', 'similar', or 'tie'. Reason is 1 short sentence."
    )
    
    user = f"Primary Video vs Similar Video Stats:\n{json.dumps(base_structure, indent=2)}"
    
    try:
        resp_text = await call_groq([
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ], max_tokens=1000)
        
        if "`json" in resp_text:
            resp_text = resp_text.split("`json")[1].split("`")[0].strip()
        elif "`" in resp_text:
            resp_text = resp_text.split("`")[1].split("`")[0].strip()
            
        llm_data = json.loads(resp_text)
        
        # Merge LLM narrative into base deterministic structure
        base_structure["summary"] = llm_data.get("summary", "Summary unavailable.")
        base_structure["winner"] = llm_data.get("winner", "tie")
        base_structure["reason"] = llm_data.get("reason", "")
        
    except Exception as e:
        vibe_diff = base_structure["vibe_comparison"]["difference"]
        fallback_winner = "tie"
        if vibe_diff > 0:
            fallback_winner = "primary"
        elif vibe_diff < 0:
            fallback_winner = "similar"
            
        base_structure["status"] = "partial"
        base_structure["error"] = str(e)
        base_structure["summary"] = "The primary and similar videos show different audience sentiment patterns. The comparison is based on successfully classified comments."
        base_structure["winner"] = fallback_winner
        base_structure["reason"] = "Deterministic fallback used due to AI rate limits."
        
    return {"comparison": base_structure}

def build_graph():
    builder = StateGraph(VibeCheckState)
    
    builder.add_node("primary_analysis", primary_analysis_node)
    builder.add_node("insight_agent", insight_agent_node)
    builder.add_node("similar_video", similar_video_node)
    builder.add_node("comparison", comparison_node)
    
    builder.add_edge(START, "primary_analysis")
    builder.add_edge("primary_analysis", "insight_agent")
    builder.add_edge("primary_analysis", "similar_video")
    builder.add_edge("insight_agent", "comparison")
    builder.add_edge("similar_video", "comparison")
    builder.add_edge("comparison", END)
    
    return builder.compile()

async def run_vibe_check_graph(video_id: str) -> dict:
    graph = build_graph()
    state = {"video_id": video_id}
    final_state = await graph.ainvoke(state)
    return final_state