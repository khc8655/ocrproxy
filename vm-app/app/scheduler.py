"""
Stateless Failover Scheduler
Handles key rotation, failover budget, concurrency limiters, cooldown, and circuit breaker.
Ported from EdgeOne cloud-functions version; stats now recorded in-memory.
"""
import os
import time
import logging
import asyncio
import json
import gc
import ctypes
import ctypes.util
import httpx
from collections import deque
from typing import Optional, Any, Callable, Dict, Set, Tuple, List, Deque
from dataclasses import dataclass

from . import stats
from . import agent_metrics
from . import oauth_credentials
from .config_store import get_config_version
from .logger_utils import clean_upstream_error_text

logger = logging.getLogger("scheduler")
from .settings_schema import get_setting
from . import runtime_profile

# ── Global concurrency limiter ───────────────────────────────────────
# Caps the total number of in-flight upstream requests across ALL keys and
# model types.  This is the backpressure valve for burst ingestion scenarios
# (e.g. knowledge-base batch OCR) where the client fires dozens of concurrent
# requests.  Without this, each request's base64 payload accumulates in the
# Python heap and can OOM a 1.6 GB VM.
#
# The limit is intentionally generous (30) — it only kicks in during true
# bursts, not normal traffic.  Requests that cannot acquire it within
# _GLOBAL_QUEUE_TIMEOUT_SEC fail fast with 503 + Retry-After instead of
# queueing unboundedly (a queued request keeps its parsed body on the heap,
# which defeats the cap's purpose).
#
# Scope (v2026.10.09-08): the cap applies ONLY to the KB category (chat in KB
# mode, embedding, rerank, OCR).  Agent-mode requests are mostly long-lived
# SSE streams that hold almost no heap; counting them against a 30-slot cap
# turned the 31st concurrent Cursor/Cline stream into an instant 503 (with no
# failover).  Agent traffic stays bounded by the per-key semaphore.
# Override with config key `kb_global_max_concurrency`.
_KB_PROFILE = runtime_profile.settings({"run_mode": "kb"})
_AGENT_PROFILE = runtime_profile.settings({"run_mode": "agent"})
_GLOBAL_MAX_CONCURRENCY = int(_KB_PROFILE.get("kb_global_max_concurrency", 30))
_GLOBAL_QUEUE_TIMEOUT_SEC = 2.0
_KB_DEFAULT_KEY_CONCURRENCY = int(_KB_PROFILE.get("kb_max_concurrency_per_key", 16))
_UNLIMITED_KEY_CONCURRENCY = 100000
_global_semaphore: Optional[asyncio.Semaphore] = None
_global_semaphore_limit: int = _GLOBAL_MAX_CONCURRENCY


def _get_global_semaphore(limit: int = _GLOBAL_MAX_CONCURRENCY) -> asyncio.Semaphore:
    """Return the KB global semaphore, recreating it when the configured limit
    changes (same trade-off as per-key semaphores: in-flight requests keep the
    old object, so the cap may briefly over-subscribe after a config change)."""
    global _global_semaphore, _global_semaphore_limit
    if _global_semaphore is None or _global_semaphore_limit != limit:
        _global_semaphore = asyncio.Semaphore(limit)
        _global_semaphore_limit = limit
    return _global_semaphore

# ── Memory reclamation helper ────────────────────────────────────────
# Python's gc.collect() only reclaims Python objects; it does NOT persuade
# glibc's ptmalloc2 to return freed heap pages to the OS.  On Linux we can
# call libc.malloc_trim(0) which tells the allocator to release the top-most
# freed chunk back to the kernel via madvise(MADV_DONTNEED).  Combined with
# MALLOC_ARENA_MAX=2 (set in the systemd unit) this keeps RSS flat even under
# large OCR base64 payloads.
_libc = None
try:
    _libc_path = ctypes.util.find_library("c")
    if _libc_path:
        _libc = ctypes.CDLL(_libc_path)
        _libc.malloc_trim.argtypes = [ctypes.c_size_t]
        _libc.malloc_trim.restype = ctypes.c_int
except Exception:
    pass  # non-Linux platforms or missing libc — silently skip

# Pin glibc's mmap threshold.  By default glibc raises the threshold every
# time a large mmap'd block is freed (up to 32 MB), after which multi-MB OCR
# base64 strings are carved out of the heap, get pinned by small long-lived
# objects allocated after them, and are only returned by malloc_trim().  A
# fixed threshold (setting it also disables the dynamic adjustment) keeps
# every >=128 KB buffer on mmap, so freeing it returns the pages to the OS at
# once.  Measured on the OCR path: post-burst RSS 220 MB -> 42 MB without
# any trim, peak -25%.  Same as MALLOC_MMAP_THRESHOLD_=131072, but works on
# existing installs without touching the systemd unit; the env var wins.
_M_MMAP_THRESHOLD = -3
_MMAP_THRESHOLD_BYTES = 128 * 1024
if _libc is not None and not os.environ.get("MALLOC_MMAP_THRESHOLD_"):
    try:
        _libc.mallopt.argtypes = [ctypes.c_int, ctypes.c_int]
        _libc.mallopt.restype = ctypes.c_int
        _libc.mallopt(_M_MMAP_THRESHOLD, _MMAP_THRESHOLD_BYTES)
    except Exception:
        pass


def _reclaim_memory_sync():
    """Synchronous GC + malloc_trim — run in a thread to avoid blocking the event loop.

    Upstream request bodies are no longer kept alive by httpx's response
    cycle (see release_httpx_response), so payloads are freed by refcount;
    gc.collect() stays as a safety net for any other cycle."""
    gc.collect()
    if _libc is not None:
        try:
            _libc.malloc_trim(0)
        except Exception:
            pass


# gc.collect() holds the GIL for its whole run (tens of ms on a big heap), so
# running it after EVERY KB/OCR response — and awaiting it on the request path —
# stalled all other streams during ingestion bursts.  Reclamation is now
# coalesced: at most one run in flight, at most one run per interval, and the
# request never waits for it.  A burst still gets one trailing run, so RSS is
# returned to the OS shortly after the burst ends.
_RECLAIM_MIN_INTERVAL_SEC = 2.0
_reclaim_task: Optional[asyncio.Task] = None
_last_reclaim_mono: float = 0.0


async def _reclaim_runner():
    global _last_reclaim_mono
    wait = _last_reclaim_mono + _RECLAIM_MIN_INTERVAL_SEC - time.monotonic()
    if wait > 0:
        await asyncio.sleep(wait)
    try:
        await asyncio.to_thread(_reclaim_memory_sync)
    finally:
        _last_reclaim_mono = time.monotonic()


async def _reclaim_memory():
    """Request a (coalesced, throttled) malloc_trim(0).
    Returns immediately; the actual work runs in the background."""
    global _reclaim_task
    if _reclaim_task is not None and not _reclaim_task.done():
        return
    _reclaim_task = asyncio.create_task(_reclaim_runner())


def release_httpx_response(resp) -> None:
    """Break httpx's Response <-> BoundAsyncStream reference cycle.

    httpx binds every response's stream back to the response itself
    (response.stream = BoundAsyncStream(..., response=response)), and the
    response holds response.request, whose _content is the FULL upstream
    request body.  That cycle is invisible to reference counting, so every
    upstream body (a 20 MB OCR image, a long Agent context) stayed alive until
    the next generation-2 GC — the real reason RSS did not come back after an
    OCR batch without a forced gc.collect().  Call once the response has been
    fully consumed/closed; afterwards it is freed by refcount immediately."""
    if resp is None:
        return
    try:
        resp.stream = httpx.ByteStream(b"")
    except Exception:
        pass


class AllCandidatesFailedError(Exception):
    """Raised when all candidate keys have failed.

    Carries the last upstream HTTP status code and response body so that
    the proxy layer can forward the real upstream error to the client
    instead of a generic 503.
    """
    def __init__(self, message, last_status_code=None, last_response_body=None, errors=None,
                 trail: str = "", retry_after: Optional[float] = None):
        super().__init__(message)
        self.last_status_code = last_status_code
        self.last_response_body = last_response_body
        self.errors = errors or []
        self.trail = trail
        self.retry_after = retry_after


class GlobalOverloadError(Exception):
    """Raised when the global concurrency cap is saturated and the bounded
    queue wait timed out.  The proxy layer converts this to 503 +
    Retry-After so burst clients back off instead of hanging."""
    def __init__(self, retry_after: float = _GLOBAL_QUEUE_TIMEOUT_SEC, message: Optional[str] = None):
        super().__init__(
            message or (
                f"The proxy is at its global concurrency limit "
                f"({_global_semaphore_limit} in-flight upstream requests). "
                f"Retry after {retry_after:.0f}s."
            )
        )
        self.retry_after = retry_after


# Module-level in-memory state (persists across requests on the same instance)
_cooldown_until: Dict[str, float] = {}
_key_cooldown_until: Dict[str, float] = {}
_consecutive_failures: Dict[str, int] = {}
_last_failure_at: Dict[str, float] = {}
_quota_exhausted_cands: Set[str] = set()
# HTTP 410 Gone: the upstream retired this model.  Keyed by "provider:model"
# (not per key) because a retired model is gone for every key of that
# provider.  Value is the expiry timestamp (default 24 h, cooldown_410_sec).
# Deliberately survives reset_runtime_state() (/v1/reload) so a reload does
# not resurrect a retired model; it is only dropped when the provider/model
# leaves the config, or when the TTL expires.
_gone_models: Dict[str, float] = {}
DEFAULT_COOLDOWN_410_SEC = float(_AGENT_PROFILE.get("cooldown_410_sec", 86400.0))
_semaphores: Dict[str, asyncio.Semaphore] = {}
_semaphore_limits: Dict[str, int] = {}

# 冷宫（欠费 / Key 失效 / 封禁，默认 24h）落盘：重启或升级后不把已经确认没钱/失效的
# Key 重新放回轮换。只写剩余 >= 5 分钟的冷却，文件很小；手动测试该 Key 成功即解除。
_BAN_FILE_NAME = "key_bans.json"
LONG_BAN_SEC = 3600.0
_bans_loaded = False


def _bans_path() -> str:
    return os.path.join(os.environ.get("CONFIG_DIR") or "/opt/ocrproxy/config", _BAN_FILE_NAME)


