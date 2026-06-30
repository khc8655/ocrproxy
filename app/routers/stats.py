"""统计接口 — 按四类模型分组"""
from fastapi import APIRouter, Depends, Query
from typing import List
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timedelta, timezone
from app.db.database import get_db
from app.db.models import UsageLog

router = APIRouter(prefix="/api/stats", tags=["Statistics"])


@router.get("/summary")
def summary(hours: int = Query(24), db: Session = Depends(get_db)):
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = db.query(UsageLog).filter(UsageLog.created_at >= since)
    total = q.count()
    success = q.filter(UsageLog.status == "success").count()
    fail_429 = q.filter(UsageLog.status == "fail_429").count()
    fail_403 = q.filter(UsageLog.status == "fail_403").count()
    fail_5xx = q.filter(UsageLog.status == "fail_5xx").count()
    fail_other = q.filter(UsageLog.status == "fail_other").count()

    latencies = [r[0] for r in db.query(UsageLog.elapsed_ms)
                 .filter(UsageLog.created_at >= since, UsageLog.status == "success")
                 .order_by(UsageLog.elapsed_ms).all()]
    p50 = p95 = p99 = 0
    if latencies:
        def pct(p): return latencies[max(0, int(len(latencies)*p)-1)]
        p50, p95, p99 = pct(0.5), pct(0.95), pct(0.99)

    return {
        "total": total, "success": success,
        "fail_429": fail_429, "fail_403": fail_403,
        "fail_5xx": fail_5xx, "fail_other": fail_other,
        "p50_ms": p50, "p95_ms": p95, "p99_ms": p99,
        "success_rate": round(success / total, 4) if total else 0,
    }


@router.get("/by-type")
def by_type(hours: int = Query(24), db: Session = Depends(get_db)):
    """按四类模型分别统计: 调用数/成功/429/403/成功率/平均延迟"""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    result = []
    for mt in ("ocr", "embedding", "reranker", "chat"):
        base = db.query(UsageLog).filter(
            UsageLog.model_type == mt, UsageLog.created_at >= since)
        total = base.count()
        success = base.filter(UsageLog.status == "success").count()
        f429 = base.filter(UsageLog.status == "fail_429").count()
        f403 = base.filter(UsageLog.status == "fail_403").count()
        f5xx = base.filter(UsageLog.status == "fail_5xx").count()
        fothers = base.filter(UsageLog.status == "fail_other").count()
        avg_ms = 0
        if success:
            avg_ms = int(db.query(func.avg(UsageLog.elapsed_ms)).filter(
                UsageLog.model_type == mt, UsageLog.created_at >= since,
                UsageLog.status == "success").scalar() or 0)
        result.append({
            "model_type": mt, "total": total, "success": success,
            "fail_429": f429, "fail_403": f403, "fail_5xx": f5xx, "fail_other": fothers,
            "success_rate": round(success/total, 4) if total else 0,
            "avg_ms": avg_ms,
        })
    return result


@router.get("/by-candidate")
def by_candidate(hours: int = Query(24), db: Session = Depends(get_db)):
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = (db.query(UsageLog.provider_name, UsageLog.key_label,
                     UsageLog.model_type, UsageLog.model_id, UsageLog.status,
                     func.count(UsageLog.id).label("cnt"),
                     func.avg(UsageLog.elapsed_ms).label("avg_ms"))
            .filter(UsageLog.created_at >= since)
            .group_by(UsageLog.provider_name, UsageLog.key_label,
                      UsageLog.model_type, UsageLog.model_id, UsageLog.status)
            .order_by(UsageLog.model_type, UsageLog.provider_name).all())
    return [{"provider_name": r[0], "key_label": r[1], "model_type": r[2],
             "model_id": r[3], "status": r[4], "count": r[5],
             "avg_ms": int(r[6] or 0)} for r in rows]


@router.get("/fallback-traces")
def fallback_traces(limit: int = Query(30), db: Session = Depends(get_db)):
    sub = (db.query(UsageLog.request_id, func.count(UsageLog.id).label("att"))
           .group_by(UsageLog.request_id)
           .having(func.count(UsageLog.id) > 1)
           .order_by(func.max(UsageLog.created_at).desc())
           .limit(limit).all())
    rids = [r[0] for r in sub]
    if not rids: return []
    logs = (db.query(UsageLog).filter(UsageLog.request_id.in_(rids))
            .order_by(UsageLog.request_id, UsageLog.attempt_seq).all())
    traces = {}
    for l in logs:
        traces.setdefault(l.request_id, []).append({
            "attempt": l.attempt_seq, "provider": l.provider_name,
            "key_label": l.key_label, "model_id": l.model_id,
            "status": l.status, "http_status": l.http_status,
            "elapsed_ms": l.elapsed_ms, "time": l.created_at.isoformat(),
            "error": (l.error_msg or "")[:200],
        })
    return [{"request_id": rid, "attempts": traces[rid]} for rid in rids]


@router.get("/recent-errors")
def recent_errors(limit: int = Query(50), db: Session = Depends(get_db)):
    rows = (db.query(UsageLog).filter(UsageLog.status != "success")
            .order_by(UsageLog.created_at.desc()).limit(limit).all())
    return [{"id": r.id, "request_id": r.request_id, "attempt": r.attempt_seq,
             "provider_name": r.provider_name, "key_label": r.key_label,
             "model_type": r.model_type, "model_id": r.model_id,
             "status": r.status, "http_status": r.http_status,
             "error_msg": (r.error_msg or "")[:300],
             "time": r.created_at.isoformat()} for r in rows]
