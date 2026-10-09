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
from typing import Optional, Any, Callable, Dict, Set
from dataclasses import dataclass

from . import stats
from .config_store import get_config_version

logger = logging.getLogger("scheduler")

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
_GLOBAL_MAX_CONCURRENCY = 30
_GLOBAL_QUEUE_TIMEOUT_SEC = 2.0
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


def _reclaim_memory_sync():
    """Synchronous GC + malloc_trim — run in a thread to avoid blocking the event loop."""
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
    """Request a (coalesced, throttled) gc.collect() + malloc_trim(0).
    Returns immediately; the actual work runs in the background."""
    global _reclaim_task
    if _reclaim_task is not None and not _reclaim_task.done():
        return
    _reclaim_task = asyncio.create_task(_reclaim_runner())


class AllCandidatesFailedError(Exception):
    """Raised when all candidate keys have failed.

    Carries the last upstream HTTP status code and response body so that
    the proxy layer can forward the real upstream error to the client
    instead of a generic 503.
    """
    def __init__(self, message, last_status_code=None, last_response_body=None, errors=None):
        super().__init__(message)
        self.last_status_code = last_status_code
        self.last_response_body = last_response_body
        self.errors = errors or []


class GlobalOverloadError(Exception):
    """Raised when the global concurrency cap is saturated and the bounded
    queue wait timed out.  The proxy layer converts this to 503 +
    Retry-After so burst clients back off instead of hanging."""
    def __init__(self, retry_after: float = _GLOBAL_QUEUE_TIMEOUT_SEC):
        super().__init__(
            f"The proxy is at its global concurrency limit "
            f"({_global_semaphore_limit} in-flight upstream requests). "
            f"Retry after {retry_after:.0f}s."
        )
        self.retry_after = retry_after


# Module-level in-memory state (persists across requests on the same instance)
_cooldown_until: Dict[str, float] = {}
_consecutive_failures: Dict[str, int] = {}
_last_failure_at: Dict[str, float] = {}
_quota_exhausted_cands: Set[str] = set()
_semaphores: Dict[str, asyncio.Semaphore] = {}
_semaphore_limits: Dict[str, int] = {}
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