def _load_bans() -> None:
    global _bans_loaded
    if _bans_loaded:
        return
    _bans_loaded = True
    try:
        with open(_bans_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return
    except Exception as e:
        logger.warning("key ban file unreadable: %s", e)
        return
    now = time.time()
    for k, exp in (data.get("keys") or {}).items():
        if isinstance(exp, (int, float)) and exp > now:
            _key_cooldown_until[k] = max(float(exp), _key_cooldown_until.get(k, 0.0))
    for k, exp in (data.get("cands") or {}).items():
        if isinstance(exp, (int, float)) and exp > now:
            _cooldown_until[k] = max(float(exp), _cooldown_until.get(k, 0.0))
    for k in data.get("quota") or []:
        if k in _cooldown_until:
            _quota_exhausted_cands.add(k)


def _save_bans() -> None:
    now = time.time()
    keep = now + 300.0
    data = {
        "keys": {k: v for k, v in _key_cooldown_until.items() if v >= keep},
        "cands": {k: v for k, v in _cooldown_until.items() if v >= keep},
    }
    data["quota"] = [k for k in _quota_exhausted_cands if k in data["cands"]]
    path = _bans_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except Exception as e:
        logger.warning("key ban file write failed: %s", e)


def clear_key_ban(provider: str, key_label: str, model: Optional[str] = None) -> bool:
    """手动测试成功后解除冷宫：Key 级冷却 + 该 Key 下的候选冷却（指定 model 时只清该候选）。"""
    _load_bans()
    changed = _key_cooldown_until.pop(f"{provider}:{key_label}", None) is not None
    prefix = f"{provider}:{key_label}:"
    for cid in list(_cooldown_until.keys()):
        if cid.startswith(prefix) and (model is None or cid == prefix + str(model)):
            _cooldown_until.pop(cid, None)
            _quota_exhausted_cands.discard(cid)
            _consecutive_failures.pop(cid, None)
            changed = True
    if changed:
        _save_bans()
    return changed

# Optional per-key RPM limiter (provider field `rpm_per_key`; absent/0 = off).
# "provider:key" -> monotonic timestamps of upstream dispatches in the last
# 60 s.  Each deque holds at most `rpm_per_key` entries, so memory is bounded
# by keys x rpm.  In-memory only: a restart forgets the counts (worst case one
# upstream 429, which then re-syncs the window).  Deliberately survives
# reset_runtime_state(): /v1/reload does not reset the upstream's own counter.
# Check-and-record happens synchronously (no await in between), so asyncio's
# single thread makes it race-free without locks.
RPM_WINDOW_SEC = 60.0
_rpm_windows: Dict[str, Deque[float]] = {}


def _provider_rpm(provider: Optional[dict]) -> int:
    if not isinstance(provider, dict):
        return 0
    try:
        return max(0, int(provider.get("rpm_per_key") or 0))
    except (ValueError, TypeError):
        return 0


def _rpm_window(key_id: str, now: float) -> Deque[float]:
    w = _rpm_windows.get(key_id)
    if w is None:
        w = deque()
        _rpm_windows[key_id] = w
    cutoff = now - RPM_WINDOW_SEC
    while w and w[0] <= cutoff:
        w.popleft()
    return w


def _rpm_wait(key_id: str, limit: int, now: Optional[float] = None) -> float:
    """Seconds until `key_id` has a free RPM slot (0 = free now / no limit)."""
    if limit <= 0:
        return 0.0
    now = time.monotonic() if now is None else now
    w = _rpm_window(key_id, now)
    if len(w) < limit:
        return 0.0
    # The slot frees when the (len-limit)-th oldest entry leaves the window.
    return max(0.0, w[len(w) - limit] + RPM_WINDOW_SEC - now)


def _rpm_try_acquire(key_id: str, limit: int) -> bool:
    """Record one upstream dispatch if a slot is free.  Synchronous on purpose."""
    if limit <= 0:
        return True
    now = time.monotonic()
    w = _rpm_window(key_id, now)
    if len(w) >= limit:
        return False
    w.append(now)
    return True


def _rpm_mark_exhausted(key_id: str, limit: int, min_backoff_sec: float = 15.0):
    """Upstream said 429 although our window had room: treat the key as full
    and guarantee at least min_backoff_sec (default 15s) cooldown so the next
    immediate request does not hammer the same key 1s later."""
    if limit <= 0:
        return
    now = time.monotonic()
    w = _rpm_window(key_id, now)
    # Ensure no slot in w frees within min_backoff_sec
    earliest_allowed = now - (RPM_WINDOW_SEC - min_backoff_sec)
    for i in range(len(w)):
        if w[i] < earliest_allowed:
            w[i] = earliest_allowed
    pad = max(earliest_allowed, w[0] if w else now)
    while len(w) < limit:
        w.appendleft(pad)


def get_rpm_usage() -> Dict[str, int]:
    """Requests counted in the current 60 s window per provider:key."""
    now = time.monotonic()
    return {k: len(_rpm_window(k, now)) for k in list(_rpm_windows.keys()) if _rpm_windows.get(k)}
_sem_lock = asyncio.Lock()

# Failure collapse window: merges burst disconnects/5xx within 3 seconds into a single failure event
FAILURE_COLLAPSE_WINDOW_SEC = 3.0

# Temporary rate-limiting keywords (TPM, RPM, QPS, rate limits, sliding window limits)
# These represent transient restrictions that auto-recover in seconds/minutes, NOT hard account arrears.
RATE_LIMIT_KEYWORDS = (
    "tpm", "rpm", "qps", "rate limit", "rate_limit", "ratelimit",
    "requests per minute", "tokens per minute", "tokens per day",
    "per minute", "per-minute", "per second", "per-second",
    "too many requests", "concurrency", "concurrent", "429001",
    "traffic control", "slow down", "try again later"
)

# Hard account-level quota exhaustion keywords (arrears, balance 0, free quota depleted, credit exhausted)
# Note: standalone 'exhausted' or 'quota' are deliberately excluded to avoid false positives with TPM limits.
HARD_QUOTA_KEYWORDS = (
    "insufficient_quota", "allocated quota exceeded", "exceeded your current quota",
    "credit balance is too low", "insufficient balance", "balance is insufficient",
    "balance not enough", "no balance", "account arrears", "account abnormal or account balance",
    "free usage limit exceeded", "daily free usage limit", "freeusagelimit",
    "free quota has been exhausted", "free quota exhausted", "free allowance exhausted",
    "free quota is exhausted", "quota has been exhausted", "allowance exhausted",
    "credit insufficient balance", "balance=0", "credit is 0", "credit depleted",
    "欠费", "余额不足", "配额不足", "额度不足", "账户欠费", "免费额度用尽", "免费额度已用完",
    "超出总额度", "超出配额限制"
)
QUOTA_EXHAUSTED_KEYWORDS = HARD_QUOTA_KEYWORDS

def _gone_key(provider: str, model: Optional[str]) -> str:
    return f"{provider}:{model}"


def _is_model_gone(provider: str, model: Optional[str]) -> bool:
    """True while provider:model is marked retired (HTTP 410); lazily expires."""
    gk = _gone_key(provider, model)
    expiry = _gone_models.get(gk)
    if expiry is None:
        return False
    if expiry <= time.time():
        _gone_models.pop(gk, None)
        return False
    return True


def _mark_model_gone(provider: str, model: Optional[str], ttl_sec: float):
    if ttl_sec <= 0:
        return
    _gone_models[_gone_key(provider, model)] = time.time() + ttl_sec


def get_gone_models() -> Dict[str, float]:
    """provider:model -> expiry timestamp for models the upstream retired (410)."""
    now = time.time()
    return {k: v for k, v in _gone_models.items() if v > now}


def is_key_cooling(provider: str, key_label: str, now: Optional[float] = None) -> bool:
    """True if provider:key is under key-level cooldown (401/403/quota); lazily prunes expired."""
    now = time.time() if now is None else now
    key_id = f"{provider}:{key_label}"
    exp = _key_cooldown_until.get(key_id)
    if exp is None:
        return False
    if exp <= now:
        _key_cooldown_until.pop(key_id, None)
        return False
    return True


def get_active_cooldowns() -> Dict[str, dict]:
    """Return candidates and keys currently cooling down or quota-exhausted."""
    now = time.time()
    res = {}
    for cand_id, expiry in list(_cooldown_until.items()):
        if expiry > now:
            prov, _, rest = cand_id.partition(":")
            model = rest.partition(":")[2]
            res[cand_id] = {
                "cooling": True,
                "expires_at": expiry,
                "is_quota": cand_id in _quota_exhausted_cands,
                "is_gone": _is_model_gone(prov, model),
            }
    for key_id, expiry in list(_key_cooldown_until.items()):
        if expiry > now:
            res[f"key:{key_id}"] = {
                "cooling": True,
                "is_key_level": True,
                "expires_at": expiry,
            }
    return res

# Key routing state
_sticky_agent_active_keys: Dict[str, str] = {}  # model_name -> active key label
_rr_kb_indices: Dict[str, int] = {}             # model_type -> round robin cursor for KB


def get_sticky_agent_active_key(model_name: str) -> Optional[str]:
    return _sticky_agent_active_keys.get(model_name)


def set_sticky_agent_active_key(model_name: str, key_label: str):
    _sticky_agent_active_keys[model_name] = key_label


# Config-version tracking: entries in the dicts above are pruned whenever the
# encrypted config changes on disk (removed keys/providers leave no residue,
# and a changed max_concurrency_per_key takes effect without a restart).
_last_config_version: int = -1

# Latency tracking for smart candidate ordering
# cand_id -> list of recent latencies (seconds)
_latency_history: Dict[str, list] = {}
_LATENCY_WINDOW = 10  # keep last 10 samples for rolling average

# Global reusable async client
_client: Optional[httpx.AsyncClient] = None
_client_lock = asyncio.Lock()


class ConcurrencyLease:
    """Manages the lifecycle of concurrency permits (per-key semaphore and global semaphore).

    Guarantees that permits are held throughout the entire lifecycle of a request,
    including long-lived streaming responses, and are released exactly once.
    """
    def __init__(self, key_sem: Optional[asyncio.Semaphore] = None, global_sem: Optional[asyncio.Semaphore] = None):
        self._key_sem = key_sem
        self._global_sem = global_sem
        self._released = False

    def release(self):
        if not self._released:
            self._released = True
            if self._global_sem is not None:
                try:
                    self._global_sem.release()
                except Exception:
                    pass
            if self._key_sem is not None:
                try:
                    self._key_sem.release()
                except Exception:
                    pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.release()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        self.release()


class ScheduleResult:
    def __init__(
        self,
        data: Any = None,
        raw_content: Optional[bytes] = None,
        stream_resp: Any = None,
        routed_via: str = "",
        fallback_attempts: int = 0,
        lease: Optional[ConcurrencyLease] = None,
        trail: str = "",
    ):
        self.trail = trail
        self._data = data
        self.raw_content = raw_content
        self.stream_resp = stream_resp
        self.routed_via = routed_via
        self.fallback_attempts = fallback_attempts
        self.lease = lease

    @property
    def data(self):
        if self._data is None and self.raw_content is not None:
            try:
                self._data = json.loads(self.raw_content.decode("utf-8"))
            except Exception:
                self._data = {}
            return self._data
        return self._data

    @data.setter
    def data(self, value):
        self._data = value



@dataclass
class FailureEvaluation:
    cooldown_sec: float
    is_quota: bool
    mark_provider_down: bool
    circuit_breaker_triggered: bool
    # HTTP 410: model permanently retired upstream for this provider.
    model_gone: bool = False


def evaluate_candidate_failure(
    status_code: int,
    is_quota: bool,
    is_key_issue_400: bool,
    category: str,
    consecutive_5xx_count: int,
    config_params: dict,
) -> FailureEvaluation:
    """
    Decoupled failure evaluation policy.
    Distinguishes Agent mode (no artificial freeze on transient 5xx/429; failover freely within budget)
    from KB mode (strict batch protection, circuit breakers, rate limit cool down).
    """
    is_agent = (category == "agent")
    # Defaults come from the active runtime profile (single table); explicit values win.
    _prof = runtime_profile.settings(config_params)
    cooldown_quota_sec = get_setting(config_params, "cooldown_quota_sec", _prof.get("cooldown_quota_sec", 86400.0))
    cooldown_tpm_sec = get_setting(config_params, "cooldown_429_sec", _prof.get("cooldown_429_sec", 60.0))
    cooldown_5xx_sec = get_setting(config_params, "cooldown_5xx_sec", _prof.get("cooldown_5xx_sec", 30.0))
    circuit_threshold = get_setting(config_params, "circuit_break_threshold", _prof.get("circuit_break_threshold", 3))
    circuit_cooldown_sec = get_setting(config_params, "circuit_cooldown_sec", _prof.get("circuit_cooldown_sec", 600.0))

    # 1. Hard Quota / Arrears: applies to both KB and Agent (account has no money/credits)
    if is_quota:
        return FailureEvaluation(
            cooldown_sec=cooldown_quota_sec,
            is_quota=True,
            mark_provider_down=False,
            circuit_breaker_triggered=False,
        )

    # 1b. 404 from this candidate (model delisted / wrong path for this
    # provider): park this candidate (provider:key:model) so later requests skip
    # it, for both Agent and KB modes.
    if status_code == 404:
        return FailureEvaluation(
            cooldown_sec=config_params.get("cooldown_404_sec", 600.0),
            is_quota=False,
            mark_provider_down=False,
            circuit_breaker_triggered=False,
        )

    # 1c. 410 Gone: the upstream permanently retired this model.  Unlike 404
    # (often a wrong path / transient delisting) this is explicit, so park the
    # candidate for a long time in both modes; the scheduler additionally
    # marks provider:model gone so every key of that provider is skipped.
    if status_code == 410:
        return FailureEvaluation(
            cooldown_sec=config_params.get("cooldown_410_sec", DEFAULT_COOLDOWN_410_SEC),
            is_quota=False,
            mark_provider_down=False,
            circuit_breaker_triggered=False,
            model_gone=True,
        )

    # 1d. 401/403（Key 失效、账号封禁、该 Key 无权访问此模型）：和欠费一样打入冷宫
    # （cooldown_quota_sec，默认 24h），Agent/KB 一致。参考 freellmapi：402/封禁/403 tier
    # 都按 1 天处理；new-api 直接自动禁用。模型级 403 只停这个候选（provider:key:model）。
    if status_code in (401, 403):
        return FailureEvaluation(
            cooldown_sec=cooldown_quota_sec,
            is_quota=False,
            mark_provider_down=False,
            circuit_breaker_triggered=False,
        )

    # 2. Agent Mode: Only hard quota or auth failure causes long cooldown. Transient errors do NOT freeze the key.
    if is_agent:
        # 429 with alternatives: honour Retry-After (capped at 60s) or apply 10s backoff cooldown
        retry_after = config_params.get("retry_after_sec")
        if status_code == 429 and config_params.get("has_alternatives", True):
            cd_val = min(float(retry_after), 60.0) if retry_after else 10.0
            return FailureEvaluation(
                cooldown_sec=cd_val,
                is_quota=False,
                mark_provider_down=False,
                circuit_breaker_triggered=False,
            )
        # Transient 5xx or network timeouts: 0s cooldown (do not lock out from future retries)
        return FailureEvaluation(
            cooldown_sec=0.0,
            is_quota=False,
            mark_provider_down=False,
            circuit_breaker_triggered=False,
        )

    # 3. KB Mode (High-concurrency batch ingestion protection)
    if status_code == 429:
        retry_after = config_params.get("retry_after_sec")
        return FailureEvaluation(
            cooldown_sec=max(cooldown_tpm_sec, min(float(retry_after), 300.0)) if retry_after else cooldown_tpm_sec,
            is_quota=False,
            mark_provider_down=False,
            circuit_breaker_triggered=False,
        )
    elif status_code == 400 and is_key_issue_400:
        return FailureEvaluation(
            cooldown_sec=10.0,
            is_quota=False,
            mark_provider_down=False,
            circuit_breaker_triggered=False,
        )
    elif status_code >= 500:
        is_circuit = consecutive_5xx_count >= circuit_threshold
        # 熔断只用一个参数 circuit_cooldown_sec（原来取 max(它, circuit_escalation_sec)，导致它在 KB 永远无效）
        cd = circuit_cooldown_sec if is_circuit else cooldown_5xx_sec
        mark_down = status_code in (502, 503, 504)
        return FailureEvaluation(
            cooldown_sec=cd,
            is_quota=False,
            mark_provider_down=mark_down,
            circuit_breaker_triggered=is_circuit,
        )

    return FailureEvaluation(
        cooldown_sec=0.0,
        is_quota=False,
        mark_provider_down=False,
        circuit_breaker_triggered=False,
    )


def get_candidate_id(cand: dict) -> str:
    return f"{cand['provider']}:{cand['key']}:{cand['model']}"


def _record_latency(cand_id: str, latency: float):
    """Record latency for a candidate, keeping a rolling window."""
    if cand_id not in _latency_history:
        _latency_history[cand_id] = []
    _latency_history[cand_id].append(latency)
    if len(_latency_history[cand_id]) > _LATENCY_WINDOW:
        _latency_history[cand_id] = _latency_history[cand_id][-_LATENCY_WINDOW:]


def _get_avg_latency(cand_id: str) -> float:
    """Get average latency for a candidate, or inf if unknown."""
    latencies = _latency_history.get(cand_id, [])
    if not latencies:
        return float('inf')  # unknown candidates get lowest priority
    return sum(latencies) / len(latencies)


def _sort_candidates_by_latency(candidates: list) -> list:
    """Sort candidates by average latency (fastest first).
    Candidates with no data keep their original relative order but
    are placed after those with known latency.
    """
    return [c for _, c in sorted(
        enumerate(candidates),
        key=lambda item: (_get_avg_latency(get_candidate_id(item[1])), item[0])
    )]


def _get_default_ua() -> str:
    """Load current version from version.json for the default User-Agent."""
    v = "1.0"
    for candidate_path in [
        os.path.join(os.path.dirname(__file__), "..", "version.json"),
        os.path.join(os.path.dirname(__file__), "..", "..", "version.json"),
    ]:
        if os.path.exists(candidate_path):
            try:
                with open(candidate_path, "r", encoding="utf-8") as f:
                    v = json.load(f).get("version", v)
                    break
            except Exception:
                pass
    return f"OCRProxy/{v}"


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(os.environ.get(name, default))))
    except (TypeError, ValueError):
        return default


