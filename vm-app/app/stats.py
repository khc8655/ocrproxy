"""
In-memory statistics tracking.
Replaces EdgeOne KV-based stats storage.
Thread-safe using a lock; stats reset on service restart.
Provides strict separation between Agent models and KB ingestion types.
"""
import time
import threading
from typing import Optional, Dict, Any, List

_lock = threading.Lock()
MAX_ERROR_LOGS = 100


def _empty_metric_stats() -> dict:
    return {
        "success": 0,
        "429": 0,
        "403": 0,
        "4xx": 0,
        "5xx": 0,
        "count": 0,
        "fallback_count": 0,
    }


def _empty_agent_model_stats() -> dict:
    return {
        "count": 0,
        "success": 0,
        "429": 0,
        "403": 0,
        "4xx": 0,
        "5xx": 0,
        "fallback_count": 0,
        "last_error": None,
        "last_error_time": None,
    }


def _get_empty_stats() -> dict:
    return {
        "agent": {
            "count": 0,
            "success": 0,
            "429": 0,
            "403": 0,
            "4xx": 0,
            "5xx": 0,
            "fallback_count": 0,
            "models": {},
            "active_keys": {}
        },
        "kb": {
            "chat": _empty_metric_stats(),
            "embedding": _empty_metric_stats(),
            "reranker": _empty_metric_stats(),
            "ocr": _empty_metric_stats(),
        },
        # Legacy compatibility keys
        "chat": _empty_metric_stats(),
        "embedding": _empty_metric_stats(),
        "reranker": _empty_metric_stats(),
        "ocr": _empty_metric_stats(),
        "candidates_status": {},
        "error_logs": []
    }


_stats: dict = _get_empty_stats()


def get_stats() -> dict:
    """Return a snapshot of current statistics."""
    with _lock:
        agent_models_copy = {}
        for m_name, m_data in _stats["agent"]["models"].items():
            agent_models_copy[m_name] = dict(m_data)

        agent_copy = dict(_stats["agent"])
        agent_copy["models"] = agent_models_copy
        agent_copy["active_keys"] = dict(_stats["agent"].get("active_keys", {}))

        kb_copy = {k: dict(v) for k, v in _stats["kb"].items()}

        return {
            "agent": agent_copy,
            "kb": kb_copy,
            # Legacy compatibility top-level keys
            "chat": dict(_stats["kb"]["chat"]),
            "embedding": dict(_stats["kb"]["embedding"]),
            "reranker": dict(_stats["kb"]["reranker"]),
            "ocr": dict(_stats["kb"]["ocr"]),
            "candidates_status": {k: dict(v) for k, v in _stats["candidates_status"].items()},
            "error_logs": [dict(log) for log in _stats["error_logs"]]
        }


def get_agent_active_key(model_name: str) -> Optional[str]:
    """Get the currently active runtime key for an agent model."""
    with _lock:
        return _stats["agent"].get("active_keys", {}).get(model_name)


def set_agent_active_key(model_name: str, key_label: str):
    """Set the currently active runtime key for an agent model."""
    with _lock:
        if "active_keys" not in _stats["agent"]:
            _stats["agent"]["active_keys"] = {}
        _stats["agent"]["active_keys"][model_name] = key_label


def record_agent(
    model_name: str,
    status_code: int,
    latency: float,
    provider: Optional[str] = None,
    key: Optional[str] = None,
    is_fallback: bool = False,
    error_msg: Optional[str] = None,
    is_quota: bool = False
):
    """Record an Agent request result."""
    with _lock:
        code = int(status_code)
        lat = float(latency) or 0.0

        # 1. Update Agent Global Total
        ag = _stats["agent"]
        ag["count"] += 1
        if is_fallback:
            ag["fallback_count"] += 1

        if code == 200:
            ag["success"] += 1
        elif code == 429:
            ag["429"] += 1
        elif code == 403:
            ag["403"] += 1
        elif 400 <= code < 500:
            ag["4xx"] += 1
        else:
            ag["5xx"] += 1

        # 2. Update Specific Model Metric
        if model_name not in ag["models"]:
            ag["models"][model_name] = _empty_agent_model_stats()

        m_stats = ag["models"][model_name]
        m_stats["count"] += 1
        if is_fallback:
            m_stats["fallback_count"] += 1

        if code == 200:
            m_stats["success"] += 1
            if key:
                if "active_keys" not in ag:
                    ag["active_keys"] = {}
                ag["active_keys"][model_name] = key
        elif code == 429:
            m_stats["429"] += 1
        elif code == 403:
            m_stats["403"] += 1
        elif 400 <= code < 500:
            m_stats["4xx"] += 1
        else:
            m_stats["5xx"] += 1

        now_ms = int(time.time() * 1000)
        lat_ms = int(round(lat * 1000)) if lat > 0 else 0

        # 3. Update Candidate Node Status (Isolated for Agent)
        if provider and key:
            node_key = f"agent:{model_name}:{provider}:{key}"
            _stats["candidates_status"][node_key] = {
                "status": code,
                "latency_ms": lat_ms,
                "category": "agent",
                "model": model_name,
                "time": now_ms,
                "is_quota": is_quota
            }
            # Also populate lookup key for UI backwards compatibility
            _stats["candidates_status"][f"{provider}:{key}:agent:{model_name}"] = {
                "status": code,
                "latency_ms": lat_ms,
                "category": "agent",
                "model": model_name,
                "time": now_ms,
                "is_quota": is_quota
            }

        # 4. Error Logs with Agent Category
        if code != 200 and error_msg:
            m_stats["last_error"] = error_msg
            m_stats["last_error_time"] = now_ms

            _stats["error_logs"].insert(0, {
                "timestamp": now_ms,
                "category": "agent",
                "type": "agent",
                "model_name": model_name,
                "provider": provider or "unknown",
                "key": key or "unknown",
                "status": code,
                "error": error_msg
            })
            if len(_stats["error_logs"]) > MAX_ERROR_LOGS:
                _stats["error_logs"] = _stats["error_logs"][:MAX_ERROR_LOGS]


