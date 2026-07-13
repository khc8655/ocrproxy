"""
In-memory statistics tracking.
Replaces EdgeOne KV-based stats storage.
Thread-safe using a lock; stats reset on service restart.
"""
import time
import threading
from typing import Optional

_lock = threading.Lock()
MAX_ERROR_LOGS = 50


def _empty_type_stats() -> dict:
    return {
        "success": 0,
        "429": 0,
        "403": 0,
        "4xx": 0,
        "5xx": 0,
        "total_latency": 0.0,
        "count": 0
    }


def _get_empty_stats() -> dict:
    return {
        "chat": _empty_type_stats(),
        "embedding": _empty_type_stats(),
        "reranker": _empty_type_stats(),
        "ocr": _empty_type_stats(),
        "candidates_status": {},
        "error_logs": []
    }


_stats: dict = _get_empty_stats()


def get_stats() -> dict:
    """Return a snapshot of current statistics."""
    with _lock:
        return {
            "chat": dict(_stats["chat"]),
            "embedding": dict(_stats["embedding"]),
            "reranker": dict(_stats["reranker"]),
            "ocr": dict(_stats["ocr"]),
            "candidates_status": {k: dict(v) for k, v in _stats["candidates_status"].items()},
            "error_logs": [dict(log) for log in _stats["error_logs"]]
        }


def record(
    type_name: str,
    status_code: int,
    latency: float,
    provider: Optional[str] = None,
    key: Optional[str] = None,
    error_msg: Optional[str] = None
):
    """Record a request result into in-memory stats."""
    with _lock:
        if type_name not in _stats:
            _stats[type_name] = _empty_type_stats()

        t_stats = _stats[type_name]
        t_stats["count"] += 1
        t_stats["total_latency"] += float(latency) or 0.0

        code = int(status_code)
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

        # Record candidate node's last request status
        if provider and key:
            node_key = f"{provider}:{key}"
            _stats["candidates_status"][node_key] = {
                "status": code,
                "time": int(time.time() * 1000)
            }

        # Record error log (keep most recent MAX_ERROR_LOGS entries)
        if code != 200 and error_msg:
            _stats["error_logs"].insert(0, {
                "timestamp": int(time.time() * 1000),
                "type": type_name,
                "provider": provider or "unknown",
                "key": key or "unknown",
                "status": code,
                "error": error_msg
            })
            if len(_stats["error_logs"]) > MAX_ERROR_LOGS:
                _stats["error_logs"] = _stats["error_logs"][:MAX_ERROR_LOGS]


def reset():
    """Reset all statistics to zero."""
    with _lock:
        _stats.clear()
        _stats.update(_get_empty_stats())