_POOL_MAX_CONNECTIONS = _env_int("UPSTREAM_MAX_CONNECTIONS", 256, 16, 4096)
# How long a request may wait for a free pooled connection.  httpx defaults the
# pool wait to the *read* timeout (up to 120-600 s here), so a saturated pool
# looked like a hung upstream and was booked against a healthy key.
_POOL_WAIT_SEC = float(_env_int("UPSTREAM_POOL_WAIT_SEC", 10, 1, 120))


def _req_timeout(total_sec: float) -> httpx.Timeout:
    total_sec = max(1.0, float(total_sec))
    return httpx.Timeout(total_sec, connect=min(5.0, total_sec), pool=min(_POOL_WAIT_SEC, total_sec))


async def get_client() -> httpx.AsyncClient:
    """Get or create the global async HTTP client.

    The client uses a generous total timeout (300s); per-request timeouts are
    enforced via httpx.Timeout on individual requests, so this default never
    short-circuits a slow endpoint.
    """
    global _client
    if _client is not None:
        return _client
    async with _client_lock:
        if _client is None:
            _client = httpx.AsyncClient(
                timeout=httpx.Timeout(300.0, connect=5.0),
                headers={"User-Agent": _get_default_ua()},
                limits=httpx.Limits(
                    # Long Agent SSE streams pin one pooled connection each for
                    # minutes; 80 was reachable with a few IDE agents, after which
                    # every new request queued silently.  Override per VM size.
                    max_connections=_POOL_MAX_CONNECTIONS,
                    # Keep every pooled connection warm: closing idle ones above
                    # 20 forced a fresh TCP+TLS handshake (200-600 ms cross-border)
                    # on the next burst.
                    max_keepalive_connections=_POOL_MAX_CONNECTIONS,
                    # Many upstreams / CDNs drop idle keep-alive sockets after
                    # 5-15 s.  Re-using one of those yields RemoteProtocolError,
                    # which used to be booked as a 5xx against a healthy key.
                    keepalive_expiry=10.0,
                ),
                # NOTE: do not pass a custom `transport=` here — httpx then
                # ignores HTTP(S)_PROXY env vars, which some VMs rely on to
                # reach upstreams.
            )
        return _client


# Errors raised when a pooled keep-alive socket was already closed by the
# upstream (or an idle-timeout middlebox).  When they surface within a couple
# of seconds of sending, the request almost certainly never reached the model,
# so one immediate retry on the SAME candidate is safe and must not be counted
# against the key.
# Provider / CDN-level failures (the origin behind the CDN is busy or the edge
# could not reach it).  Another key of the SAME provider sits behind the same
# gateway, so in Agent sticky mode we back off and retry the same key first.
_PROVIDER_LEVEL_STATUSES = frozenset({502, 503, 504, 520, 521, 522, 523, 524, 529})
_PROVIDER_LEVEL_EXC = (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadError,
                       httpx.RemoteProtocolError, httpx.WriteError, httpx.WriteTimeout,
                       httpx.PoolTimeout)
_SAME_KEY_BACKOFF_SEC = (1.0, 2.0)
# Longest Retry-After an Agent sticky key is waited out on a transient 429
# before failing over to another key (and losing the upstream prompt cache).
_AGENT_SOFT_429_MAX_WAIT_SEC = 20.0

_STALE_CONN_ERRORS = (httpx.RemoteProtocolError, httpx.ReadError, httpx.WriteError)
_STALE_RETRY_WINDOW_SEC = 5.0


def _transport_error_status(e: Exception) -> Optional[int]:
    """Map an httpx transport failure to the gateway status a client retries."""
    if isinstance(e, httpx.TimeoutException):
        return 502 if isinstance(e, (httpx.ConnectTimeout, httpx.PoolTimeout)) else 504
    if isinstance(e, httpx.TransportError):
        return 502
    return None


async def _send_with_stale_retry(do_send: Callable[[], Any], cand_id: str):
    t0 = time.monotonic()
    try:
        return await do_send()
    except _STALE_CONN_ERRORS as e:
        if time.monotonic() - t0 > _STALE_RETRY_WINDOW_SEC:
            raise
        logger.debug("Stale pooled connection for %s (%s: %s) — retrying once on a fresh connection",
                    cand_id, type(e).__name__, e)
        return await do_send()


def _parse_retry_after(value: Optional[str]) -> Optional[float]:
    """Parse a Retry-After header (delta-seconds or HTTP-date) to seconds."""
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(value)
        return max(0.0, dt.timestamp() - time.time())
    except Exception:
        return None


class StreamInterruptedError(Exception):
    """Upstream stream broke after the first byte was already sent to the
    client (failover is no longer possible).  proxy_routes turns this into a
    terminal SSE error event so the client sees an error instead of a silently
    truncated answer."""
    def __init__(self, message: str, bytes_sent: int = 0):
        super().__init__(message)
        self.bytes_sent = bytes_sent


async def _guard_stream(remainder, first_len: int, on_error: Callable[[Exception, int], None]):
    """Pass chunks through; on an upstream error after the first byte, report
    it (stats/latency) and raise StreamInterruptedError."""
    sent = first_len
    try:
        async for chunk in remainder:
            sent += len(chunk)
            yield chunk
    except (asyncio.CancelledError, GeneratorExit):
        raise
    except Exception as e:
        try:
            on_error(e, sent)
        except Exception:
            logger.debug("stream error callback failed", exc_info=True)
        raise StreamInterruptedError(f"{type(e).__name__}: {e}", bytes_sent=sent) from e


async def close_client():
    global _client
    async with _client_lock:
        if _client is not None:
            await _client.aclose()
            _client = None


async def get_key_semaphore(key_id: str, limit: int) -> asyncio.Semaphore:
    """Get (or recreate) the per-key semaphore.

    The limit is tracked per key so that changing max_concurrency_per_key in
    the admin panel takes effect without a service restart.  Recreating a
    semaphore that has waiters briefly over-subscribes the old limit — an
    acceptable trade-off for a manual config change."""
    async with _sem_lock:
        existing = _semaphores.get(key_id)
        if existing is None or _semaphore_limits.get(key_id) != limit:
            existing = asyncio.Semaphore(limit)
            _semaphores[key_id] = existing
            _semaphore_limits[key_id] = limit
        return existing


def _prune_runtime_state(config: dict):
    """Drop scheduler state for candidates/keys no longer present in config.

    Called automatically whenever the config version changes (disk reload or
    admin save).  Without this, removed keys leave cooldown/circuit-breaker/
    latency entries behind forever, and a changed max_concurrency_per_key
    would keep living in the already-created semaphore objects.
    """
    global _last_config_version
    valid_cand_ids = set()
    valid_key_ids = set()
    valid_gone_keys = set()
    for cands in config.get("candidates", {}).values():
        for cand in cands:
            try:
                valid_cand_ids.add(get_candidate_id(cand))
                valid_key_ids.add(f"{cand['provider']}:{cand['key']}")
                valid_gone_keys.add(_gone_key(cand['provider'], cand.get('model')))
            except KeyError:
                continue
    # Retired (410) models stay retired across config reloads; only forget
    # them once the provider/model is no longer configured at all.
    for k in list(_gone_models.keys()):
        if k not in valid_gone_keys:
            del _gone_models[k]
    valid_agent_models = set(config.get("agent_models", {}).keys())
    for state in (_cooldown_until, _consecutive_failures, _last_failure_at, _latency_history, _stall_strikes):
        for k in list(state.keys()):
            if k not in valid_cand_ids:
                del state[k]
    _quota_exhausted_cands.intersection_update(valid_cand_ids)
    for k in list(_key_cooldown_until.keys()):
        if k not in valid_key_ids:
            del _key_cooldown_until[k]
    for k in list(_semaphores.keys()):
        if k not in valid_key_ids:
            del _semaphores[k]
            _semaphore_limits.pop(k, None)
    for k in list(_rpm_windows.keys()):
        if k not in valid_key_ids:
            del _rpm_windows[k]
    for m in list(_sticky_agent_active_keys.keys()):
        if m not in valid_agent_models:
            del _sticky_agent_active_keys[m]
    for m, m_cfg in (config.get("agent_models") or {}).items():
        if isinstance(m_cfg, dict) and m_cfg.get("active_key"):
            cfg_ak = m_cfg["active_key"]
            _sticky_agent_active_keys[m] = cfg_ak
            stats.set_agent_active_key(m, cfg_ak)
    _last_config_version = get_config_version()


def reset_runtime_state():
    """Clear ALL runtime scheduling state (cooldowns, circuit breakers,
    latency history, per-key semaphores, sticky and round-robin indices).

    Used by POST /v1/reload to give a freshly reloaded config a clean slate.
    In-flight requests keep references to the old semaphore objects, so the
    effective per-key limit may briefly double — acceptable for a manual
    ops action."""
    _load_bans()
    _cooldown_until.clear()
    _key_cooldown_until.clear()
    _consecutive_failures.clear()
    _last_failure_at.clear()
    _quota_exhausted_cands.clear()
    _latency_history.clear()
    _stall_strikes.clear()
    _semaphores.clear()
    _semaphore_limits.clear()
    _sticky_agent_active_keys.clear()
    _rr_kb_indices.clear()
    _save_bans()


async def _peek_first_chunk(resp: httpx.Response):
    """Read the first chunk of a streaming response WITHOUT consuming the
    stream iterator.

    Returns (first_chunk, remainder_iterator, error_message).  The remainder
    iterator is the SAME generator the response was being iterated with —
    calling resp.aiter_bytes() again after a partial iteration would raise
    StreamConsumed, so the live generator is handed back for the eventual
    StreamingResponse to continue from."""
    gen = resp.aiter_bytes()
    try:
        async for chunk in gen:
            # returning from inside `async for` does NOT close the generator;
            # keeping this reference alive keeps the stream resumable
            return chunk, gen, None
    except httpx.HTTPError as e:
        return b"", None, f"stream broke before first byte ({type(e).__name__}: {e})"
    return b"", None, None  # stream ended with zero bytes


# ---------------------------------------------------------------------------
# First-payload detection (stream turn integrity)
#
# A 2xx stream is only committed to the client once it has produced a real
# payload (content / reasoning / tool-call delta).  Until then we keep
# buffering the preamble (role-only deltas, ': keep-alive' comments,
# usage-only frames, Anthropic message_start / ping) so that
#   * an in-band error frame sent with HTTP 200 fails over to the next
#     candidate instead of being forwarded as the "answer", and
#   * a stream that ends without any payload (empty completion) fails over.
# If the first-byte deadline passes while only preamble has arrived the
# stream is committed exactly as before (hidden-reasoning models may stay
# silent behind keep-alives for a long time — never kill those).
# ---------------------------------------------------------------------------
_PEEK_MAX_BUFFER = 64 * 1024

_OPENAI_PAYLOAD_DELTA_KEYS = ("content", "reasoning_content", "reasoning", "tool_calls", "function_call", "audio")