def record_kb(
    kb_type: str,
    status_code: int,
    latency: float,
    provider: Optional[str] = None,
    key: Optional[str] = None,
    model: Optional[str] = None,
    is_fallback: bool = False,
    error_msg: Optional[str] = None,
    is_quota: bool = False
):
    """Record a KB Ingestion request result."""
    with _lock:
        code = int(status_code)
        lat = float(latency) or 0.0

        if kb_type not in _stats["kb"]:
            _stats["kb"][kb_type] = _empty_metric_stats()

        t_stats = _stats["kb"][kb_type]
        t_stats["count"] += 1
        if is_fallback:
            t_stats["fallback_count"] += 1

        if code == 200:
            t_stats["success"] += 1
        elif code == 429:
            t_stats["429"] += 1
        elif code == 403:
            t_stats["403"] += 1
        elif 400 <= code < 500:
            t_stats["4xx"] += 1
        else:
            t_stats["5xx"] += 1

        now_ms = int(time.time() * 1000)
        lat_ms = int(round(lat * 1000)) if lat > 0 else 0

        # Update legacy top-level dict for backwards compatibility
        if kb_type in _stats:
            _stats[kb_type] = dict(t_stats)

        # Update Candidate Node Status (Isolated for KB with model dimension)
        if provider and key:
            status_entry = {
                "status": code,
                "latency_ms": lat_ms,
                "category": "kb",
                "type": kb_type,
                "model": model or "",
                "time": now_ms,
                "is_quota": is_quota
            }
            if model:
                _stats["candidates_status"][f"kb:{kb_type}:{provider}:{key}:{model}"] = status_entry
            # Also store legacy format for backward compatibility
            _stats["candidates_status"][f"kb:{kb_type}:{provider}:{key}"] = status_entry
            _stats["candidates_status"][f"{provider}:{key}:{kb_type}"] = status_entry

        # Error Logs with KB Category (Deduplicate consecutive identical errors during ingestion to control log size)
        if code != 200 and error_msg:
            if _stats["error_logs"]:
                last_log = _stats["error_logs"][0]
                if (last_log.get("provider") == provider and
                    last_log.get("key") == key and
                    last_log.get("status") == code and
                    last_log.get("model_name") == (model or kb_type) and
                    (now_ms - last_log.get("timestamp", 0) < 60000)):
                    last_log["repeat_count"] = last_log.get("repeat_count", 1) + 1
                    last_log["timestamp"] = now_ms
                    return

            _stats["error_logs"].insert(0, {
                "timestamp": now_ms,
                "category": "kb",
                "type": kb_type,
                "model_name": model or kb_type,
                "provider": provider or "unknown",
                "key": key or "unknown",
                "status": code,
                "error": error_msg[:300],  # Bound error text length
                "repeat_count": 1
            })
            if len(_stats["error_logs"]) > MAX_ERROR_LOGS:
                _stats["error_logs"] = _stats["error_logs"][:MAX_ERROR_LOGS]


def record(
    type_name: str,
    status_code: int,
    latency: float,
    provider: Optional[str] = None,
    key: Optional[str] = None,
    error_msg: Optional[str] = None,
    category: Optional[str] = None,
    request_model: Optional[str] = None,
    is_fallback: bool = False,
    cand_model: Optional[str] = None,
    is_quota: bool = False
):
    """Unified record router for legacy & direct calls."""
    if category == "agent" or (type_name not in ("chat", "embedding", "reranker", "ocr") and type_name != "kb"):
        model_name = request_model or type_name
        record_agent(
            model_name=model_name,
            status_code=status_code,
            latency=latency,
            provider=provider,
            key=key,
            is_fallback=is_fallback,
            error_msg=error_msg,
            is_quota=is_quota
        )
    else:
        kb_type = type_name if type_name in ("chat", "embedding", "reranker", "ocr") else "chat"
        record_kb(
            kb_type=kb_type,
            status_code=status_code,
            latency=latency,
            provider=provider,
            key=key,
            model=cand_model or request_model,
            is_fallback=is_fallback,
            error_msg=error_msg,
            is_quota=is_quota
        )


def reset():
    """Reset all statistics to zero."""
    with _lock:
        _stats.clear()
        _stats.update(_get_empty_stats())
