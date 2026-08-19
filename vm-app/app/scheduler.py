"""
Stateless Failover Scheduler
Handles key rotation, failover budget, concurrency limiters, cooldown, and circuit breaker.
Ported from EdgeOne cloud-functions version; stats now recorded in-memory.
"""
import time
import logging
import asyncio
import json
import gc
import ctypes
import ctypes.util
import httpx
from typing import Optional, Any, Callable, Dict
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
_GLOBAL_MAX_CONCURRENCY = 30
_GLOBAL_QUEUE_TIMEOUT_SEC = 2.0
_global_semaphore: Optional[asyncio.Semaphore] = None


def _get_global_semaphore() -> asyncio.Semaphore:
    global _global_semaphore
    if _global_semaphore is None:
        _global_semaphore = asyncio.Semaphore(_GLOBAL_MAX_CONCURRENCY)
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


async def _reclaim_memory():
    """Run gc.collect() then malloc_trim(0) to return freed heap to the OS.
    Called after large-payload requests (OCR, large chat responses) rather
    than on a blind counter, so the cost is paid only when it matters.
    Offloaded to a thread to avoid blocking the async event loop."""
    await asyncio.to_thread(_reclaim_memory_sync)


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
            f"({_GLOBAL_MAX_CONCURRENCY} in-flight upstream requests). "
            f"Retry after {retry_after:.0f}s."
        )
        self.retry_after = retry_after


# Module-level in-memory state (persists across requests on the same instance)
_cooldown_until: Dict[str, float] = {}
_consecutive_failures: Dict[str, int] = {}
_semaphores: Dict[str, asyncio.Semaphore] = {}
_semaphore_limits: Dict[str, int] = {}
_sem_lock = asyncio.Lock()

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


@dataclass
class ScheduleResult:
    data: Any = None
    stream_resp: Any = None
    routed_via: str = ""
    fallback_attempts: int = 0


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
                    max_keepalive_connections=20,
                    keepalive_expiry=30.0,
                ),
            )
        return _client


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
    for state in (_cooldown_until, _consecutive_failures, _latency_history):
        for k in list(state.keys()):
            if k not in valid_cand_ids:
                del state[k]
    for k in list(_semaphores.keys()):
        if k not in valid_key_ids:
            del _semaphores[k]
            _semaphore_limits.pop(k, None)
    _last_config_version = get_config_version()


def reset_runtime_state():
    """Clear ALL runtime scheduling state (cooldowns, circuit breakers,
    latency history, per-key semaphores).

    Used by POST /v1/reload to give a freshly reloaded config a clean slate.
    In-flight requests keep references to the old semaphore objects, so the
    effective per-key limit may briefly double — acceptable for a manual
    ops action."""
    _cooldown_until.clear()
    _consecutive_failures.clear()
    _latency_history.clear()
    _semaphores.clear()
    _semaphore_limits.clear()


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


