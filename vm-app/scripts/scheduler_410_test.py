#!/usr/bin/env python3
"""HTTP 410 (model retired upstream) scheduler regression test.

Run: python3 vm-app/scripts/scheduler_410_test.py
"""
import asyncio, json, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from app import scheduler as s

calls = []
def handler(req):
    calls.append(str(req.url))
    if 'gone' in str(req.url):
        return httpx.Response(410, json={"error": {"message": "model retired"}})
    return httpx.Response(200, json={"choices":[{"message":{"content":"ok"}}]})

s._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

def cfg(cands):
    return {
        "providers": {
            "pa": {"name":"pa","base_url":"https://gone.example/v1","keys":{"k1":"x1","k2":"x2"}},
            "pb": {"name":"pb","base_url":"https://ok.example/v1","keys":{"k1":"y1"}},
        },
        "candidates": {"m": cands},
        "agent_routing_strategy": "sticky_failover",
        "schedule_total_budget": 5, "max_attempts_per_provider": 3,
    }

def br(cand, key, base):
    return "POST", base + "/chat/completions", {"authorization": "Bearer "+key}, {"model": cand["model"]}

async def main():
    # agent: pa/k1 410 -> pa/k2 must be skipped -> pb ok
    c = cfg([{"provider":"pa","key":"k1","model":"old"},{"provider":"pa","key":"k2","model":"old"},{"provider":"pb","key":"k1","model":"new"}])
    s.reset_runtime_state(); s._gone_models.clear(); calls.clear()
    r = await s.schedule(c, "m", br, category="agent", request_model="m")
    print("req1 calls", calls, "routed", r.routed_via)
    assert sum('gone' in u for u in calls) == 1, calls
    assert s._is_model_gone("pa","old")
    # second request: no call to pa at all
    calls.clear()
    r = await s.schedule(c, "m", br, category="agent", request_model="m")
    print("req2 calls", calls)
    assert all('gone' not in u for u in calls)
    # reload (reset_runtime_state) does not resurrect
    s.reset_runtime_state()
    assert s._is_model_gone("pa","old")
    # prune keeps configured, drops removed
    s._prune_runtime_state(c); assert s._is_model_gone("pa","old")
    c2 = cfg([{"provider":"pb","key":"k1","model":"new"}]); s._prune_runtime_state(c2)
    assert not s._is_model_gone("pa","old")
    # all candidates gone -> 410 without upstream call
    only = cfg([{"provider":"pa","key":"k1","model":"old"}])
    s.reset_runtime_state(); calls.clear()
    try:
        await s.schedule(only, "m", br, category="agent", request_model="m")
    except s.AllCandidatesFailedError as e:
        print("first sole:", e.last_status_code)
        assert e.last_status_code == 410
    calls.clear()
    try:
        await s.schedule(only, "m", br, category="agent", request_model="m")
    except s.AllCandidatesFailedError as e:
        print("second sole:", e.last_status_code, str(e)[:90], calls)
        assert e.last_status_code == 410 and not calls
    # KB mode too
    s.reset_runtime_state(); s._gone_models.clear(); calls.clear()
    r = await s.schedule(c, "m", br, category="kb", request_model="m")
    assert sum('gone' in u for u in calls) == 1 and s._is_model_gone("pa","old")
    # evaluate
    ev = s.evaluate_candidate_failure(410, False, False, "agent", 0, {"cooldown_410_sec": 100})
    assert ev.model_gone and ev.cooldown_sec == 100
    ev = s.evaluate_candidate_failure(404, False, False, "agent", 0, {})
    assert not ev.model_gone
    print("ALL OK")
asyncio.run(main())