def get_active_cooldowns() -> Dict[str, dict]:
    """Return candidates currently cooling down or quota-exhausted."""
    now = time.time()
    res = {}
    for cand_id, expiry in list(_cooldown_until.items()):
        if expiry > now:
            res[cand_id] = {
                "cooling": True,
                "is_quota": cand_id in _quota_exhausted_cands,
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
    ):
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
    cooldown_quota_sec = config_params.get("cooldown_quota_sec", 1800.0)
    cooldown_tpm_sec = config_params.get("cooldown_tpm_sec", 15.0)
    cooldown_403_sec = config_params.get("cooldown_403_sec", 600.0)
    cooldown_5xx_sec = config_params.get("cooldown_5xx_sec", 30.0)
    circuit_threshold = config_params.get("circuit_break_threshold", 3)
    circuit_cooldown_sec = config_params.get("circuit_cooldown_sec", 300.0)

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

    # 2. Agent Mode: Only hard quota or auth failure causes long cooldown. Transient errors do NOT freeze the key.
    if is_agent:
        if status_code in (401, 403):
            # Auth failure (bad key token)
            return FailureEvaluation(
                cooldown_sec=cooldown_403_sec,
                is_quota=False,
                mark_provider_down=False,
                circuit_breaker_triggered=False,
            )
        # 429 with an explicit Retry-After: honour it (capped at 60 s) when there
        # is another candidate to use meanwhile, so the next requests stop
        # hammering a key the provider just told us to back off from.
        retry_after = config_params.get("retry_after_sec")
        if status_code == 429 and retry_after and config_params.get("has_alternatives", True):
            return FailureEvaluation(
                cooldown_sec=min(float(retry_after), 60.0),
                is_quota=False,
                mark_provider_down=False,
                circuit_breaker_triggered=False,
            )
        # Transient 429 TPM, 5xx, or network timeouts: 0s cooldown (do not lock out from future retries)
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
    elif status_code in (401, 403):
        return FailureEvaluation(
            cooldown_sec=cooldown_403_sec,
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
        cd = max(circuit_cooldown_sec, 1800.0) if is_circuit else cooldown_5xx_sec
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
                limits=httpx.Limits(
                    max_connections=80,
                    # Keep every pooled connection warm: closing idle ones above
                    # 20 forced a fresh TCP+TLS handshake (200-600 ms cross-border)
                    # on the next burst.
                    max_keepalive_connections=80,
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
_STALE_CONN_ERRORS = (httpx.RemoteProtocolError, httpx.ReadError, httpx.WriteError)
_STALE_RETRY_WINDOW_SEC = 2.0


async def _send_with_stale_retry(do_send: Callable[[], Any], cand_id: str):
    t0 = time.monotonic()
    try:
        return await do_send()
    except _STALE_CONN_ERRORS as e:
        if time.monotonic() - t0 > _STALE_RETRY_WINDOW_SEC:
            raise
        logger.info("Stale pooled connection for %s (%s: %s) — retrying once on a fresh connection",
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
    for cands in config.get("candidates", {}).values():
        for cand in cands:
            try:
                valid_cand_ids.add(get_candidate_id(cand))
                valid_key_ids.add(f"{cand['provider']}:{cand['key']}")
            except KeyError:
                continue
    valid_agent_models = set(config.get("agent_models", {}).keys())
    for state in (_cooldown_until, _consecutive_failures, _last_failure_at, _latency_history):
        for k in list(state.keys()):
            if k not in valid_cand_ids:
                del state[k]
    _quota_exhausted_cands.intersection_update(valid_cand_ids)
    for k in list(_semaphores.keys()):
        if k not in valid_key_ids:
            del _semaphores[k]
            _semaphore_limits.pop(k, None)
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
    _cooldown_until.clear()
    _consecutive_failures.clear()
    _last_failure_at.clear()
    _quota_exhausted_cands.clear()
    _latency_history.clear()
    _semaphores.clear()
    _semaphore_limits.clear()
    _sticky_agent_active_keys.clear()
    _rr_kb_indices.clear()


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


_lazy_fetch_failed_until: Dict[str, float] = {}


async def _lazy_fetch_vault_credential(config: dict, provider_name: str, key_label: str) -> Optional[dict]:
    """
    Attempt to lazy-fetch missing provider or key configuration from EdgeOne Vault in real-time.
    Returns provider_config dict if successful, or None.
    """
    cache_key = f"{provider_name}:{key_label}"
    now = time.time()
    if now < _lazy_fetch_failed_until.get(cache_key, 0.0):
        return None

    v_cfg = config.get("edgeone_vault") or {}
    vault_url = (
        v_cfg.get("edgeone_url")
        or v_cfg.get("url")
        or os.environ.get("EDGEONE_VAULT_URL")
        or ""
    ).strip().rstrip("/")
    token = (
        v_cfg.get("token")
        or os.environ.get("EDGEONE_VAULT_TOKEN")
        or os.environ.get("VAULT_ACCESS_TOKEN")
        or ""
    ).strip()

    if not vault_url:
        return None

    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        async with httpx.AsyncClient(timeout=4.0, follow_redirects=True) as client:
            res = await client.post(
                f"{vault_url}/api/vault/fetch",
                headers=headers,
                json={"provider": provider_name, "key_label": key_label}
            )
            if res.is_success:
                data = res.json()
                if data.get("ok"):
                    prov_cfg = data.get("provider_config") or {}
                    logger.info("Successfully lazy-fetched provider %s (key %s) from EdgeOne Vault", provider_name, key_label)
                    return prov_cfg
    except Exception as e:
        logger.warning("Failed to lazy-fetch %s from EdgeOne Vault (%s): %s", cache_key, vault_url, e)

    _lazy_fetch_failed_until[cache_key] = now + 30.0
    return None


async def _async_persist_lazy_provider(provider_name: str, prov_cfg: dict):
    """
    Asynchronously write lazy-fetched provider metadata and keys to local encrypted config.
    """
    try:
        from .config_store import get_config, save_config
        cfg = await get_config()
        p_dict = cfg.setdefault("providers", {})
        target = p_dict.setdefault(provider_name, {})
        target["name"] = prov_cfg.get("name") or provider_name
        proto = prov_cfg.get("protocol") or "openai"
        target["protocol"] = proto
        raw_protos = prov_cfg.get("protocols")
        if not raw_protos or not isinstance(raw_protos, list):
            raw_protos = ["messages"] if proto == "messages" else ["chat"]
        target["protocols"] = raw_protos
        target["anthropic_messages"] = bool(prov_cfg.get("anthropic_messages") or ("messages" in raw_protos))
        if prov_cfg.get("base_url"):
            target["base_url"] = prov_cfg["base_url"]
        if prov_cfg.get("anthropic_base_url"):
            target["anthropic_base_url"] = prov_cfg["anthropic_base_url"]
        if prov_cfg.get("adapter_rules") is not None:
            target["adapter_rules"] = prov_cfg["adapter_rules"]
        if prov_cfg.get("models") or prov_cfg.get("cached_models"):
            target["cached_models"] = prov_cfg.get("models") or prov_cfg.get("cached_models")

        t_keys = target.setdefault("keys", {})
        r_keys = prov_cfg.get("keys") or {}
        for kl, kv in r_keys.items():
            if kl and kv:
                t_keys[kl] = kv

        await save_config(cfg)
        logger.info("Persisted lazy-fetched provider %s and keys to encrypted storage", provider_name)
    except Exception as e:
        logger.warning("Failed to persist lazy-fetched provider %s to disk: %s", provider_name, e)


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
    candidates = config.get("candidates", {}).get(model_type, [])
    if not candidates:
        raise RuntimeError(f"No active candidates configured for model type: {model_type}")

    # Prune stale runtime state (cooldowns, semaphores, ...) when the config
    # changed on disk — near-zero cost thanks to the version check.
    v = get_config_version()
    if v != _last_config_version:
        _prune_runtime_state(config)

    # Determine routing strategy based on category
    if category == "agent":
        strategy = config.get("agent_routing_strategy", "sticky_failover")
    else:
        strategy = config.get("kb_routing_strategy", "round_robin")

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

    # Load settings from config with safe fallback and clamping
    try:
        # Per-request timeout (set by each endpoint in proxy_routes: OCR, KB chat,
        # embedding, rerank, agent chat) takes precedence over the global
        # `upstream_timeout_sec`.  The previous order let the global default
        # (30 s) silently override e.g. the 60 s OCR timeout.
        upstream_timeout_sec = max(1.0, float(config.get("upstream_timeout", config.get("upstream_timeout_sec", 15))))
    except (ValueError, TypeError):
        upstream_timeout_sec = 15.0

    try:
        total_budget_sec = max(1.0, float(config.get("request_total_budget_sec", config.get("schedule_total_budget", 60))))
    except (ValueError, TypeError):
        total_budget_sec = 60.0
    # A request budget shorter than a single attempt's timeout would cut the
    # first (and only) attempt short — always allow at least one full attempt.
    total_budget_sec = max(total_budget_sec, upstream_timeout_sec)

    # Max candidate retries per request
    try:
        max_retries = max(1, int(config.get("max_retries", config.get("schedule_total_budget_count", 5))))
    except (ValueError, TypeError):
        max_retries = 5

    # Max attempts per individual provider
    try:
        max_attempts_per_provider = max(1, int(config.get("max_attempts_per_provider", 6)))
    except (ValueError, TypeError):
        max_attempts_per_provider = 6

    fast_failover_provider_down = bool(config.get("fast_failover_provider_down", True))
    provider_attempts: Dict[str, int] = {}
    down_providers: Set[str] = set()

    if strategy == "manual":
        # Pure manual passthrough: do not truncate deep thinking / reasoning models.
        # Allow up to 300s safe bounded timeout, and let client decide when to disconnect.
        upstream_timeout_sec = max(upstream_timeout_sec, 300.0)
        total_budget_sec = upstream_timeout_sec + 5.0
    else:
        # Failover mode: if total_budget was not explicitly overridden by caller, scale with candidate pool and max_retries
        has_explicit_budget = "schedule_total_budget" in config or "request_total_budget_sec" in config
        if not has_explicit_budget:
            total_budget_sec = max(total_budget_sec, upstream_timeout_sec * min(max_retries, max(1, len(ordered_items))))

    try:
        concurrency_limit = max(1, int(config.get("max_concurrency_per_key", 5)))
    except (ValueError, TypeError):
        concurrency_limit = 5

    try:
        kb_global_limit = max(1, int(config.get("kb_global_max_concurrency", _GLOBAL_MAX_CONCURRENCY)))
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
        cooldown_404_sec = max(0.0, float(config.get("cooldown_404_sec", 600.0)))
    except (ValueError, TypeError):
        cooldown_404_sec = 600.0

    # 429 TPM Rate Limit Cooldown (default 15s)
    try:
        cooldown_tpm_sec = max(1.0, float(config.get("cooldown_429_sec", config.get("cooldown_tpm_sec", 15))))
    except (ValueError, TypeError):
        cooldown_tpm_sec = 15.0

    # 429/403 Quota Exhaustion Cooldown (default 1800s / 30m)
    try:
        cooldown_quota_sec = max(1.0, float(config.get("cooldown_quota_sec", 1800.0)))
    except (ValueError, TypeError):
        cooldown_quota_sec = 1800.0

    # 403 Auth Failure Cooldown (default 600s)
    try:
        cooldown_403_sec = max(1.0, float(config.get("cooldown_403_sec", 600)))
    except (ValueError, TypeError):
        cooldown_403_sec = 600.0

    # 5xx Server Error Cooldown (default 30s)
    try:
        cooldown_5xx_sec = max(1.0, float(config.get("cooldown_5xx_sec", config.get("cooldown_duration", 30))))
    except (ValueError, TypeError):
        cooldown_5xx_sec = 30.0

    cooldown_read_timeout = 2.0

    # Circuit breaker threshold (only for genuine 5xx server failures / crash)
    try:
        circuit_break_threshold = max(1, int(config.get("circuit_break_threshold", 3)))
    except (ValueError, TypeError):
        circuit_break_threshold = 3

    try:
        circuit_cooldown = max(1.0, float(config.get("circuit_cooldown_sec", 300)))
    except (ValueError, TypeError):
        circuit_cooldown = 300.0

    cooldown_cfg = {
        "cooldown_quota_sec": cooldown_quota_sec,
        "cooldown_tpm_sec": cooldown_tpm_sec,
        "cooldown_403_sec": cooldown_403_sec,
        "cooldown_5xx_sec": cooldown_5xx_sec,
        "circuit_break_threshold": circuit_break_threshold,
        "circuit_cooldown_sec": circuit_cooldown,
    }

    start_monotonic = time.monotonic()
    deadline = start_monotonic + total_budget_sec
    errors = []
    attempt_seq = 0
    last_status_code = None
    last_err_body = None

    client = await get_client()
    # Per-request timeout: use a separate httpx.Timeout so that OCR (which
    # passes a longer upstream_timeout via config override) gets more time.
    req_timeout = httpx.Timeout(upstream_timeout_sec, connect=min(5.0, upstream_timeout_sec))

    for loop_idx in range(2):
        for orig_idx, cand in ordered_items:
            # Check maximum retry budget
            if attempt_seq >= max_retries:
                logger.info("Reached maximum candidate retry limit (%d attempts)", max_retries)
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

            # Provider down fast failover
            if fast_failover_provider_down and provider_name in down_providers:
                logger.info("Skipping candidate %s — provider %s marked down for this request", cand_id, provider_name)
                continue

            # Per-provider attempt limit
            if provider_attempts.get(provider_name, 0) >= max_attempts_per_provider:
                logger.info("Skipping candidate %s — reached max %d attempts for provider %s", cand_id, max_attempts_per_provider, provider_name)
                continue

            # 2. Cooldown check
            cooldown_expiry = _cooldown_until.get(cand_id, 0.0)
            if time.time() < cooldown_expiry:
                logger.info(f"Skipping candidate {cand_id} - cooling down until {cooldown_expiry}")
                continue

            provider = providers.get(provider_name)
            if not provider:
                fetched_p = await _lazy_fetch_vault_credential(config, provider_name, key_label)
                if fetched_p:
                    providers[provider_name] = {
                        "name": fetched_p.get("name") or provider_name,
                        "base_url": fetched_p.get("base_url", ""),
                        "protocol": fetched_p.get("protocol", "openai"),
                        "protocols": fetched_p.get("protocols", ["chat"]),
                        "anthropic_messages": bool(fetched_p.get("anthropic_messages")),
                        "anthropic_base_url": fetched_p.get("anthropic_base_url"),
                        "adapter_rules": fetched_p.get("adapter_rules") or {},
                        "keys": dict(fetched_p.get("keys") or {})
                    }
                    provider = providers[provider_name]
                    asyncio.create_task(_async_persist_lazy_provider(provider_name, fetched_p))
                else:
                    logger.warning(f"Provider {provider_name} not found in config")
                    continue

            api_key_raw = provider.get("keys", {}).get(key_label)
            if not api_key_raw:
                fetched_p = await _lazy_fetch_vault_credential(config, provider_name, key_label)
                if fetched_p:
                    r_keys = fetched_p.get("keys") or {}
                    if key_label in r_keys and r_keys[key_label]:
                        provider.setdefault("keys", {})[key_label] = r_keys[key_label]
                        api_key_raw = r_keys[key_label]
                        asyncio.create_task(_async_persist_lazy_provider(provider_name, fetched_p))

            if not api_key_raw:
                logger.warning(f"Key {key_label} not found for provider {provider_name}")
                continue

            if isinstance(api_key_raw, dict):
                api_key = str(api_key_raw.get("key", ""))
                base_url = api_key_raw.get("base_url") or provider.get("base_url", "")
            else:
                api_key = str(api_key_raw)
                base_url = provider.get("base_url", "")

            attempt_seq += 1
            provider_attempts[provider_name] = provider_attempts.get(provider_name, 0) + 1

            # 3. Dynamic candidate timeout calculation bounded strictly by remaining monotonic budget
            cand_p_rules = cand.get("adapter_rules") or (providers.get(provider_name, {}).get("adapter_rules") or {})
            cand_t_rules = cand_p_rules.get("timeout_rules") or {}
            cand_m_map = cand_t_rules.get("models") or {}
            cand_timeout_cfg = cand.get("timeout_sec") or cand_m_map.get(cand_model_name) or cand_t_rules.get("default_timeout_sec")
            
            if cand_timeout_cfg:
                cand_timeout_sec = float(cand_timeout_cfg)
            else:
                m_check = f"{req_model_name or ''} {cand_model_name or ''}".lower()
                if any(k in m_check for k in ("glm-5", "r1", "thinking", "o1", "o3")):
                    cand_timeout_sec = float(config.get("upstream_timeout_reasoning", 120.0))
                else:
                    cand_timeout_sec = upstream_timeout_sec

            # Hard deadline constraint: candidate timeout never exceeds remaining budget
            cand_timeout_sec = max(1.0, min(cand_timeout_sec, remaining_budget))
            cand_req_timeout = httpx.Timeout(cand_timeout_sec, connect=min(5.0, cand_timeout_sec))

            # 4. Concurrency Semaphore acquisition per key with bounded wait
            sem_id = f"{provider_name}:{key_label}"
            sem = await get_key_semaphore(sem_id, concurrency_limit)

            logger.info(f"Attempt {attempt_seq}: Routing {model_type} to {cand_id} (timeout={cand_timeout_sec:.0f}s)")

            cand_start = time.time()
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
                continue

            global_sem = None
            if category != "agent":
                global_sem = _get_global_semaphore(kb_global_limit)
                try:
                    await asyncio.wait_for(global_sem.acquire(), timeout=_GLOBAL_QUEUE_TIMEOUT_SEC)
                except asyncio.TimeoutError:
                    sem.release()
                    raise GlobalOverloadError(retry_after=_GLOBAL_QUEUE_TIMEOUT_SEC)

            lease = ConcurrencyLease(key_sem=sem, global_sem=global_sem)
            lease_transferred = False

            try:
                # Budget re-check AFTER queueing: time spent waiting on semaphores counts
                if time.monotonic() >= deadline:
                    errors.append(f"budget_exhausted_after_{time.monotonic() - start_monotonic:.2f}s (queue wait)")
                    break
                try:
                    # Build request arguments (method, url, headers, json_body / raw_bytes)
                    method, url, headers, req_body = build_request(cand, api_key, base_url)

                    if isinstance(req_body, (bytes, bytearray)):
                        req_content = bytes(req_body)
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

                    # Success path (2xx)
                    if 200 <= status_code < 300:
                        # For streams, peek the first chunk BEFORE committing to
                        # this candidate.  Some providers return HTTP 200 and then
                        # close the stream without sending a byte (or die with a
                        # protocol error) — treat that as a failure and fail over
                        # instead of handing the client a dead stream.
                        first_chunk = b""
                        remainder = None
                        cand_model_name = cand.get("model")
                        if is_stream:
                            try:
                                first_chunk, remainder, peek_err = await asyncio.wait_for(
                                    _peek_first_chunk(resp),
                                    timeout=max(0.5, first_byte_deadline - time.monotonic()),
                                )
                            except asyncio.TimeoutError:
                                await resp.aclose()
                                raise httpx.ReadTimeout(f"no first byte within {cand_timeout_sec:.0f}s")
                            if not first_chunk:
                                await resp.aclose()
                                reason = peek_err or "stream closed without sending any data"
                                err_msg = f"{cand_id} returned HTTP 200 but {reason}"
                                logger.warning(err_msg)
                                errors.append(err_msg)
                                cand_latency = time.time() - cand_start
                                stats.record(model_type, 502, cand_latency,
                                             provider=provider_name, key=key_label, error_msg=err_msg,
                                             category=category, request_model=req_model_name, is_fallback=(attempt_seq > 1),
                                             cand_model=cand_model_name)
                                # Short cooldown — likely a transient provider glitch
                                _cooldown_until[cand_id] = time.time() + 5.0
                                continue

                        _consecutive_failures[cand_id] = 0
                        _last_failure_at.pop(cand_id, None)
                        _cooldown_until[cand_id] = 0.0
                        _quota_exhausted_cands.discard(cand_id)

                        routed_via = f"{provider_name}/{key_label}"
                        cand_latency = time.time() - cand_start

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

                        # Update sticky active key for Agent mode
                        if category == "agent":
                            _sticky_agent_active_keys[req_model_name] = key_label
                            stats.set_agent_active_key(req_model_name, key_label)

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
                                        l.release()
                            return ScheduleResult(
                                stream_resp=_fallback_gen(),
                                routed_via=routed_via,
                                fallback_attempts=attempt_seq - 1,
                                lease=lease,
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
                            )

                    # Failure path (Non-2xx)
                    if is_stream:
                        try:
                            await asyncio.wait_for(resp.aread(), timeout=max(1.0, cand_timeout_sec))
                        except asyncio.TimeoutError:
                            await resp.aclose()
                            raise httpx.ReadTimeout(f"error body not received within {cand_timeout_sec:.0f}s")

                    raw_bytes = resp.content
                    try:
                        err_body_text = raw_bytes.decode("utf-8", errors="replace")
                    except Exception:
                        err_body_text = ""

                    last_status_code = status_code
                    last_err_body = err_body_text

                    # Close response immediately to return socket to pool
                    await resp.aclose()

                    body_lower = (err_body_text or "").lower()
                    _has_rate_limit_kw = bool(body_lower and any(w in body_lower for w in RATE_LIMIT_KEYWORDS))
                    _has_hard_quota_kw = bool(body_lower and (
                        any(w in body_lower for w in HARD_QUOTA_KEYWORDS)
                        or any(w in body_lower for w in cand_p_rules.get("quota_keywords", []))
                        or ("balance" in body_lower and any(b in body_lower for b in ("insufficient", "0", "zero", "low", "empty", "not enough")))
                        or ("credit" in body_lower and any(b in body_lower for b in ("insufficient", "0", "zero", "low", "empty", "not enough")))
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
                        status_code in (400, 401, 402, 403, 429)
                        and _has_hard_quota_kw
                        and not _has_rate_limit_kw
                    )

                    # Distinguish 400 Bad Request:
                    _400_is_key_issue = False
                    if status_code == 400 and err_body_text:
                        if _is_quota or any(kw in body_lower for kw in [
                            "subscription", "no active", "api key", "invalid_key",
                            "unauthorized", "account", "billing", "payment", "plan",
                            "credit", "balance", "insufficient", "quota", "arrears",
                        ]):
                            _400_is_key_issue = True

                    # 1. Non-retriable errors: abort immediately without failover
                    # 400 (Client parameter error), 404 (Model not found / route invalid), 422 (Validation error)
                    # 404 / 422 are NOT aborted any more: with several providers
                    # behind one model, one provider delisting the model (404) or
                    # rejecting a provider-specific field (422) must not stop the
                    # others from being tried.  If every candidate fails, the last
                    # upstream status (e.g. 404) is still returned to the client.
                    if status_code == 400 and not _400_is_key_issue:
                        logger.warning(
                            f"Aborting failover for non-retriable client error HTTP {status_code} from {cand_id}: {err_body_text[:120]}"
                        )
                        raise AllCandidatesFailedError(
                            f"Candidate {cand_id} returned non-retriable HTTP {status_code}: {err_body_text[:200]}",
                            last_status_code=status_code,
                            last_response_body=err_body_text,
                        )

                    # 2. Manual routing strategy: no failover, raise immediately
                    if strategy == "manual":
                        raise AllCandidatesFailedError(
                            f"Candidate {cand_id} failed with HTTP {status_code}: {err_body_text[:200]}",
                            last_status_code=status_code,
                            last_response_body=err_body_text,
                        )

                    cand_latency = time.time() - cand_start
                    err_msg = f"{cand_id} returned HTTP {status_code}: {err_body_text[:120]}"
                    logger.warning(f"Candidate {cand_id} failed with HTTP {status_code} ({cand_latency:.2f}s): {err_body_text[:80]}")
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
                            logger.info(f"Collapsed burst 5xx failure for {cand_id} within {FAILURE_COLLAPSE_WINDOW_SEC}s window (consecutive failures kept at {cf})")
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
                                       "has_alternatives": len(ordered_items) > 1},
                    )

                    if eval_res.cooldown_sec > 0:
                        _cooldown_until[cand_id] = time.time() + eval_res.cooldown_sec
                    else:
                        _cooldown_until.pop(cand_id, None)

                    if eval_res.is_quota:
                        _quota_exhausted_cands.add(cand_id)
                        logger.warning(f"{status_code} Quota limit on {cand_id} (欠费/超额) — cool down {eval_res.cooldown_sec:.0f}s")
                    else:
                        _quota_exhausted_cands.discard(cand_id)

                    if eval_res.circuit_breaker_triggered:
                        logger.warning(f"Circuit breaker triggered for {cand_id} ({cf} consecutive 5xx errors). Cool down for {eval_res.cooldown_sec:.0f}s.")

                    if eval_res.mark_provider_down and fast_failover_provider_down and not is_agent:
                        down_providers.add(provider_name)
                        logger.warning(f"Fast failover: provider {provider_name} returned {status_code}, skipping remaining keys for this request")

                except httpx.ReadTimeout as e:
                    if fast_failover_provider_down and category != "agent":
                        down_providers.add(provider_name)
                    if strategy == "manual":
                        raise AllCandidatesFailedError(
                            f"{cand_id} encountered ReadTimeout after {cand_timeout_sec:.0f}s",
                            last_status_code=504,
                            last_response_body=None,
                        )
                    if category != "agent":
                        _cooldown_until[cand_id] = time.time() + cooldown_read_timeout
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

                except httpx.ConnectTimeout as e:
                    if fast_failover_provider_down and category != "agent":
                        down_providers.add(provider_name)
                    if strategy == "manual":
                        raise AllCandidatesFailedError(
                            f"{cand_id} encountered ConnectTimeout: {str(e)}",
                            last_status_code=502,
                            last_response_body=None,
                        )
                    if category != "agent":
                        _cooldown_until[cand_id] = time.time() + 5.0
                    else:
                        _cooldown_until.pop(cand_id, None)
                    _record_latency(cand_id, 10.0)
                    err_msg = f"{cand_id} encountered ConnectTimeout: {str(e)}"
                    logger.error(err_msg)
                    errors.append(err_msg)

                    cand_latency = time.time() - cand_start
                    stats.record(model_type, 598, cand_latency,
                                 provider=provider_name, key=key_label, error_msg=err_msg,
                                 category=category, request_model=req_model_name, is_fallback=(attempt_seq > 1),
                                 cand_model=cand.get("model"))

                except AllCandidatesFailedError:
                    raise

                except Exception as e:
                    if strategy == "manual":
                        raise AllCandidatesFailedError(
                            f"{cand_id} encountered {type(e).__name__}: {str(e)}",
                            last_status_code=500,
                            last_response_body=None,
                        )
                    now = time.time()
                    last_fail = _last_failure_at.get(cand_id, 0.0)
                    _last_failure_at[cand_id] = now
                    if (now - last_fail) >= FAILURE_COLLAPSE_WINDOW_SEC:
                        cf = _consecutive_failures.get(cand_id, 0) + 1
                        _consecutive_failures[cand_id] = cf
                    else:
                        cf = _consecutive_failures.get(cand_id, 1)
                        logger.info(f"Collapsed burst exception for {cand_id} within {FAILURE_COLLAPSE_WINDOW_SEC}s window (consecutive failures kept at {cf})")

                    eval_res = evaluate_candidate_failure(
                        status_code=500,
                        is_quota=False,
                        is_key_issue_400=False,
                        category=category,
                        consecutive_5xx_count=cf,
                        config_params=cooldown_cfg,
                    )
                    if eval_res.cooldown_sec > 0:
                        _cooldown_until[cand_id] = time.time() + eval_res.cooldown_sec
                    else:
                        _cooldown_until.pop(cand_id, None)

                    err_msg = f"{cand_id} encountered {type(e).__name__}: {str(e)}"
                    logger.error(err_msg)
                    errors.append(err_msg)

                    cand_latency = time.time() - cand_start
                    stats.record(model_type, 500, cand_latency,
                                 provider=provider_name, key=key_label, error_msg=err_msg,
                                 category=category, request_model=req_model_name, is_fallback=(attempt_seq > 1),
                                 cand_model=cand.get("model"))

            finally:
                if not lease_transferred:
                    lease.release()

        # Check if all candidates were cooling down and we can wait within budget
        if not errors and loop_idx == 0:
            now_mono = time.monotonic()
            remaining_mono = deadline - now_mono
            expiries = [_cooldown_until.get(get_candidate_id(c), 0.0) for _, c in ordered_items]
            if expiries:
                min_expiry = min(expiries)
                wait_time = min_expiry - time.time()
                if 0 < wait_time <= min(5.0, remaining_mono):
                    logger.info(f"All candidates cooling down, waiting {wait_time:.2f}s within budget for earliest key...")
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
    else:
        # All candidates were skipped (e.g. in cooldown) – no actual request
        # was attempted, so there is no upstream status/body to forward.
        msg = (f"No available candidates for {model_type} – all are in cooldown. "
               f"Please retry in a few seconds.")
        last_status_code = 503
        last_err_body = json.dumps({"detail": msg})
    raise AllCandidatesFailedError(
        msg,
        last_status_code=last_status_code,
        last_response_body=last_err_body,
        errors=errors[:5],  # cap list size in the exception object
    )