async def schedule(
    config: dict,
    model_type: str,
    build_request: Callable[[dict, str, str], tuple],
    handle_stream: Optional[Callable[[httpx.Response], Any]] = None,
    is_stream: bool = False,
) -> ScheduleResult:
    """
    Core scheduler logic. Iterates candidates, runs failover logic, cooldown, and budget check.
    Records stats directly to in-memory stats module.
    """
    candidates = config.get("candidates", {}).get(model_type, [])
    if not candidates:
        raise RuntimeError(f"No active candidates configured for model type: {model_type}")

    # Prune stale runtime state (cooldowns, semaphores, ...) when the config
    # changed on disk — near-zero cost thanks to the version check.
    v = get_config_version()
    if v != _last_config_version:
        _prune_runtime_state(config)

    # Smart ordering: when latency_based_routing is enabled, sort candidates
    # by recent average latency so the fastest provider is tried first.
    # Default: OFF – respect the order configured in the admin UI so that
    # what the user sees is exactly what the scheduler uses.
    if config.get("latency_based_routing", False):
        candidates = _sort_candidates_by_latency(candidates)

    providers = config.get("providers", {})

    # Load settings from config with safe fallback and clamping
    try:
        upstream_timeout_sec = max(1.0, float(config.get("upstream_timeout", 12)))
    except (ValueError, TypeError):
        upstream_timeout_sec = 12.0

    try:
        total_budget_sec = max(1.0, float(config.get("schedule_total_budget", 15)))
    except (ValueError, TypeError):
        total_budget_sec = 15.0

    try:
        concurrency_limit = max(1, int(config.get("max_concurrency_per_key", 5)))
    except (ValueError, TypeError):
        concurrency_limit = 5

    try:
        cooldown_429 = max(1.0, float(config.get("cooldown_429_sec", 60)))
    except (ValueError, TypeError):
        cooldown_429 = 60.0

    try:
        cooldown_403 = max(1.0, float(config.get("cooldown_403_sec", 600)))
    except (ValueError, TypeError):
        cooldown_403 = 600.0

    try:
        cooldown_5xx = max(1.0, float(config.get("cooldown_duration", 30)))
    except (ValueError, TypeError):
        cooldown_5xx = 30.0

    cooldown_other = cooldown_5xx
    cooldown_read_timeout = 2.0

    try:
        circuit_break_threshold = max(1, int(config.get("circuit_break_threshold", 3)))
    except (ValueError, TypeError):
        circuit_break_threshold = 3

    try:
        circuit_cooldown = max(1.0, float(config.get("circuit_cooldown_sec", 300)))
    except (ValueError, TypeError):
        circuit_cooldown = 300.0

    start_time = time.time()
    errors = []
    attempt_seq = 0
    last_status_code = None
    last_err_body = None

    client = await get_client()
    # Per-request timeout: use a separate httpx.Timeout so that OCR (which
    # passes a longer upstream_timeout via config override) gets more time.
    req_timeout = httpx.Timeout(upstream_timeout_sec, connect=min(5.0, upstream_timeout_sec))

    for cand in candidates:
        # 1. Total budget check
        elapsed = time.time() - start_time
        if elapsed >= total_budget_sec:
            logger.warning(f"Failover budget exhausted. Elapsed: {elapsed:.2f}s >= budget {total_budget_sec}s")
            errors.append(f"budget_exhausted_after_{elapsed:.2f}s")
            break

        cand_id = get_candidate_id(cand)

        # 2. Cooldown check
        cooldown_expiry = _cooldown_until.get(cand_id, 0.0)
        if time.time() < cooldown_expiry:
            logger.info(f"Skipping candidate {cand_id} - cooling down until {cooldown_expiry}")
            continue

        provider_name = cand["provider"]
        key_label = cand["key"]

        provider = providers.get(provider_name)
        if not provider:
            logger.warning(f"Provider {provider_name} not found in config")
            continue

        api_key = provider.get("keys", {}).get(key_label)
        if not api_key:
            logger.warning(f"Key {key_label} not found for provider {provider_name}")
            continue

        base_url = provider.get("base_url", "")

        attempt_seq += 1

        # 3. Concurrency Semaphore acquisition per key
        sem_id = f"{provider_name}:{key_label}"
        sem = await get_key_semaphore(sem_id, concurrency_limit)

        logger.info(f"Attempt {attempt_seq}: Routing {model_type} to {cand_id}")

        cand_start = time.time()
        # Acquire the per-key semaphore (queueing here preserves agent-mode
        # behaviour), then the GLOBAL semaphore with a short bounded wait.
        # The global cap prevents memory exhaustion during burst ingestion
        # (e.g. dozens of concurrent OCR base64 payloads).  When it is
        # saturated we fail FAST with 503 + Retry-After instead of queueing
        # unboundedly — a queued request keeps its parsed body on the heap,
        # which defeats the cap's purpose.
        global_sem = _get_global_semaphore()
        await sem.acquire()
        global_sem_acquired = False
        try:
            try:
                await asyncio.wait_for(global_sem.acquire(), timeout=_GLOBAL_QUEUE_TIMEOUT_SEC)
                global_sem_acquired = True
            except asyncio.TimeoutError:
                raise GlobalOverloadError(retry_after=_GLOBAL_QUEUE_TIMEOUT_SEC)
            # Budget re-check AFTER queueing: time spent waiting on the key
            # semaphore counts toward the total failover budget — otherwise a
            # long-queued request would still fire upstream long after its
            # budget (and usually its client's patience) expired.
            if time.time() - start_time >= total_budget_sec:
                errors.append(f"budget_exhausted_after_{time.time() - start_time:.2f}s (queue wait)")
                break
            try:
                # Build request arguments (method, url, headers, json_body)
                method, url, headers, body = build_request(cand, api_key, base_url)

                if is_stream:
                    req = client.build_request(method, url, headers=headers, json=body)
                    req.extensions["timeout"] = {
                        "connect": min(5.0, upstream_timeout_sec),
                        "read": upstream_timeout_sec,
                        "write": upstream_timeout_sec,
                        "pool": 5.0,
                    }
                    resp = await client.send(req, stream=True)
                else:
                    resp = await client.request(method, url, headers=headers, json=body, timeout=req_timeout)

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
                    if is_stream:
                        first_chunk, remainder, peek_err = await _peek_first_chunk(resp)
                        if not first_chunk:
                            await resp.aclose()
                            reason = peek_err or "stream closed without sending any data"
                            err_msg = f"{cand_id} returned HTTP 200 but {reason}"
                            logger.warning(err_msg)
                            errors.append(err_msg)
                            cand_latency = time.time() - cand_start
                            stats.record(model_type, 502, cand_latency,
                                         provider=provider_name, key=key_label, error_msg=err_msg)
                            # Short cooldown — likely a transient provider glitch
                            _cooldown_until[cand_id] = time.time() + 5.0
                            continue

                    _consecutive_failures[cand_id] = 0
                    _cooldown_until[cand_id] = 0.0

                    routed_via = f"{provider_name}/{key_label}"
                    cand_latency = time.time() - cand_start

                    # Record latency for smart candidate ordering
                    _record_latency(cand_id, cand_latency)

                    stats.record(model_type, status_code, cand_latency,
                                 provider=provider_name, key=key_label)

                    if is_stream:
                        if handle_stream:
                            stream_result = await handle_stream(resp, first_chunk, remainder)
                            return ScheduleResult(
                                stream_resp=stream_result,
                                routed_via=routed_via,
                                fallback_attempts=attempt_seq - 1
                            )
                        # No handle_stream provided: hand back an async
                        # generator that replays the prefetched chunk and
                        # continues the live stream (internal callers always
                        # pass handle_stream for streams).
                        async def _fallback_gen(first=first_chunk, rem=remainder, r=resp):
                            try:
                                if first:
                                    yield first
                                if rem is not None:
                                    async for chunk in rem:
                                        yield chunk
                            finally:
                                await r.aclose()
                        return ScheduleResult(
                            stream_resp=_fallback_gen(),
                            routed_via=routed_via,
                            fallback_attempts=attempt_seq - 1
                        )
                    else:
                        resp_data = resp.json()
                        # OCR / vision responses can be large; release the
                        # httpx response buffer and reclaim heap pages.
                        if model_type == "ocr":
                            await resp.aclose()
                            await _reclaim_memory()
                        return ScheduleResult(
                            data=resp_data,
                            routed_via=routed_via,
                            fallback_attempts=attempt_seq - 1
                        )

                # Failure path (Non-2xx)
                if is_stream:
                    await resp.aread()

                # Capture upstream error body for forwarding to client
                try:
                    last_err_body = resp.text
                except Exception:
                    last_err_body = None
                last_status_code = status_code

                # Build a detailed error message including the upstream response body
                upstream_detail = ""
                if last_err_body:
                    # Truncate to keep logs readable but include enough context
                    upstream_detail = f" | upstream: {last_err_body[:500]}"
                err_msg = f"{cand_id} failed with HTTP {status_code}{upstream_detail}"
                logger.error(err_msg)
                errors.append(err_msg)

                cand_latency = time.time() - cand_start
                stats.record(model_type, status_code, cand_latency,
                             provider=provider_name, key=key_label, error_msg=err_msg)

                # --- Classify 400s BEFORE the early-exit check below ---
                _400_is_key_issue = False
                _is_content_moderation = False
                if status_code == 400 and last_err_body:
                    body_lower = last_err_body.lower()
                    # Key/account/subscription problems that repeat across requests
                    if any(kw in body_lower for kw in [
                        "subscription", "no active", "api key", "invalid_key",
                        "unauthorized", "account", "billing", "payment", "plan",
                    ]):
                        _400_is_key_issue = True
                    elif any(kw in body_lower for kw in [
                        "content_filter", "content management", "content moderation",
                        "data_inspection", "moderation", "sensitive", "inappropriate",
                        "pornograph", "审核", "敏感", "违规",
                    ]):
                        _is_content_moderation = True

                # --- Early exit for request-level 400s ---
                # If the upstream rejected the request due to client content or format/parameters
                # (and NOT a key/account issue), trying other candidates on the same provider with
                # the exact same payload is futile. Short-circuit immediately to return 400 without retry.
                if status_code == 400 and not _400_is_key_issue:
                    if _is_content_moderation:
                        logger.warning(f"Content moderation 400 from {cand_id} — skipping remaining candidates")
                        errors.append(f"{cand_id}: content rejected by upstream (not retrying other candidates)")
                    else:
                        logger.warning(f"Request-level 400 from {cand_id} — returning immediately without retry: {upstream_detail}")
                        errors.append(f"{cand_id}: request rejected by upstream ({last_err_body[:200] if last_err_body else '400 Bad Request'})")
                    _consecutive_failures[cand_id] = 0
                    break

                # --- Cooldown logic ---
                # Cooldown policy:
                #   400 (key issue)  – short cooldown (10s)
                #   400 (request)    – no cooldown (request-specific, early exited above)
                #   401/403 (auth)   – 600s cooldown (10 min)
                #   403 (quota)      – 60s cooldown (like 429)
                #   429              – 60s cooldown
                #   5xx              – 30s cooldown
                #   404/422          – request-level, no cooldown

                should_cooldown = (
                    (status_code == 400 and _400_is_key_issue)
                    or status_code in (401, 403, 429)
                    or status_code >= 500
                )

                if should_cooldown:
                    cf = _consecutive_failures.get(cand_id, 0) + 1
                    _consecutive_failures[cand_id] = cf

                    cd_sec = cooldown_other
                    if status_code == 429:
                        cd_sec = cooldown_429
                    elif status_code == 403:
                        # Smart 403: If due to quota / allowance exhaustion, use short cooldown (cooldown_429)
                        _is_quota_403 = bool(last_err_body and any(w in last_err_body.lower() for w in ["quota", "allowance", "exhausted", "credit", "balance"]))
                        cd_sec = cooldown_429 if _is_quota_403 else cooldown_403
                    elif status_code == 400 and _400_is_key_issue:
                        cd_sec = 10.0  # short cooldown for key-related 400s
                    elif status_code >= 500:
                        cd_sec = cooldown_5xx

                    # Circuit breaker escalation
                    if cf >= circuit_break_threshold:
                        cd_sec = max(cd_sec, circuit_cooldown)
                        logger.warning(f"Circuit breaker triggered for {cand_id}. Cool down for {cd_sec}s.")

                    _cooldown_until[cand_id] = time.time() + cd_sec
                else:
                    # Non-cooldown cases (404/422 etc.): don't penalise key.
                    _consecutive_failures[cand_id] = 0

            except httpx.ReadTimeout as e:
                # ReadTimeout = model is slow (e.g. reasoning models), not a
                # key problem.  Use a very short cooldown and do NOT count
                # toward the circuit breaker so the key stays available.
                _cooldown_until[cand_id] = time.time() + cooldown_read_timeout
                # Record the timeout as latency so this candidate gets
                # deprioritised in smart ordering.
                _record_latency(cand_id, upstream_timeout_sec)
                err_msg = (f"{cand_id} encountered ReadTimeout after {upstream_timeout_sec:.0f}s "
                           f"(model may be slow, not penalised)")
                logger.warning(err_msg)
                errors.append(err_msg)

                cand_latency = time.time() - cand_start
                # 599 = pseudo-code for client-side read timeout: keeps the 5xx
                # bucket in stats but stays distinguishable from real upstream 5xx.
                stats.record(model_type, 599, cand_latency,
                             provider=provider_name, key=key_label, error_msg=err_msg)

            except httpx.ConnectTimeout as e:
                # ConnectTimeout = network issue, short cooldown
                _cooldown_until[cand_id] = time.time() + 5.0
                # Record a high latency to deprioritise this candidate
                _record_latency(cand_id, 10.0)
                err_msg = f"{cand_id} encountered ConnectTimeout: {str(e)}"
                logger.error(err_msg)
                errors.append(err_msg)

                cand_latency = time.time() - cand_start
                # 598 = pseudo-code for connect timeout (network issue, not upstream 5xx)
                stats.record(model_type, 598, cand_latency,
                             provider=provider_name, key=key_label, error_msg=err_msg)

            except Exception as e:
                cf = _consecutive_failures.get(cand_id, 0) + 1
                _consecutive_failures[cand_id] = cf

                cd_sec = cooldown_other
                if cf >= circuit_break_threshold:
                    cd_sec = max(cd_sec, circuit_cooldown)
                    logger.warning(f"Circuit breaker triggered for {cand_id}. Cool down for {cd_sec}s.")

                _cooldown_until[cand_id] = time.time() + cd_sec
                err_msg = f"{cand_id} encountered {type(e).__name__}: {str(e)}"
                logger.error(err_msg)
                errors.append(err_msg)

                cand_latency = time.time() - cand_start
                stats.record(model_type, 500, cand_latency,
                             provider=provider_name, key=key_label, error_msg=err_msg)

            finally:
                if global_sem_acquired:
                    global_sem.release()
        finally:
            sem.release()

    # If all candidates failed or were skipped
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