def _sse_event_verdict(data: str):
    """Classify one SSE `data:` payload.

    Returns ("payload"|"preamble"|"error"|"done"|"unknown", error_json_or_None)."""
    data = data.strip()
    if not data:
        return "preamble", None
    if data == "[DONE]":
        return "done", None
    try:
        obj = json.loads(data)
    except Exception:
        return "unknown", None
    if not isinstance(obj, dict):
        return "unknown", None
    # In-band errors: OpenAI-style {"error": {...}} without choices, or
    # Anthropic {"type": "error", "error": {...}}.
    if obj.get("type") == "error" or (obj.get("error") and not obj.get("choices")):
        return "error", obj
    choices = obj.get("choices")
    if isinstance(choices, list):
        for ch in choices:
            if not isinstance(ch, dict):
                continue
            if ch.get("text"):  # legacy completions
                return "payload", None
            delta = ch.get("delta") or ch.get("message") or {}
            if isinstance(delta, dict):
                for k in _OPENAI_PAYLOAD_DELTA_KEYS:
                    if delta.get(k):
                        return "payload", None
            if ch.get("finish_reason") in ("length", "content_filter", "tool_calls", "function_call"):
                # A deliberate non-"stop" finish is a real (if empty) answer.
                return "payload", None
        return "preamble", None  # role-only / usage-only / empty delta
    t = obj.get("type")
    if isinstance(t, str):
        if t in ("message_start", "ping", "content_block_stop", "message_delta"):
            return "preamble", None
        if t == "message_stop":
            return "done", None
        if t == "content_block_start":
            cb = obj.get("content_block") or {}
            if isinstance(cb, dict) and cb.get("type") in ("tool_use", "server_tool_use"):
                return "payload", None
            return "preamble", None
        if t == "content_block_delta":
            d = obj.get("delta") or {}
            if isinstance(d, dict) and any(d.get(k) for k in ("text", "thinking", "partial_json")):
                return "payload", None
            return "preamble", None
    return "unknown", None


def _scan_sse_prefix(buf: bytes, final: bool = False):
    """Scan buffered SSE bytes. Returns (verdict, error_obj).

    verdict: "payload" | "error" | "empty" | "pending" | "unknown"
    "unknown" means the body does not look like SSE we understand — commit
    and stream it untouched."""
    try:
        text = buf.decode("utf-8", errors="replace")
    except Exception:
        return "unknown", None
    stripped = text.lstrip()
    if stripped and not (stripped.startswith("data:") or stripped.startswith("event:")
                         or stripped.startswith(":") or stripped.startswith("id:")
                         or stripped.startswith("retry:")):
        return "unknown", None
    text = text.replace("\r\n", "\n")
    events = text.split("\n\n")
    if not final:
        events = events[:-1]  # last piece may be incomplete
    saw_done = False
    for ev in events:
        data_lines = [ln[5:].lstrip() if ln.startswith("data:") else None for ln in ev.split("\n")]
        data_lines = [d for d in data_lines if d is not None]
        if not data_lines:
            continue
        verdict, err = _sse_event_verdict("\n".join(data_lines))
        if verdict == "payload":
            return "payload", None
        if verdict == "error":
            return "error", err
        if verdict == "unknown":
            return "unknown", None
        if verdict == "done":
            saw_done = True
    if saw_done or final:
        return "empty", None
    return "pending", None


async def _resume_after(pending: "asyncio.Task", gen):
    """Continue a stream whose next __anext__ is already in flight."""
    try:
        chunk = await pending
    except StopAsyncIteration:
        return
    yield chunk
    async for chunk in gen:
        yield chunk


async def _peek_until_payload(resp: httpx.Response, deadline_mono: float):
    """Buffer a 2xx stream until its first real payload.

    Returns (buffered_bytes, remainder_iter, verdict, info):
      verdict "payload"  — commit; buffered bytes + remainder are the stream
      verdict "preamble" — deadline reached with only preamble; commit anyway
      verdict "unknown"  — not SSE we understand / buffer cap; commit
      verdict "error"    — in-band error frame; info = error json (dict)
      verdict "empty"    — stream ended without any payload
      verdict "none"     — zero bytes before deadline/close; info = reason str or None
    """
    gen = resp.aiter_bytes()
    it = gen.__aiter__()
    buf = bytearray()
    pending = None
    while True:
        remaining = deadline_mono - time.monotonic()
        if remaining <= 0:
            if not buf:
                if pending is not None:
                    pending.cancel()
                return b"", None, "none", "timeout"
            rem = _resume_after(pending, it) if pending is not None else it
            return bytes(buf), rem, "preamble", None
        if pending is None:
            pending = asyncio.ensure_future(it.__anext__())
        done, _ = await asyncio.wait([pending], timeout=remaining)
        if not done:
            continue  # loop re-checks the deadline
        try:
            chunk = pending.result()
        except StopAsyncIteration:
            pending = None
            if not buf:
                return b"", None, "none", None
            verdict, err = _scan_sse_prefix(bytes(buf), final=True)
            if verdict == "error":
                return bytes(buf), None, "error", err
            if verdict in ("payload", "unknown"):
                return bytes(buf), None, verdict, None
            return bytes(buf), None, "empty", None
        except httpx.HTTPError as e:
            pending = None
            if not buf:
                return b"", None, "none", f"stream broke before first byte ({type(e).__name__}: {e})"
            return bytes(buf), None, "empty", f"stream broke before first payload ({type(e).__name__}: {e})"
        pending = None
        if not chunk:
            continue
        buf.extend(chunk)
        verdict, err = _scan_sse_prefix(bytes(buf))
        if verdict == "error":
            return bytes(buf), None, "error", err
        if verdict in ("payload", "unknown"):
            return bytes(buf), it, verdict, None
        if verdict == "empty":
            return bytes(buf), None, "empty", None
        if len(buf) > _PEEK_MAX_BUFFER:
            return bytes(buf), it, "unknown", None


def _inband_status(err_obj) -> int:
    """Map an in-band error frame to an HTTP-like status for the failure policy."""
    e = err_obj.get("error") if isinstance(err_obj, dict) else None
    cand = []
    if isinstance(e, dict):
        cand += [e.get("code"), e.get("status"), e.get("http_code")]
        t = str(e.get("type") or "").lower()
        if "overloaded" in t:
            return 503
        if "rate_limit" in t:
            return 429
        if "authentication" in t or "permission" in t:
            return 401
        if "invalid_request" in t:
            return 400
    for c in cand:
        try:
            n = int(c)
            if 400 <= n <= 599:
                return n
        except (TypeError, ValueError):
            continue
    return 502


_NONSTREAM_PAYLOAD_KEYS = ("choices", "data", "results", "content", "output", "candidates", "embeddings", "result")


def _nonstream_inband_error(raw: bytes):
    """HTTP 2xx body that is really an error object -> parsed dict, else None."""
    if not raw or len(raw) > _PEEK_MAX_BUFFER:
        return None
    head = raw.lstrip()[:1]
    if head != b"{":
        return None
    try:
        obj = json.loads(raw)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    is_err = obj.get("type") == "error" or bool(obj.get("error"))
    if not is_err or any(obj.get(k) for k in _NONSTREAM_PAYLOAD_KEYS):
        return None
    return obj


# Agent-mode stall ladder: a candidate that burned its whole first-byte window
# (or could not even connect) is benched briefly so priority/latency strategies
# stop paying the full timeout on every request.  Reset on the first success.
_STALL_LADDER_SEC = (30.0, 120.0, 600.0)
_STALL_DECAY_SEC = 1800.0
_stall_strikes: Dict[str, Tuple[int, float]] = {}


def _stall_bench_seconds(cand_id: str) -> float:
    now = time.time()
    n, last = _stall_strikes.get(cand_id, (0, 0.0))
    if now - last > _STALL_DECAY_SEC:
        n = 0
    n += 1
    _stall_strikes[cand_id] = (n, now)
    return _STALL_LADDER_SEC[min(n, len(_STALL_LADDER_SEC)) - 1]


def compute_request_budget(min_single_attempt: float, max_retries: int, num_candidates: int,
                           raw_cap=None) -> float:
    """Total wall-clock budget for one scheduled request.

    budget = single-attempt timeout × min(max_retries, candidates) (+ small slack),
    never below one full attempt, never above 600 s, and capped by the optional
    `request_total_budget_sec`. When ≥2 attempts are possible and the cap allows it,
    at least two full attempts are guaranteed so failover is never starved.
    """
    min_single_attempt = max(1.0, float(min_single_attempt))
    num_candidates = max(1, int(num_candidates or 1))
    eff_retries = min(max(1, int(max_retries or 1)), num_candidates)

    endpoint_budget = min_single_attempt * eff_retries + (5.0 if eff_retries > 1 else 2.0)
    endpoint_budget = max(min_single_attempt, min(600.0, endpoint_budget))

    max_cap = 600.0
    if raw_cap is not None:
        try:
            cfg_cap = float(raw_cap)
            if cfg_cap > 0:
                max_cap = max(min_single_attempt, cfg_cap)
        except (ValueError, TypeError):
            pass

    total = max(min_single_attempt, min(endpoint_budget, max_cap))
    if eff_retries >= 2:
        safe_min_failover = min_single_attempt * 2
        if max_cap >= safe_min_failover:
            total = max(total, safe_min_failover)
    return total

