"""
agent_metrics.py — per-request Agent summary for the dashboard (VM only).

One entry per client request that reached routing (/v1/chat/completions or
/v1/messages in agent run mode), aggregated per day (Asia/Shanghai):

    requests      requests that reached the scheduler
    failures      requests that finally failed for the client
                  (HTTP >= 400, or an error frame inside a 200 stream)
    failovers     successful requests that needed at least one key switch
    tokens_in     prompt / input tokens (Anthropic cache read + creation included)
    tokens_out    completion / output tokens
    usage_requests successful requests whose response carried usage
                  (OpenAI chat streams only carry usage when the client sends
                  stream_options.include_usage; we never inject it)
    ttft_ms_*     time from request start to the first real payload byte
                  (SSE comments such as keep-alives are skipped); non-stream = total
    total_ms_*    time from request start to the last byte

Shape exposed through stats.get_stats()["agent"]["summary"]; the contract
(shared/contracts/admin-ui-backend.json) documents it. EdgeOne has no
equivalent on purpose: its dashboard shows a snapshot from candidates_status.

The summary is kept in memory and written to CONFIG_DIR/agent_summary.json at
most every _SAVE_INTERVAL_SEC so a restart does not reset today's numbers.
"""
import contextvars
import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

logger = logging.getLogger("ocrproxy")

try:
    from zoneinfo import ZoneInfo
    _TZ = ZoneInfo("Asia/Shanghai")
except Exception:  # pragma: no cover - minimal images without tzdata
    _TZ = timezone(timedelta(hours=8))

_SAVE_INTERVAL_SEC = 30.0
_MAX_MODELS = 200
_MAX_LINE_BUF = 256 * 1024

_lock = threading.Lock()
_summary: Optional[dict] = None
_last_save = 0.0
_dirty = False

_current: contextvars.ContextVar = contextvars.ContextVar("agent_req_tracker", default=None)


def _today() -> str:
    return datetime.now(_TZ).strftime("%Y-%m-%d")


def _empty(day: str) -> dict:
    return {
        "window": "today",
        "date": day,
        "timezone": "Asia/Shanghai",
        "requests": 0,
        "failures": 0,
        "failovers": 0,
        "tokens_in": 0,
        "tokens_out": 0,
        "usage_requests": 0,
        "ttft_ms_sum": 0,
        "ttft_count": 0,
        "total_ms_sum": 0,
        "total_count": 0,
        "models": {},
    }


def _path() -> str:
    return os.path.join(os.environ.get("CONFIG_DIR", "/opt/ocrproxy/config"), "agent_summary.json")


def _load_locked() -> dict:
    global _summary
    if _summary is not None:
        return _summary
    day = _today()
    data = None
    try:
        with open(_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = None
    if isinstance(data, dict) and data.get("date") == day:
        base = _empty(day)
        base.update({k: v for k, v in data.items() if k in base})
        if not isinstance(base.get("models"), dict):
            base["models"] = {}
        _summary = base
    else:
        _summary = _empty(day)
    return _summary


def _roll_locked() -> dict:
    global _summary
    s = _load_locked()
    day = _today()
    if s.get("date") != day:
        _summary = _empty(day)
    return _summary


def _save_locked(force: bool = False) -> None:
    global _last_save, _dirty
    if not _dirty:
        return
    now = time.monotonic()
    if not force and now - _last_save < _SAVE_INTERVAL_SEC:
        return
    _last_save = now
    try:
        p = _path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_summary, f, ensure_ascii=False)
        os.replace(tmp, p)
        _dirty = False
    except Exception as e:
        logger.warning("agent summary save failed: %s", e)


def reset() -> None:
    """Testing helper: drop in-memory state (the file is left alone)."""
    global _summary, _dirty, _last_save
    with _lock:
        _summary = None
        _dirty = False
        _last_save = 0.0


def clear() -> None:
    """Admin 「重置统计」: zero today's summary and persist it."""
    global _summary, _dirty
    with _lock:
        _summary = _empty(_today())
        _dirty = True
        _save_locked(force=True)


def flush() -> None:
    with _lock:
        if _summary is not None:
            _save_locked(force=True)


def _avg(total, count):
    return int(round(total / count)) if count else None


def snapshot() -> dict:
    with _lock:
        s = _roll_locked()
        models = {}
        for name, m in s["models"].items():
            models[name] = {
                "requests": m.get("requests", 0),
                "failures": m.get("failures", 0),
                "tokens_in": m.get("tokens_in", 0),
                "tokens_out": m.get("tokens_out", 0),
                "ttft_ms_avg": _avg(m.get("ttft_ms_sum", 0), m.get("ttft_count", 0)),
            }
        return {
            "window": s["window"],
            "date": s["date"],
            "timezone": s["timezone"],
            "requests": s["requests"],
            "failures": s["failures"],
            "failovers": s["failovers"],
            "tokens_in": s["tokens_in"],
            "tokens_out": s["tokens_out"],
            "usage_requests": s["usage_requests"],
            "ttft_ms_avg": _avg(s["ttft_ms_sum"], s["ttft_count"]),
            "total_ms_avg": _avg(s["total_ms_sum"], s["total_count"]),
            "models": models,
        }


