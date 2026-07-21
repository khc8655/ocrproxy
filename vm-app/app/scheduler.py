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

logger = logging.getLogger("scheduler")

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


def _reclaim_memory():
    """Run gc.collect() then malloc_trim(0) to return freed heap to the OS.
    Called after large-payload requests (OCR, large chat responses) rather
    than on a blind counter, so the cost is paid only when it matters."""
    gc.collect()
    if _libc is not None:
        try:
            _libc.malloc_trim(0)
        except Exception:
            pass


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


# Module-level in-memory state (persists across requests on the same instance)
_cooldown_until: Dict[str, float] = {}
_consecutive_failures: Dict[str, int] = {}
_semaphores: Dict[str, asyncio.Semaphore] = {}
_sem_lock = asyncio.Lock()

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
    return sorted(candidates, key=lambda c: (_get_avg_latency(get_candidate_id(c)), candidates.index(c)))


async def get_client(connect_timeout: float, read_timeout: float) -> httpx.AsyncClient:
    """Get or create the global async HTTP client.

    The client is created with a generous read timeout (300s) so that
    slow endpoints (OCR, vision models) don't time out at the client level.
    Per-request timeouts are enforced via httpx.Timeout on individual
    build_request/send calls when needed.
    """
    global _client
    if _client is not None:
        return _client
    async with _client_lock:
        if _client is None:
            _client = httpx.AsyncClient(
                timeout=httpx.Timeout(300.0, connect=5.0),
                limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
            )
        return _client


async def close_client():
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def get_key_semaphore(key_id: str, limit: int) -> asyncio.Semaphore:
    async with _sem_lock:
        if key_id not in _semaphores:
            _semaphores[key_id] = asyncio.Semaphore(limit)
        return _semaphores[key_id]


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

    # Smart ordering: when latency_based_routing is enabled, sort candidates
    # by recent average latency so the fastest provider is tried first.
    # Default: OFF – respect the order configured in the admin UI so that
    # what the user sees is exactly what the scheduler uses.
    if config.get("latency_based_routing", False):
        candidates = _sort_candidates_by_latency(candidates)

    providers = config.get("providers", {})

    # Load settings from config or defaults
    upstream_timeout_sec = float(config.get("upstream_timeout", 12))
    total_budget_sec = float(config.get("schedule_total_budget", 15))
    concurrency_limit = int(config.get("max_concurrency_per_key", 5))

    cooldown_429 = float(config.get("cooldown_429_sec", 60))
    cooldown_403 = float(config.get("cooldown_403_sec", 600))
    cooldown_5xx = float(config.get("cooldown_duration", 30))
    cooldown_other = float(config.get("cooldown_duration", 30))
    # ReadTimeout means the model is just slow (e.g. reasoning models like
    # DeepSeek-R1), NOT that the key is broken.  Use a very short cooldown
    # so the key remains available for the next request.
    cooldown_read_timeout = 2.0
    circuit_break_threshold = int(config.get("circuit_break_threshold", 3))
    circuit_cooldown = float(config.get("circuit_cooldown_sec", 300))

    start_time = time.time()
    errors = []
    attempt_seq = 0
    last_status_code = None
    last_err_body = None

    client = await get_client(min(5.0, upstream_timeout_sec), upstream_timeout_sec)
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
        async with sem:
            # Build request arguments (method, url, headers, json_body)
            method, url, headers, body = build_request(cand, api_key, base_url)

            try:
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
                            stream_result = await handle_stream(resp)
                            return ScheduleResult(
                                stream_resp=stream_result,
                                routed_via=routed_via,
                                fallback_attempts=attempt_seq - 1
                            )
                        return ScheduleResult(
                            stream_resp=resp,
                            routed_via=routed_via,
                            fallback_attempts=attempt_seq - 1
                        )
                    else:
                        resp_data = resp.json()
                        # OCR / vision responses can be large; release the
                        # httpx response buffer and reclaim heap pages.
                        if model_type == "ocr":
                            await resp.aclose()
                            _reclaim_memory()
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

                # --- Cooldown logic ---
                # 4xx client errors (400, 404, 422, etc.) are caused by the REQUEST,
                # not by the key/provider.  Putting the key in cooldown would
                # "poison" it for unrelated future requests.
                # Only apply cooldown for:
                #   401/403  – auth/permission issues (key problem)
                #   429      – rate limiting (key problem)
                #   5xx      – server errors (provider problem)
                should_cooldown = (
                    status_code in (401, 403, 429)
                    or status_code >= 500
                )

                if should_cooldown:
                    cf = _consecutive_failures.get(cand_id, 0) + 1
                    _consecutive_failures[cand_id] = cf

                    cd_sec = cooldown_other
                    if status_code == 429:
                        cd_sec = cooldown_429
                    elif status_code == 403:
                        cd_sec = cooldown_403
                    elif status_code >= 500:
                        cd_sec = cooldown_5xx

                    # Circuit breaker escalation
                    if cf >= circuit_break_threshold:
                        cd_sec = max(cd_sec, circuit_cooldown)
                        logger.warning(f"Circuit breaker triggered for {cand_id}. Cool down for {cd_sec}s.")

                    _cooldown_until[cand_id] = time.time() + cd_sec
                else:
                    # Client-side 4xx (400, 404, 422 …): do NOT penalise the key.
                    # Reset consecutive failures since this isn't a key problem.
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
                stats.record(model_type, 500, cand_latency,
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
                stats.record(model_type, 500, cand_latency,
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

    # If all candidates failed or were skipped
    if errors:
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
        errors=errors,
    )