async def schedule(
    config: dict,
    model_type: str,
    build_request: Callable[[dict, str, str], tuple],
    handle_stream: Optional[Callable[[httpx.Response], Any]] = None,
    is_stream: bool = False,
    category: str = "kb",
    request_model: Optional[str] = None,
) -> ScheduleResult:
    """
    Core scheduler logic. Iterates candidates, runs failover logic, cooldown, and budget check.
    Records stats directly to in-memory stats module with Agent vs KB isolation.
    """
    req_model_name = request_model or model_type
    _attempted_upstream = False
    _metrics_tr = agent_metrics.current() if category == "agent" else None
    if _metrics_tr is not None:
        _metrics_tr.note_schedule(req_model_name)
    candidates = config.get("candidates", {}).get(model_type, [])
    if not candidates:
        try:
            stats.record_gateway_error(model_type, 503, f"No active candidates configured for model type: {model_type}", category)
        except Exception:
            logger.debug("no-candidates stats.record_gateway_error failed", exc_info=True)
        raise RuntimeError(f"No active candidates configured for model type: {model_type}")

    _load_bans()
    # Prune stale runtime state (cooldowns, semaphores, ...) when the config
    # changed on disk — near-zero cost thanks to the version check.
    v = get_config_version()
    if v != _last_config_version:
        _prune_runtime_state(config)

    # Determine routing strategy based on category
    if category == "agent":
        strategy = config.get("agent_routing_strategy", "sticky_failover")
        # Agent mode supports only sticky_failover and manual; legacy values
        # (round_robin / priority_fallback / latency_based / random) fall back
        # to sticky_failover.
        if strategy != "manual":
            strategy = "sticky_failover"
    else:
        strategy = config.get("kb_routing_strategy", "round_robin")
        # KB mode supports only round_robin and manual; legacy values
        # (sticky_failover / priority_fallback / latency_based) fall back to round_robin.
        if strategy != "manual":
            strategy = "round_robin"

    # Candidate ordering based on strategy
    num_cands = len(candidates)
    ordered_items = list(enumerate(candidates))  # (orig_idx, cand)

    if strategy == "manual":
        # In manual mode: strictly pin to active_key, no failover
        active_key = (
            _sticky_agent_active_keys.get(req_model_name)
            or config.get("agent_models", {}).get(req_model_name, {}).get("active_key")
            or stats.get_agent_active_key(req_model_name)
        )
        if active_key:
            matched = [item for item in ordered_items if item[1]["key"] == active_key or f"{item[1]['provider']}:{item[1]['key']}" == active_key]
            ordered_items = matched[:1] if matched else ordered_items[:1]
        else:
            ordered_items = ordered_items[:1]
    elif strategy == "sticky_failover":
        active_key = (
            _sticky_agent_active_keys.get(req_model_name)
            or config.get("agent_models", {}).get(req_model_name, {}).get("active_key")
            or stats.get_agent_active_key(req_model_name)
        )
        if active_key:
            match_idx = -1
            for idx, (_, cand) in enumerate(ordered_items):
                if cand["key"] == active_key or f"{cand['provider']}:{cand['key']}" == active_key:
                    match_idx = idx
                    break
            if match_idx > 0:
                ordered_items = ordered_items[match_idx:] + ordered_items[:match_idx]
    elif strategy == "round_robin":
        rr_idx = _rr_kb_indices.get(model_type, 0) % num_cands
        _rr_kb_indices[model_type] = (rr_idx + 1) % num_cands
        ordered_items = ordered_items[rr_idx:] + ordered_items[:rr_idx]
    elif strategy == "latency_based":
        ordered_items = sorted(
            ordered_items,
            key=lambda item: (_get_avg_latency(get_candidate_id(item[1])), item[0])
        )
    else:  # "priority_fallback"
        pass  # keep original configured order

    # Candidate deduplication: eliminate identical candidates in the list so duplicate configs do not burn retries
    seen_cand_ids = set()
    deduped_items = []
    for orig_idx, cand in ordered_items:
        cid = get_candidate_id(cand)
        if cid in seen_cand_ids:
            continue
        seen_cand_ids.add(cid)
        deduped_items.append((orig_idx, cand))
    ordered_items = deduped_items

    # Prefer candidates whose key still has a free concurrency slot: a
    # saturated key used to block the request for up to 10 s before the next
    # candidate was even tried.  Stable partition keeps the strategy's order
    # among free (and among saturated) candidates.  Manual/sticky single-item
    # lists are unaffected.
    if len(ordered_items) > 1:
        def _saturated(item):
            c = item[1]
            sem_ = _semaphores.get(f"{c.get('provider', '')}:{c.get('key', '')}")
            return sem_ is not None and sem_.locked()
        _free = [it for it in ordered_items if not _saturated(it)]
        if _free and len(_free) < len(ordered_items):
            ordered_items = _free + [it for it in ordered_items if _saturated(it)]

    providers = config.get("providers", {})

    # Profile defaults (shared/config/runtime-profiles.json) resolved once per request;
    # explicit config values always win via get_setting().
    _sched_prof = runtime_profile.settings(config)

    # Load settings from config with safe fallback and clamping
    try:
        # Per-request timeout (set by each endpoint in proxy_routes: OCR, KB chat,
        # embedding, rerank, agent chat) takes precedence over the global
        # `upstream_timeout_sec`.  The internal key is `request_timeout_sec` (it is
        # never persisted), so it cannot be confused with the saved KB chat timeout.
        _route_timeout = config.get("request_timeout_sec")
        upstream_timeout_sec = max(1.0, float(
            _route_timeout if _route_timeout not in (None, "") else get_setting(config, "upstream_timeout_sec", 15.0)))
    except (ValueError, TypeError):
        upstream_timeout_sec = 15.0

    try:
        agent_first_byte_timeout_sec = max(1.0, float(get_setting(config, "agent_first_byte_timeout_sec", 120.0)))
    except (ValueError, TypeError):
        agent_first_byte_timeout_sec = 120.0

    # v20261023-03 timeout model: 固定 300s 硬总超时；自动轮换逐个候选 Key 试完，
    # 成功 / 试完 / 300s 谁先到谁结束。不再有 max_retries / max_attempts_per_provider
    # 这类会隐式截断候选 Key 的配置。
    HARD_TIMEOUT_SEC = 300.0
    max_retries = max(1, len(ordered_items))
    max_attempts_per_provider = 10 ** 9
    min_single_attempt = agent_first_byte_timeout_sec if category == "agent" else upstream_timeout_sec
    total_budget_sec = HARD_TIMEOUT_SEC

    # 不再作为用户配置：只在配置了多个供应商时才跳过同供应商其余 Key（见下方 _multi_provider 判断）。
    fast_failover_provider_down = True
    provider_attempts: Dict[str, int] = {}
    down_providers: Set[str] = set()

    if strategy == "manual":
        # 粘性场景：单 Key 直通，不轮换；VM 纯中转但保留 300s 安全硬超时。
        if category == "agent":
            upstream_timeout_sec = 300.0
        else:
            upstream_timeout_sec = min(300.0, upstream_timeout_sec)
        total_budget_sec = 300.0

    # Per-key in-flight cap.  Agent: 0 (default) = no local cap, so a session
    # never spills to another key just because the sticky key is busy (that
    # loses the prompt cache); the upstream signals real limits with 429.
    # KB: high default so ~10 parallel KB calls on one key are not serialised.
    if category == "agent":
        try:
            _agent_cap = int(get_setting(config, "agent_max_concurrency_per_key", 0) or 0)
        except (ValueError, TypeError):
            _agent_cap = 0
        concurrency_limit = _agent_cap if _agent_cap > 0 else _UNLIMITED_KEY_CONCURRENCY
    else:
        try:
            concurrency_limit = max(1, int(get_setting(config, "kb_max_concurrency_per_key", _KB_DEFAULT_KEY_CONCURRENCY)))
        except (ValueError, TypeError):
            concurrency_limit = _KB_DEFAULT_KEY_CONCURRENCY

    try:
        kb_global_limit = max(1, int(get_setting(config, "kb_global_max_concurrency", _sched_prof.get("kb_global_max_concurrency", _GLOBAL_MAX_CONCURRENCY))))
    except (ValueError, TypeError):
        kb_global_limit = _GLOBAL_MAX_CONCURRENCY

    # Once a stream has produced its first byte, upstream silence of up to
    # this many seconds is tolerated (long thinking, large tool-call argument
    # generation).  The first byte itself is still bounded by the per-key
    # timeout so a dead key fails over quickly.
    try:
        stream_idle_timeout_sec = max(1.0, float(config.get("stream_idle_timeout_sec", 300.0)))
    except (ValueError, TypeError):
        stream_idle_timeout_sec = 300.0

    try:
        cooldown_404_sec = max(0.0, float(get_setting(config, "cooldown_404_sec", _sched_prof.get("cooldown_404_sec", 600.0))))
    except (ValueError, TypeError):
        cooldown_404_sec = 600.0

    # 410 Gone (model retired upstream) - default 24 h; 0 disables parking.
    try:
        cooldown_410_sec = max(0.0, float(get_setting(config, "cooldown_410_sec", _sched_prof.get("cooldown_410_sec", DEFAULT_COOLDOWN_410_SEC))))
    except (ValueError, TypeError):
        cooldown_410_sec = DEFAULT_COOLDOWN_410_SEC

    # 429 TPM Rate Limit Cooldown (default 60s)
    try:
        cooldown_tpm_sec = max(1.0, float(get_setting(config, "cooldown_429_sec", _sched_prof.get("cooldown_429_sec", 60.0))))
    except (ValueError, TypeError):
        cooldown_tpm_sec = 60.0

    # 429/403 Quota Exhaustion Cooldown (default 1800s / 30m)
    try:
        cooldown_quota_sec = max(1.0, float(get_setting(config, "cooldown_quota_sec", _sched_prof.get("cooldown_quota_sec", 86400.0))))
    except (ValueError, TypeError):
        cooldown_quota_sec = 86400.0

    # 401/403 不再单独配置：与欠费共用 cooldown_quota_sec（冷宫）。
    cooldown_403_sec = cooldown_quota_sec

    # 5xx Server Error Cooldown (default 30s)
    try:
        cooldown_5xx_sec = max(1.0, float(get_setting(config, "cooldown_5xx_sec", 30.0)))
    except (ValueError, TypeError):
        cooldown_5xx_sec = 30.0

    cooldown_read_timeout = 2.0

    # Circuit breaker threshold (only for genuine 5xx server failures / crash)
    try:
        circuit_break_threshold = max(1, int(get_setting(config, "circuit_break_threshold", 3)))
    except (ValueError, TypeError):
        circuit_break_threshold = 3

    try:
        circuit_cooldown = max(1.0, float(get_setting(config, "circuit_cooldown_sec", _sched_prof.get("circuit_cooldown_sec", 600.0))))
    except (ValueError, TypeError):
        circuit_cooldown = 600.0

    cooldown_cfg = {
        "cooldown_quota_sec": cooldown_quota_sec,
        "cooldown_tpm_sec": cooldown_tpm_sec,
        "cooldown_403_sec": cooldown_403_sec,
        "cooldown_5xx_sec": cooldown_5xx_sec,
        "circuit_break_threshold": circuit_break_threshold,
        "circuit_cooldown_sec": circuit_cooldown,
        "cooldown_410_sec": cooldown_410_sec,
    }

    start_monotonic = time.monotonic()
    deadline = start_monotonic + total_budget_sec
    errors = []
    # Compact per-attempt trail for the X-Fallback-Trail header / diagnostics.
    trail: List[str] = []

    def _trail_add(prov: str, key: str, cls: str):
        if len(trail) < 10:
            trail.append(f"{prov}/{key}={cls}")

    _has_alternatives = len(ordered_items) > 1
    _multi_provider = len({c.get("provider") for _, c in ordered_items}) > 1
    attempt_seq = 0
    last_status_code = None
    last_err_body = None

    client = await get_client()
    # Per-request timeout: use a separate httpx.Timeout so that OCR (which
    # passes a longer upstream_timeout via config override) gets more time.
    req_timeout = _req_timeout(upstream_timeout_sec)

    # Agent sticky mode: same-key retries for provider/CDN-level failures.
    try:
        same_key_retries = max(0, int(config.get("agent_same_key_retries", 2)))
    except (ValueError, TypeError):
        same_key_retries = 2
    _same_key_retry_count: Dict[str, int] = {}
    _same_key_retry_ids: Set[str] = set()
    last_transport_status: Optional[int] = None
    _queue: List[Any] = []
    _qi = 0
    # Candidates skipped because their key hit rpm_per_key: cand_id -> wall-clock
    # time when a slot frees.  Kept out of `errors` (no upstream was tried).
    _rpm_blocked: Dict[str, float] = {}

    _same_key_backoff_override: Dict[str, float] = {}
    _oauth_refreshed: Set[str] = set()

    def _maybe_retry_same_key(orig_idx_, cand_, cid_, min_backoff: float = 0.0) -> bool:
        if category != "agent" or strategy != "sticky_failover" or same_key_retries <= 0:
            return False
        n = _same_key_retry_count.get(cid_, 0)
        if n >= same_key_retries:
            return False
        base = _SAME_KEY_BACKOFF_SEC[min(n, len(_SAME_KEY_BACKOFF_SEC) - 1)]
        backoff = max(base, float(min_backoff or 0.0))
        if deadline - time.monotonic() < backoff + 3.0:
            return False
        if backoff > base:
            _same_key_backoff_override[cid_] = backoff
        _same_key_retry_count[cid_] = n + 1
        _same_key_retry_ids.add(cid_)
        _queue.insert(_qi, (orig_idx_, cand_))
        logger.info("Agent sticky: provider-level failure on %s, retrying same key in %.0fs (%d/%d)",
                    cid_, backoff, n + 1, same_key_retries)
        return True

    for loop_idx in range(2):
        _queue = list(ordered_items)
        _qi = 0
        while _qi < len(_queue):
            orig_idx, cand = _queue[_qi]
            _qi += 1
            # Check maximum retry budget
            if attempt_seq >= max_retries:
                logger.debug("Reached maximum candidate retry limit (%d attempts)", max_retries)
                errors.append(f"max_retries_{max_retries}_reached")
                break

            # 1. Total budget check (Monotonic)
            now_mono = time.monotonic()
            if now_mono >= deadline:
                elapsed = now_mono - start_monotonic
                logger.warning(f"Failover budget exhausted. Elapsed: {elapsed:.2f}s >= budget {total_budget_sec}s")
                errors.append(f"budget_exhausted_after_{elapsed:.2f}s")
                break
            remaining_budget = deadline - now_mono
            if remaining_budget <= 0.2:
                errors.append(f"budget_exhausted_after_{now_mono - start_monotonic:.2f}s")
                break

            cand_id = get_candidate_id(cand)
            provider_name = cand["provider"]
            key_label = cand["key"]
            cand_model_name = cand.get("model")

            _is_same_key_retry = cand_id in _same_key_retry_ids
            if _is_same_key_retry:
                _same_key_retry_ids.discard(cand_id)
                _n = _same_key_retry_count.get(cand_id, 1)
                _bo = _same_key_backoff_override.pop(cand_id, None) or _SAME_KEY_BACKOFF_SEC[min(_n - 1, len(_SAME_KEY_BACKOFF_SEC) - 1)]
                await asyncio.sleep(max(0.0, min(_bo, deadline - time.monotonic() - 1.0)))

            # Provider down fast failover
            if not _is_same_key_retry and fast_failover_provider_down and provider_name in down_providers:
                logger.debug("Skipping candidate %s — provider %s marked down for this request", cand_id, provider_name)
                continue

            # Per-provider attempt limit
            if not _is_same_key_retry and provider_attempts.get(provider_name, 0) >= max_attempts_per_provider:
                logger.debug("Skipping candidate %s — reached max %d attempts for provider %s", cand_id, max_attempts_per_provider, provider_name)
                continue

            # 2. Cooldown check (Key-level and Candidate-level)
            key_id = f"{provider_name}:{key_label}"
            key_cd_expiry = _key_cooldown_until.get(key_id, 0.0)
            if not _is_same_key_retry and time.time() < key_cd_expiry:
                logger.debug(f"Skipping candidate {cand_id} - key {key_id} cooling down until {key_cd_expiry}")
                continue

            cooldown_expiry = _cooldown_until.get(cand_id, 0.0)
            if not _is_same_key_retry and time.time() < cooldown_expiry:
                logger.debug(f"Skipping candidate {cand_id} - cooling down until {cooldown_expiry}")
                continue

            # 2b. Model retired upstream (HTTP 410) for this provider: skip every
            # key, even when the client named the model explicitly.
            if _is_model_gone(provider_name, cand_model_name):
                logger.debug("Skipping candidate %s - model %s retired by %s (410)", cand_id, cand_model_name, provider_name)
                continue

            # 不在请求路径上向中枢懒拉取：供应商与 Key 只在用户「新增供应商」时一次性拉取到本地，
            # 本地删掉的就是删掉了，调度只认本地配置。
            provider = providers.get(provider_name)
            if not provider:
                logger.warning(f"Provider {provider_name} not found in config")
                continue

            api_key_raw = provider.get("keys", {}).get(key_label)
            if not api_key_raw:
                logger.warning(f"Key {key_label} not found for provider {provider_name}")
                continue

            is_oauth_key = isinstance(api_key_raw, dict) and api_key_raw.get("kind") == "oauth"
            if is_oauth_key:
                try:
                    api_key = await oauth_credentials.resolve_auth(provider_name, key_label, provider, api_key_raw)
                except oauth_credentials.OAuthReloginRequired as exc:
                    err_msg = f"{cand_id} OAuth 需要重新登录: {exc}"
                    logger.warning(err_msg)
                    errors.append(err_msg)
                    _trail_add(provider_name, key_label, "oauth_relogin")
                    continue
                except oauth_credentials.OAuthError as exc:
                    err_msg = f"{cand_id} OAuth 凭证解析失败: {exc}"
                    logger.warning(err_msg)
                    errors.append(err_msg)
                    _trail_add(provider_name, key_label, "oauth_error")
                    continue
                base_url = (api_key_raw.get("base_url") if isinstance(api_key_raw, dict) else None) or provider.get("base_url", "")
            elif isinstance(api_key_raw, dict):
                api_key = str(api_key_raw.get("key", ""))
                base_url = api_key_raw.get("base_url") or provider.get("base_url", "")
            else:
                api_key = str(api_key_raw)
                base_url = provider.get("base_url", "")

            # 2c. Per-key RPM limit (strictly governed by provider.rpm_per_key): skip a key
            # whose minute budget is used up instead of collecting an upstream 429.
            rpm_limit = _provider_rpm(provider)
            rpm_key_id = f"{provider_name}:{key_label}"
            if rpm_limit:
                _rw = _rpm_wait(rpm_key_id, rpm_limit)
                if _rw > 0:
                    _rpm_blocked[cand_id] = time.time() + _rw
                    _trail_add(provider_name, key_label, "rpm")
                    logger.debug("Skipping candidate %s - rpm_per_key=%d reached, slot frees in %.1fs",
                                 cand_id, rpm_limit, _rw)
                    continue

            # Same-key retries are bounded by agent_same_key_retries and the
            # deadline; they do not consume max_retries / per-provider attempts.
            if not _is_same_key_retry:
                attempt_seq += 1
                provider_attempts[provider_name] = provider_attempts.get(provider_name, 0) + 1

            # Provider adapter rules (quota_keywords / error_rules), read by the
            # failure classifier below.  Its definition was dropped together with
            # the preset timeout_rules in 602a9db, so every upstream error body
            # raised NameError and skipped cooldown/quota evaluation.
            cand_p_rules = cand.get("adapter_rules") or (provider.get("adapter_rules") or {})

            # 3. Dynamic candidate timeout calculation bounded strictly by remaining monotonic budget
            explicit_cand_timeout = cand.get("timeout_sec")
            if explicit_cand_timeout is not None:
                try:
                    cand_timeout_sec = max(1.0, float(explicit_cand_timeout))
                except (ValueError, TypeError):
                    cand_timeout_sec = agent_first_byte_timeout_sec if category == "agent" else upstream_timeout_sec
            elif category == "agent":
                cand_timeout_sec = agent_first_byte_timeout_sec
            else:
                cand_timeout_sec = upstream_timeout_sec

            # Hard deadline constraint: candidate timeout never exceeds remaining budget
            cand_timeout_full = max(1.0, cand_timeout_sec)
            cand_timeout_sec = max(1.0, min(cand_timeout_sec, remaining_budget))
            cand_req_timeout = _req_timeout(cand_timeout_sec)

            # 4. Concurrency Semaphore acquisition per key with bounded wait
            sem_id = f"{provider_name}:{key_label}"
            sem = await get_key_semaphore(sem_id, concurrency_limit)

            logger.debug(f"Attempt {attempt_seq}: Routing {model_type} to {cand_id} (timeout={cand_timeout_sec:.0f}s)")

            cand_start = time.time()

            def _record_early_failure(code: int, msg: str) -> None:
                """Record a failure that aborts before the normal stats.record() site.

                Manual/sticky and 400/413 early-abort paths raise AllCandidatesFailedError
                before the regular failure accounting. Without this, the dashboard summary
                counts a failure but error_logs stays empty (2026-10-25 incident).
                """
                try:
                    stats.record(
                        model_type, int(code), max(0.0, time.time() - cand_start),
                        provider=provider_name, key=key_label, error_msg=msg,
                        category=category, request_model=req_model_name,
                        is_fallback=(attempt_seq > 1), cand_model=cand.get("model"),
                    )
                except Exception:
                    logger.debug("early failure stats.record failed", exc_info=True)

            now_mono = time.monotonic()
            if now_mono >= deadline:
                errors.append(f"budget_exhausted_before_acquire")
                break
            # Wait the full 10 s for a slot only when no later candidate has a
            # free one right now; otherwise give up after 1 s and move on.
            _later = ordered_items[[i for i, it in enumerate(ordered_items) if it[0] == orig_idx][0] + 1:]
            _later_free = any(
                not (_semaphores.get(f"{c.get('provider', '')}:{c.get('key', '')}") or asyncio.Semaphore(1)).locked()
                and time.time() >= _cooldown_until.get(get_candidate_id(c), 0.0)
                for _, c in _later
            )
            acquire_timeout = min(deadline - now_mono, 1.0 if _later_free else 10.0)
            if acquire_timeout <= 0:
                errors.append(f"budget_exhausted_before_acquire")
                break

            try:
                await asyncio.wait_for(sem.acquire(), timeout=acquire_timeout)
            except asyncio.TimeoutError:
                err_msg = f"{cand_id} key concurrency semaphore wait timed out after {acquire_timeout:.1f}s"
                logger.warning(err_msg)
                errors.append(err_msg)
                _trail_add(provider_name, key_label, "busy")
                continue

            global_sem = None
            if category != "agent":
                global_sem = _get_global_semaphore(kb_global_limit)
                try:
                    await asyncio.wait_for(global_sem.acquire(), timeout=_GLOBAL_QUEUE_TIMEOUT_SEC)
                except asyncio.TimeoutError:
                    sem.release()
                    try:
                        stats.record_gateway_error(model_type, 503,
                            f"KB global queue semaphore timed out after {_GLOBAL_QUEUE_TIMEOUT_SEC:.0f}s", category)
                    except Exception:
                        logger.debug("global queue stats.record_gateway_error failed", exc_info=True)
                    raise GlobalOverloadError(retry_after=_GLOBAL_QUEUE_TIMEOUT_SEC)

            lease = ConcurrencyLease(key_sem=sem, global_sem=global_sem)
            lease_transferred = False
            resp = None

            try:
                # Budget re-check AFTER queueing: time spent waiting on semaphores counts
                if time.monotonic() >= deadline:
                    errors.append(f"budget_exhausted_after_{time.monotonic() - start_monotonic:.2f}s (queue wait)")
                    break
                # Count this dispatch against the key's RPM window.  Re-checked
                # here (after the awaits above) and recorded in the same
                # synchronous step, so concurrent requests cannot overshoot.
                if rpm_limit and not _rpm_try_acquire(rpm_key_id, rpm_limit):
                    _rpm_blocked[cand_id] = time.time() + _rpm_wait(rpm_key_id, rpm_limit)
                    _trail_add(provider_name, key_label, "rpm")
                    if not _is_same_key_retry:
                        attempt_seq -= 1
                        provider_attempts[provider_name] = max(0, provider_attempts.get(provider_name, 1) - 1)
                    continue
                try:
                    _attempted_upstream = True
                    # Build request arguments (method, url, headers, json_body / raw_bytes)
                    method, url, headers, req_body = build_request(cand, api_key, base_url)

                    if isinstance(req_body, (bytes, bytearray)):
                        req_content = bytes(req_body)
                        req_json = None
                    elif hasattr(req_body, "__aiter__"):
                        # Replayable streamed body (e.g. OCR's ReplayableBody):
                        # sent as-is; build_request supplies Content-Length.
                        req_content = req_body
                        req_json = None
                    else:
                        req_content = None
                        req_json = req_body

                    first_byte_deadline = time.monotonic() + cand_timeout_sec
                    if is_stream:
                        def _do_stream_send():
                            if req_content is not None:
                                req = client.build_request(method, url, headers=headers, content=req_content)
                            else:
                                req = client.build_request(method, url, headers=headers, json=req_json)
                            # The read timeout applies to EVERY chunk for the whole
                            # life of the stream, so it is the idle timeout; the
                            # first byte is bounded separately below.
                            req.extensions["timeout"] = {
                                "connect": min(5.0, cand_timeout_sec),
                                "read": max(stream_idle_timeout_sec, cand_timeout_sec),
                                "write": cand_timeout_sec,
                                "pool": 5.0,
                            }
                            return client.send(req, stream=True)
                        try:
                            resp = await asyncio.wait_for(
                                _send_with_stale_retry(_do_stream_send, cand_id),
                                timeout=cand_timeout_sec,
                            )
                        except asyncio.TimeoutError:
                            raise httpx.ReadTimeout(f"no response headers within {cand_timeout_sec:.0f}s")
                    else:
                        if req_content is not None:
                            _do_send = lambda: client.request(method, url, headers=headers, content=req_content, timeout=cand_req_timeout)
                        else:
                            _do_send = lambda: client.request(method, url, headers=headers, json=req_json, timeout=cand_req_timeout)
                        resp = await _send_with_stale_retry(_do_send, cand_id)

                    status_code = resp.status_code
                    inband_body: Optional[str] = None
                    first_chunk = b""
                    remainder = None
                    cand_model_name = cand.get("model")

                    if 200 <= status_code < 300 and is_stream:
                        # Buffer until the first real payload (see _peek_until_payload):
                        # in-band error frames and empty completions fail over before
                        # anything is sent to the client.
                        first_chunk, remainder, verdict, info = await _peek_until_payload(
                            resp, max(time.monotonic() + 0.5, first_byte_deadline))
                        if verdict == "none" and info == "timeout":
                            await resp.aclose()
                            raise httpx.ReadTimeout(f"no first byte within {cand_timeout_sec:.0f}s")
                        if verdict == "error":
                            await resp.aclose()
                            status_code = _inband_status(info)
                            inband_body = json.dumps(info, ensure_ascii=False)
                            logger.warning(f"{cand_id} sent an in-band error frame with HTTP 200 -> treating as HTTP {status_code}")
                        elif verdict == "none" or (verdict == "empty" and _has_alternatives):
                            await resp.aclose()
                            if verdict == "none":
                                reason = info or "stream closed without sending any data"
                                trail_cls = "nodata"
                            else:
                                reason = info or "stream ended without any content (empty completion)"
                                trail_cls = "empty"
                            err_msg = f"{cand_id} returned HTTP 200 but {reason}"
                            logger.warning(err_msg)
                            errors.append(err_msg)
                            _trail_add(provider_name, key_label, trail_cls)
                            cand_latency = time.time() - cand_start
                            stats.record(model_type, 502, cand_latency,
                                         provider=provider_name, key=key_label, error_msg=err_msg,
                                         category=category, request_model=req_model_name, is_fallback=(attempt_seq > 1),
                                         cand_model=cand_model_name)
                            # Short cooldown — likely a transient provider glitch
                            _cooldown_until[cand_id] = time.time() + 5.0
                            continue
                    elif 200 <= status_code < 300:
                        _inb = _nonstream_inband_error(resp.content)
                        if _inb is not None:
                            status_code = _inband_status(_inb)
                            inband_body = resp.content.decode("utf-8", errors="replace")
                            await resp.aclose()
                            logger.warning(f"{cand_id} returned an error object with HTTP 2xx -> treating as HTTP {status_code}")

                    # Success path (2xx)
                    if 200 <= status_code < 300:

                        _consecutive_failures[cand_id] = 0
                        _last_failure_at.pop(cand_id, None)
                        _stall_strikes.pop(cand_id, None)
                        _cooldown_until[cand_id] = 0.0
                        _key_cooldown_until.pop(f"{provider_name}:{key_label}", None)
                        _quota_exhausted_cands.discard(cand_id)

                        routed_via = f"{provider_name}/{key_label}"
                        cand_latency = time.time() - cand_start
                        if _metrics_tr is not None:
                            _metrics_tr.note_success(attempt_seq - 1)

                        # Record latency for smart candidate ordering
                        _record_latency(cand_id, cand_latency)

                        stats.record(model_type, status_code, cand_latency,
                                     provider=provider_name, key=key_label,
                                     category=category, request_model=req_model_name, is_fallback=(attempt_seq > 1),
                                     cand_model=cand_model_name, is_quota=False)

                        if is_stream and remainder is not None:
                            def _on_stream_error(exc, sent, _cid=cand_id, _prov=provider_name, _key=key_label,
                                                 _cm=cand_model_name, _t0=cand_start):
                                lat = time.time() - _t0
                                msg = f"{_cid} stream interrupted after {sent} bytes: {type(exc).__name__}: {exc}"
                                logger.warning(msg)
                                _record_latency(_cid, max(lat, 5.0))
                                stats.record(model_type, 502, lat, provider=_prov, key=_key, error_msg=msg,
                                             category=category, request_model=req_model_name, cand_model=_cm)
                            remainder = _guard_stream(remainder, len(first_chunk), _on_stream_error)

                        # Update sticky active key for Agent mode (use composite provider:key to avoid collisions)
                        if category == "agent":
                            active_composite_key = f"{provider_name}:{key_label}"
                            _sticky_agent_active_keys[req_model_name] = active_composite_key
                            stats.set_agent_active_key(req_model_name, active_composite_key)

                        if is_stream:
                            if handle_stream:
                                try:
                                    try:
                                        stream_result = await handle_stream(resp, first_chunk, remainder, lease=lease)
                                    except TypeError:
                                        stream_result = await handle_stream(resp, first_chunk, remainder)
                                    lease_transferred = True
                                except Exception:
                                    # handle_stream raised — make sure the
                                    # upstream response is not leaked.
                                    await resp.aclose()
                                    raise
                                return ScheduleResult(
                                    stream_resp=stream_result,
                                    routed_via=routed_via,
                                    fallback_attempts=attempt_seq - 1,
                                    lease=lease,
                                    trail="; ".join(trail),
                                )
                            # No handle_stream provided: hand back an async
                            # generator that replays the prefetched chunk and
                            # continues the live stream (internal callers always
                            # pass handle_stream for streams).
                            lease_transferred = True
                            async def _fallback_gen(first=first_chunk, rem=remainder, r=resp, l=lease):
                                try:
                                    if first:
                                        yield first
                                    if rem is not None:
                                        async for chunk in rem:
                                            yield chunk
                                finally:
                                    try:
                                        await r.aclose()
                                    finally:
                                        release_httpx_response(r)
                                        l.release()
                            return ScheduleResult(
                                stream_resp=_fallback_gen(),
                                routed_via=routed_via,
                                fallback_attempts=attempt_seq - 1,
                                lease=lease,
                                trail="; ".join(trail),
                            )
                        else:
                            raw_content = resp.content
                            # Always close the upstream response to return the
                            # connection to the pool immediately. For OCR / KB
                            # (large responses) also reclaim heap pages.
                            await resp.aclose()
                            if model_type == "ocr" or category == "kb":
                                await _reclaim_memory()
                            return ScheduleResult(
                                raw_content=raw_content,
                                routed_via=routed_via,
                                fallback_attempts=attempt_seq - 1,
                                lease=lease,
                                trail="; ".join(trail),
                            )

                    # Failure path (Non-2xx, or 2xx carrying an in-band error)
                    if is_stream and inband_body is None:
                        try:
                            await asyncio.wait_for(resp.aread(), timeout=max(1.0, cand_timeout_sec))
                        except asyncio.TimeoutError:
                            await resp.aclose()
                            raise httpx.ReadTimeout(f"error body not received within {cand_timeout_sec:.0f}s")

                    raw_bytes = inband_body.encode("utf-8") if inband_body is not None else resp.content
                    _trail_add(provider_name, key_label, f"inband{status_code}" if inband_body is not None else str(status_code))
                    try:
                        err_body_text = raw_bytes.decode("utf-8", errors="replace")
                    except Exception:
                        err_body_text = ""

                    last_status_code = status_code
                    last_err_body = err_body_text

                    # Close response immediately to return socket to pool
                    await resp.aclose()

                    # OAuth 401：先强制刷新一次并重试同一 Key；不得按普通 401 直接 24h 冷宫。
                    if status_code == 401 and is_oauth_key:
                        from .oauth_credentials import OAuthReloginRequired, OAuthError as _OAuthError
                        if cand_id not in _oauth_refreshed:
                            _oauth_refreshed.add(cand_id)
                            try:
                                await oauth_credentials.refresh_auth(provider_name, key_label, force=True)
                                _queue.insert(_qi, (orig_idx, cand))
                                _same_key_retry_ids.add(cand_id)
                                _same_key_backoff_override[cand_id] = 0.5
                                continue
                            except OAuthReloginRequired as exc:
                                await oauth_credentials.mark_needs_relogin(provider_name, key_label, str(exc))
                                err_msg = f"{cand_id} OAuth 刷新失效: {exc}"
                                logger.warning(err_msg)
                                errors.append(err_msg)
                                _trail_add(provider_name, key_label, "oauth_relogin")
                                continue
                            except _OAuthError as exc:
                                err_msg = f"{cand_id} OAuth 刷新暂时失败: {exc}"
                                logger.warning(err_msg)
                                errors.append(err_msg)
                                _trail_add(provider_name, key_label, "oauth_refresh")
                                continue
                        else:
                            await oauth_credentials.mark_needs_relogin(provider_name, key_label, "refresh 后仍 401")
                            err_msg = f"{cand_id} OAuth 刷新后仍 401，标记需重新登录"
                            logger.warning(err_msg)
                            errors.append(err_msg)
                            _trail_add(provider_name, key_label, "oauth_relogin")
                            continue

                    body_lower = (err_body_text or "").lower()
                    _has_rate_limit_kw = bool(body_lower and any(w in body_lower for w in RATE_LIMIT_KEYWORDS))
                    _QUOTA_BALANCE_PHRASES = (
                        "insufficient balance", "balance is insufficient", "balance not enough",
                        "balance is 0", "balance=0", "no balance", "credit balance is too low",
                        "credit insufficient balance", "credit is 0", "credit depleted",
                        "余额不足", "账户欠费", "配额不足", "额度不足", "免费额度用尽"
                    )
                    _has_hard_quota_kw = bool(body_lower and (
                        any(w in body_lower for w in HARD_QUOTA_KEYWORDS)
                        or any(w in body_lower for w in cand_p_rules.get("quota_keywords", []))
                        or any(p in body_lower for p in _QUOTA_BALANCE_PHRASES)
                    ))

                    # Provider declarative error rules from adapter_rules
                    for er in cand_p_rules.get("error_rules", []):
                        er_status = er.get("match_status")
                        er_kws = er.get("match_keywords", [])
                        if (er_status is None or er_status == status_code) and any(k.lower() in body_lower for k in er_kws):
                            if er.get("action") == "quota_exhausted" or er.get("category") == "quota_exhausted":
                                _has_hard_quota_kw = True

                    # Hard quota/arrears requires explicit quota keywords and NO rate-limit indicators.
                    # Upstreams like B.AI/OneAPI return HTTP 400 with "credit insufficient balance"
                    _is_quota = bool(
                        (status_code in (400, 401, 402, 403, 429) and _has_hard_quota_kw
                         or status_code == 402)  # 402 Payment Required 本身就是欠费
                        and not _has_rate_limit_kw
                    )

                    # Distinguish 400 Bad Request:
                    _400_is_key_issue = False
                    if status_code == 400 and err_body_text:
                        _KEY_ISSUE_400_PHRASES = (
                            "invalid api key", "invalid_api_key", "invalid api_key", "invalid key",
                            "invalid token", "no active subscription", "account is suspended",
                            "account deactivated", "account suspended", "billing arrears",
                            "payment required", "credit depleted", "arrears", "unauthorized client",
                            "api key is disabled", "api key revoked",
                        )
                        if _is_quota or any(kw in body_lower for kw in _KEY_ISSUE_400_PHRASES):
                            _400_is_key_issue = True

                    _MODEL_LEVEL_403_PHRASES = (
                        "permission to access model", "access to model", "not available in your region",
                        "model not available", "unsupported country", "region is not supported",
                        "country not supported", "access denied for model", "model access restricted",
                        "not entitled to use model",
                    )
                    _403_is_model_level = (status_code == 403 and any(p in body_lower for p in _MODEL_LEVEL_403_PHRASES))

                    # 1. Non-retriable errors: abort immediately without failover
                    # 400 (Client parameter error): if single provider, abort; if multi-provider configured,
                    # skip this provider to allow alternatives to try, only abort if no other providers remain.
                    if status_code == 400 and not _400_is_key_issue:
                        down_providers.add(provider_name)
                        other_provider_remains = any(
                            c.get("provider", "") != provider_name
                            for _, c in ordered_items[attempt_seq:]
                        )
                        clean_400_msg = clean_upstream_error_text(err_body_text, status_code=status_code)
                        if not other_provider_remains:
                            logger.warning(
                                f"Aborting failover for non-retriable client error HTTP {status_code} from {cand_id}: {clean_400_msg[:120]}"
                            )
                            _early_msg = f"Candidate {cand_id} returned non-retriable HTTP {status_code}: {clean_400_msg[:200]}"
                            _record_early_failure(status_code, _early_msg)
                            raise AllCandidatesFailedError(
                                _early_msg,
                                last_status_code=status_code,
                                last_response_body=err_body_text,
                            )
                        logger.warning(
                            f"Fast failover for HTTP 400 from {cand_id}: provider {provider_name} rejected parameters ({clean_400_msg[:100]}), skipping remaining keys for this provider to try alternatives"
                        )

                    # 413 Request Entity Too Large: payload exceeded upstream provider limits.
                    # Retrying other keys of the same provider is futile.
                    if status_code == 413:
                        down_providers.add(provider_name)
                        other_provider_remains = any(
                            c.get("provider", "") != provider_name
                            for _, c in ordered_items[attempt_seq:]
                        )
                        clean_413_msg = clean_upstream_error_text(err_body_text, status_code=413)
                        if not other_provider_remains:
                            logger.warning(
                                f"Aborting failover for HTTP 413 (Payload Too Large) from {cand_id}: {clean_413_msg[:120]}"
                            )
                            _early_msg = f"Candidate {cand_id} returned HTTP 413: {clean_413_msg}"
                            _record_early_failure(413, _early_msg)
                            raise AllCandidatesFailedError(
                                _early_msg,
                                last_status_code=413,
                                last_response_body=err_body_text,
                            )
                        logger.warning(
                            f"Fast failover for HTTP 413: provider {provider_name} rejected payload, skipping remaining keys for this provider"
                        )

                    # 410 Gone: model retired upstream.  Mark provider:model gone
                    # before anything else (incl. manual strategy) so later
                    # requests, and the remaining keys of this request, skip it.
                    if status_code == 410:
                        _mark_model_gone(provider_name, cand_model_name, cooldown_410_sec)
                        logger.warning(
                            f"Model {cand_model_name} retired by provider {provider_name} (HTTP 410); "
                            f"skipping it on all keys for {cooldown_410_sec:.0f}s"
                        )

                    # 2. Manual routing strategy: no failover, raise immediately
                    if strategy == "manual":
                        clean_manual_msg = clean_upstream_error_text(err_body_text, status_code=status_code)
                        _early_msg = f"Candidate {cand_id} failed with HTTP {status_code}: {clean_manual_msg[:200]}"
                        _record_early_failure(status_code, _early_msg)
                        raise AllCandidatesFailedError(
                            _early_msg,
                            last_status_code=status_code,
                            last_response_body=err_body_text,
                        )

                    cand_latency = time.time() - cand_start
                    clean_err_detail = clean_upstream_error_text(err_body_text, status_code=status_code)
                    err_msg = f"{cand_id} returned HTTP {status_code}: {clean_err_detail[:120]}"
                    logger.warning(f"Candidate {cand_id} failed with HTTP {status_code} ({cand_latency:.2f}s): {clean_err_detail[:80]}")
                    errors.append(err_msg)

                    stats.record(model_type, status_code, cand_latency,
                                 provider=provider_name, key=key_label, error_msg=err_msg,
                                 category=category, request_model=req_model_name, is_fallback=(attempt_seq > 1),
                                 cand_model=cand_model_name, is_quota=_is_quota)

                    # Record failure as elevated latency to guide smart ordering
                    _record_latency(cand_id, max(cand_latency, 5.0))

                    # 3. Dynamic Cooldown & Failure Accounting
                    is_agent = (category == "agent")

                    if status_code >= 500:
                        now = time.time()
                        last_fail = _last_failure_at.get(cand_id, 0.0)
                        _last_failure_at[cand_id] = now
                        if (now - last_fail) >= FAILURE_COLLAPSE_WINDOW_SEC:
                            cf = _consecutive_failures.get(cand_id, 0) + 1
                            _consecutive_failures[cand_id] = cf
                        else:
                            cf = _consecutive_failures.get(cand_id, 1)
                            logger.debug(f"Collapsed burst 5xx failure for {cand_id} within {FAILURE_COLLAPSE_WINDOW_SEC}s window (consecutive failures kept at {cf})")
                    else:
                        cf = 0
                        _consecutive_failures[cand_id] = 0

                    _retry_after = _parse_retry_after(resp.headers.get("retry-after")) if status_code == 429 else None
                    eval_res = evaluate_candidate_failure(
                        status_code=status_code,
                        is_quota=_is_quota,
                        is_key_issue_400=_400_is_key_issue,
                        category=category,
                        consecutive_5xx_count=cf,
                        # Only park a 404'd candidate when there is an alternative;
                        # parking the sole candidate would turn one 404 into a
                        # 10-minute "all candidates cooling down" outage.
                        config_params={**cooldown_cfg,
                                       "cooldown_404_sec": cooldown_404_sec if len(ordered_items) > 1 else 0.0,
                                       "retry_after_sec": _retry_after,
                                       "is_model_level_403": _403_is_model_level,
                                       "has_alternatives": len(ordered_items) > 1},
                    )

                    # Agent sticky: a transient 429 (no quota keywords, short or no
                    # Retry-After) is retried on the SAME key before switching, so a
                    # long task keeps its upstream prompt cache instead of moving to
                    # another key on the first rate-limit blip.
                    _soft_429_retry = False
                    if (is_agent and strategy == "sticky_failover" and status_code == 429
                            and not eval_res.is_quota and not rpm_limit
                            and (_retry_after is None or _retry_after <= _AGENT_SOFT_429_MAX_WAIT_SEC)):
                        _soft_429_retry = _maybe_retry_same_key(orig_idx, cand, cand_id, min_backoff=_retry_after or 0.0)

                    if _soft_429_retry:
                        pass  # keep the key un-cooled and the sticky pointer where it is
                    elif eval_res.cooldown_sec > 0:
                        _cooldown_until[cand_id] = time.time() + eval_res.cooldown_sec
                        # Three-tier cooldown: Key-level failure (401, non-model-specific 403, hard quota, key-issue 400)
                        # parks the entire key (all models bound to provider:key)
                        if (status_code in (401, 403) and not _403_is_model_level) or eval_res.is_quota or _400_is_key_issue:
                            _key_cooldown_until[f"{provider_name}:{key_label}"] = time.time() + eval_res.cooldown_sec
                        if eval_res.cooldown_sec >= LONG_BAN_SEC:
                            if eval_res.is_quota:
                                _quota_exhausted_cands.add(cand_id)
                            _save_bans()
                    else:
                        _cooldown_until.pop(cand_id, None)

                    # Agent sticky mode: on 429 or auth/quota failure, proactively advance sticky pointer to next candidate
                    if (not _soft_429_retry and is_agent and strategy == "sticky_failover"
                            and (status_code in (429, 401, 403) or eval_res.is_quota or _400_is_key_issue)):
                        curr_active = _sticky_agent_active_keys.get(req_model_name)
                        if curr_active in (key_label, f"{provider_name}:{key_label}"):
                            for _, next_c in ordered_items[attempt_seq:]:
                                next_kid = f"{next_c.get('provider')}:{next_c.get('key')}"
                                next_cid = get_candidate_id(next_c)
                                if _key_cooldown_until.get(next_kid, 0.0) <= time.time() and _cooldown_until.get(next_cid, 0.0) <= time.time():
                                    _sticky_agent_active_keys[req_model_name] = next_kid
                                    stats.set_agent_active_key(req_model_name, next_kid)
                                    break

                    # Key with rpm_per_key still got a 429: block the key (all its
                    # models) until our window frees, instead of the fixed
                    # 429 cooldown that expires mid-window and hits again.
                    # An explicit Retry-After or a hard quota keeps its cooldown.
                    if (rpm_limit and status_code == 429 and not eval_res.is_quota
                            and not _retry_after):
                        _rpm_mark_exhausted(rpm_key_id, rpm_limit)
                        _cooldown_until.pop(cand_id, None)

                    if eval_res.is_quota:
                        _quota_exhausted_cands.add(cand_id)
                        logger.warning(f"[VM:CircuitBreaker] {status_code} Quota limit on {cand_id} (欠费/超额) — cool down {eval_res.cooldown_sec:.0f}s")
                    else:
                        _quota_exhausted_cands.discard(cand_id)

                    if eval_res.circuit_breaker_triggered:
                        logger.warning(f"[VM:CircuitBreaker] Circuit breaker triggered for {cand_id} ({cf} consecutive 5xx errors). Cool down for {eval_res.cooldown_sec:.0f}s.")

                    if eval_res.mark_provider_down and fast_failover_provider_down and not is_agent and _multi_provider:
                        down_providers.add(provider_name)
                        logger.warning(f"Fast failover: provider {provider_name} returned {status_code}, skipping remaining keys for this request")
                    elif (is_agent and fast_failover_provider_down and _multi_provider
                          and status_code in (502, 503, 504)):
                        # Gateway-level outage: other keys of the same provider sit
                        # behind the same gateway, so try another provider first.
                        down_providers.add(provider_name)
                        logger.warning(f"Fast failover (agent): provider {provider_name} returned {status_code}, trying other providers first")

                    if status_code in _PROVIDER_LEVEL_STATUSES:
                        _maybe_retry_same_key(orig_idx, cand, cand_id)

                except httpx.ReadTimeout as e:
                    last_transport_status = 504
                    # 读超时只说明这个 Key/这次请求慢，不代表整个供应商挂了：
                    # 不再跳过同供应商的其余 Key（KB 单供应商 20 个 Key 时一次超时就整单失败）。
                    if strategy == "manual":
                        _early_msg = f"{cand_id} encountered ReadTimeout after {cand_timeout_sec:.0f}s"
                        _record_early_failure(599, _early_msg)
                        raise AllCandidatesFailedError(
                            _early_msg,
                            last_status_code=504,
                            last_response_body=None,
                        )
                    _trail_add(provider_name, key_label, "timeout")
                    if category != "agent":
                        _cooldown_until[cand_id] = time.time() + cooldown_read_timeout
                    elif _has_alternatives and cand_timeout_sec >= 0.75 * cand_timeout_full:
                        # Burned (nearly) its whole own window without answering:
                        # bench it briefly so the next requests don't pay the
                        # same timeout again.  Cleared on the next success.
                        _bench = _stall_bench_seconds(cand_id)
                        _cooldown_until[cand_id] = time.time() + _bench
                        logger.warning(f"{cand_id} stalled for {cand_timeout_sec:.0f}s — benching {_bench:.0f}s")
                    else:
                        _cooldown_until.pop(cand_id, None)
                    _record_latency(cand_id, cand_timeout_sec)
                    err_msg = (f"{cand_id} encountered ReadTimeout after {cand_timeout_sec:.0f}s "
                               f"(model may be slow, not penalised)")
                    logger.warning(err_msg)
                    errors.append(err_msg)

                    cand_latency = time.time() - cand_start
                    stats.record(model_type, 599, cand_latency,
                                 provider=provider_name, key=key_label, error_msg=err_msg,
                                 category=category, request_model=req_model_name, is_fallback=(attempt_seq > 1),
                                 cand_model=cand.get("model"))

                except httpx.PoolTimeout:
                    # Local outbound pool saturated: do NOT cool down / count a
                    # failure against this key (it never reached the upstream),
                    # and trying other keys would only queue on the same pool.
                    _pool_msg = (f"{cand_id}: local upstream connection pool exhausted "
                                 f"({_POOL_MAX_CONNECTIONS} conns, waited {_POOL_WAIT_SEC:.0f}s)")
                    logger.warning(_pool_msg)
                    try:
                        stats.record_gateway_error(model_type, 503, _pool_msg, category)
                    except Exception:
                        logger.debug("pool timeout stats.record_gateway_error failed", exc_info=True)
                    raise GlobalOverloadError(
                        retry_after=5.0,
                        message=(f"The proxy's upstream connection pool is full ({_POOL_MAX_CONNECTIONS} "
                                 f"connections). Retry shortly, or raise UPSTREAM_MAX_CONNECTIONS."),
                    )

                except httpx.ConnectTimeout as e:
                    last_transport_status = 502
                    if fast_failover_provider_down and category != "agent" and _multi_provider:
                        down_providers.add(provider_name)
                    if strategy == "manual":
                        _early_msg = f"{cand_id} encountered ConnectTimeout: {str(e)}"
                        _record_early_failure(598, _early_msg)
                        raise AllCandidatesFailedError(
                            _early_msg,
                            last_status_code=502,
                            last_response_body=None,
                        )
                    _trail_add(provider_name, key_label, "connect")
                    if category != "agent":
                        _cooldown_until[cand_id] = time.time() + 5.0
                    else:
                        if _has_alternatives:
                            _cooldown_until[cand_id] = time.time() + _stall_bench_seconds(cand_id)
                        else:
                            _cooldown_until.pop(cand_id, None)
                        if fast_failover_provider_down and _multi_provider:
                            down_providers.add(provider_name)
                    _record_latency(cand_id, 10.0)
                    err_msg = f"{cand_id} encountered ConnectTimeout: {str(e)}"
                    logger.error(err_msg)
                    errors.append(err_msg)

                    cand_latency = time.time() - cand_start
                    stats.record(model_type, 598, cand_latency,
                                 provider=provider_name, key=key_label, error_msg=err_msg,
                                 category=category, request_model=req_model_name, is_fallback=(attempt_seq > 1),
                                 cand_model=cand.get("model"))
                    _maybe_retry_same_key(orig_idx, cand, cand_id)

                except AllCandidatesFailedError:
                    raise

                except Exception as e:
                    _transport_status = _transport_error_status(e)
                    if _transport_status is not None:
                        last_transport_status = _transport_status
                    if strategy == "manual":
                        # Network-level failures are gateway errors (502/504) so
                        # clients retry them; 500 is kept for genuine proxy bugs.
                        _early_code = _transport_status or 500
                        _early_msg = f"{cand_id} encountered {type(e).__name__}: {str(e)}"
                        _record_early_failure(_early_code, _early_msg)
                        _err = AllCandidatesFailedError(
                            _early_msg,
                            last_status_code=_early_code,
                            last_response_body=None,
                        )
                        _err.internal = _transport_status is None
                        raise _err
                    now = time.time()
                    last_fail = _last_failure_at.get(cand_id, 0.0)
                    _last_failure_at[cand_id] = now
                    if (now - last_fail) >= FAILURE_COLLAPSE_WINDOW_SEC:
                        cf = _consecutive_failures.get(cand_id, 0) + 1
                        _consecutive_failures[cand_id] = cf
                    else:
                        cf = _consecutive_failures.get(cand_id, 1)
                        logger.debug(f"Collapsed burst exception for {cand_id} within {FAILURE_COLLAPSE_WINDOW_SEC}s window (consecutive failures kept at {cf})")

                    eval_res = evaluate_candidate_failure(
                        status_code=500,
                        is_quota=False,
                        is_key_issue_400=False,
                        category=category,
                        consecutive_5xx_count=cf,
                        config_params=cooldown_cfg,
                    )
                    _is_connect_err = isinstance(e, httpx.ConnectError)
                    _trail_add(provider_name, key_label, "connect" if _is_connect_err else type(e).__name__[:24])
                    if eval_res.cooldown_sec > 0:
                        _cooldown_until[cand_id] = time.time() + eval_res.cooldown_sec
                    elif category == "agent" and _is_connect_err and _has_alternatives:
                        _cooldown_until[cand_id] = time.time() + _stall_bench_seconds(cand_id)
                    else:
                        _cooldown_until.pop(cand_id, None)
                    if (category == "agent" and _is_connect_err and fast_failover_provider_down
                            and _multi_provider):
                        down_providers.add(provider_name)

                    err_msg = f"{cand_id} encountered {type(e).__name__}: {str(e)}"
                    logger.error(err_msg)
                    errors.append(err_msg)

                    cand_latency = time.time() - cand_start
                    stats.record(model_type, 500, cand_latency,
                                 provider=provider_name, key=key_label, error_msg=err_msg,
                                 category=category, request_model=req_model_name, is_fallback=(attempt_seq > 1),
                                 cand_model=cand.get("model"))
                    if isinstance(e, _PROVIDER_LEVEL_EXC):
                        _maybe_retry_same_key(orig_idx, cand, cand_id)

            finally:
                if not lease_transferred:
                    lease.release()
                    # Response fully read/closed here (non-stream, error, or a
                    # stream we failed over from): drop the httpx cycle so the
                    # upstream request body is freed now, not at the next GC.
                    release_httpx_response(resp)

        # Check if all candidates were cooling down and we can wait within budget
        if not errors and loop_idx == 0:
            now_mono = time.monotonic()
            remaining_mono = deadline - now_mono
            expiries = [max(_cooldown_until.get(get_candidate_id(c), 0.0),
                            _key_cooldown_until.get(f"{c.get('provider')}:{c.get('key')}", 0.0),
                            _rpm_blocked.get(get_candidate_id(c), 0.0)) for _, c in ordered_items]
            if expiries:
                min_expiry = min(expiries)
                wait_time = min_expiry - time.time()
                if 0 < wait_time <= min(5.0, remaining_mono):
                    logger.debug(f"All candidates cooling down, waiting {wait_time:.2f}s within budget for earliest key...")
                    await asyncio.sleep(wait_time + 0.1)
                    continue
        break
    if errors:
        # Truncate error list to avoid oversized responses when many
        # candidates fail (e.g. 15 candidates × 500 chars each = 7.5KB).
        # Keep the first 5 and summarise the rest.
        if len(errors) > 5:
            summary = f" (and {len(errors) - 5} more errors)"
            msg = f"All candidates failed: {'; '.join(errors[:5])}{summary}"
        else:
            msg = f"All candidates failed: {'; '.join(errors)}"
        if last_status_code is None and last_transport_status is not None:
            last_status_code = last_transport_status
    else:
        # All candidates were skipped (e.g. in cooldown) – no actual request
        # was attempted, so there is no upstream status/body to forward.
        if ordered_items and all(_is_model_gone(c.get("provider", ""), c.get("model"))
                                 for _, c in ordered_items):
            # Every candidate's model has been retired upstream: say so with
            # 410 instead of a misleading "retry in a few seconds" 503.
            msg = (f"Model for {model_type} has been retired by every configured upstream "
                   f"(HTTP 410 Gone). Remove or replace it in the model config.")
            last_status_code = 410
        elif _rpm_blocked:
            # Every usable key spent its per-minute budget: answer 429 right
            # away (no queueing) with Retry-After set to the earliest free slot.
            msg = (f"All keys for {model_type} reached their per-minute request limit "
                   f"(rpm_per_key). Please retry after the Retry-After interval.")
            last_status_code = 429
        else:
            msg = (f"No available candidates for {model_type} – all are in cooldown. "
                   f"Please retry after the Retry-After interval.")
            # 全部候选在冷却时统一返回 429，让客户端按 Retry-After 自行重试。
            last_status_code = 429
        # 没有真正发出任何上游请求时也必须留下错误日志，否则概览失败数与日志表不一致。
        if not _attempted_upstream:
            try:
                stats.record_gateway_error(model_type, last_status_code, msg, category)
            except Exception:
                logger.debug("no-attempt stats.record_gateway_error failed", exc_info=True)
        last_err_body = json.dumps({"detail": msg})
    # Soonest cooldown expiry among this request's candidates -> Retry-After.
    _now = time.time()
    _exp = [max(_cooldown_until.get(get_candidate_id(c), 0.0),
                _rpm_blocked.get(get_candidate_id(c), 0.0)) - _now for _, c in ordered_items]
    _exp = [x for x in _exp if x > 0]
    raise AllCandidatesFailedError(
        msg,
        last_status_code=last_status_code,
        last_response_body=last_err_body,
        errors=errors[:5],  # cap list size in the exception object
        trail="; ".join(trail),
        retry_after=(min(_exp) if _exp and last_status_code in (429, 503) else None),
    )