def _record(model: str, ok: bool, failovers: int, ttft_ms: Optional[float], total_ms: float,
            tokens_in: int, tokens_out: int, has_usage: bool) -> None:
    global _dirty
    with _lock:
        s = _roll_locked()
        targets = [s]
        if model:
            m = s["models"].get(model)
            if m is None and len(s["models"]) < _MAX_MODELS:
                m = s["models"][model] = {"requests": 0, "failures": 0, "tokens_in": 0, "tokens_out": 0,
                                          "ttft_ms_sum": 0, "ttft_count": 0}
            if m is not None:
                targets.append(m)
        for t in targets:
            t["requests"] = t.get("requests", 0) + 1
            if not ok:
                t["failures"] = t.get("failures", 0) + 1
            t["tokens_in"] = t.get("tokens_in", 0) + int(tokens_in or 0)
            t["tokens_out"] = t.get("tokens_out", 0) + int(tokens_out or 0)
            if ok and ttft_ms is not None:
                t["ttft_ms_sum"] = t.get("ttft_ms_sum", 0) + int(ttft_ms)
                t["ttft_count"] = t.get("ttft_count", 0) + 1
        if ok:
            if failovers > 0:
                s["failovers"] += 1
            if has_usage:
                s["usage_requests"] += 1
            s["total_ms_sum"] += int(total_ms)
            s["total_count"] += 1
        _dirty = True
        _save_locked()


# ── usage parsing ────────────────────────────────────────────────────

def _usage_numbers(obj) -> tuple:
    """Return (tokens_in, tokens_out) found in one JSON object (either API), or (None, None)."""
    if not isinstance(obj, dict):
        return None, None
    usage = obj.get("usage")
    if not isinstance(usage, dict):
        msg = obj.get("message")  # Anthropic message_start
        usage = msg.get("usage") if isinstance(msg, dict) else None
    if not isinstance(usage, dict):
        return None, None
    tin = tout = None
    if "prompt_tokens" in usage or "completion_tokens" in usage:
        tin = usage.get("prompt_tokens")
        tout = usage.get("completion_tokens")
    else:
        parts = [usage.get(k) for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")]
        if any(isinstance(p, (int, float)) for p in parts):
            tin = sum(int(p) for p in parts if isinstance(p, (int, float)))
        tout = usage.get("output_tokens")
    tin = int(tin) if isinstance(tin, (int, float)) else None
    tout = int(tout) if isinstance(tout, (int, float)) else None
    return tin, tout


class AgentRequestTracker:
    """Created per client request; fed by the route wrapper and the scheduler."""

    __slots__ = ("t0", "ttft_ms", "model", "scheduled", "failovers", "tokens_in", "tokens_out",
                 "has_usage", "stream_error", "_tail", "_done")

    def __init__(self):
        self.t0 = time.monotonic()
        self.ttft_ms = None
        self.model = ""
        self.scheduled = False
        self.failovers = 0
        self.tokens_in = 0
        self.tokens_out = 0
        self.has_usage = False
        self.stream_error = False
        self._tail = b""
        self._done = False

    # called by scheduler (through current())
    def note_schedule(self, model: str):
        self.scheduled = True
        if model:
            self.model = model

    def note_success(self, attempts_before: int):
        self.failovers = max(0, int(attempts_before))

    def _take_usage(self, obj):
        tin, tout = _usage_numbers(obj)
        if tin is None and tout is None:
            return
        self.has_usage = True
        # Values are cumulative inside one response: keep the largest seen.
        if tin is not None and tin > self.tokens_in:
            self.tokens_in = tin
        if tout is not None and tout > self.tokens_out:
            self.tokens_out = tout

    def on_body(self, body: bytes):
        """Non-stream JSON body."""
        if not body or b'"usage"' not in body:
            return
        try:
            self._take_usage(json.loads(body))
        except Exception:
            pass

    def on_chunk(self, chunk: bytes):
        if not chunk:
            return
        if self.ttft_ms is None and not chunk.lstrip().startswith(b":"):
            self.ttft_ms = (time.monotonic() - self.t0) * 1000.0
        buf = self._tail + chunk
        cut = buf.rfind(b"\n")
        if cut < 0:
            self._tail = buf if len(buf) <= _MAX_LINE_BUF else b""
            return
        complete, self._tail = buf[:cut], buf[cut + 1:]
        if len(self._tail) > _MAX_LINE_BUF:
            self._tail = b""
        # cheap pre-checks: only split/parse when something interesting is there
        has_usage = b'"usage"' in complete
        has_err = b"event: error" in complete or b'data: {"error"' in complete
        if not (has_usage or has_err):
            return
        if has_err:
            self.stream_error = True
        if has_usage:
            for line in complete.split(b"\n"):
                if line.startswith(b"data:") and b'"usage"' in line:
                    try:
                        self._take_usage(json.loads(line[5:].strip()))
                    except Exception:
                        pass

    def finish(self, ok: bool):
        if self._done or not self.scheduled:
            return
        self._done = True
        if self._tail:
            self.on_chunk(b"\n")
        ok = bool(ok) and not self.stream_error
        total_ms = (time.monotonic() - self.t0) * 1000.0
        ttft = self.ttft_ms if self.ttft_ms is not None else total_ms
        try:
            _record(self.model, ok, self.failovers, ttft, total_ms,
                    self.tokens_in, self.tokens_out, self.has_usage)
        except Exception as e:  # never break a request because of metrics
            logger.warning("agent summary record failed: %s", e)


def begin() -> AgentRequestTracker:
    t = AgentRequestTracker()
    _current.set(t)
    return t


def current() -> Optional[AgentRequestTracker]:
    return _current.get()
