"""
Automated Verification Suite for Phase 2:
1. ConcurrencyLease lifecycle & idempotence
2. Streaming Response concurrency slot retention (permits held until stream finished)
3. Monotonic hard deadline & bounded key semaphore wait
4. Non-streaming immediate lease release
"""
import sys
import os
import asyncio
import time
from typing import Optional, Any
from unittest.mock import AsyncMock, MagicMock

# Add root and vm-app to sys.path
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "vm-app"))

import tests.mock_env
from app.scheduler import ConcurrencyLease, ScheduleResult, schedule, get_key_semaphore, _get_global_semaphore, AllCandidatesFailedError
import app.scheduler as sched_mod


async def test_concurrency_lease_lifecycle_and_idempotence():
    """Verify that ConcurrencyLease holds permits and releases them exactly once."""
    key_sem = asyncio.Semaphore(1)
    global_sem = asyncio.Semaphore(1)

    await key_sem.acquire()
    await global_sem.acquire()
    assert key_sem.locked()
    assert global_sem.locked()

    lease = ConcurrencyLease(key_sem=key_sem, global_sem=global_sem)
    assert not lease._released

    # First release should free both
    lease.release()
    assert lease._released
    assert not key_sem.locked()
    assert not global_sem.locked()

    # Second release should be a no-op, NOT incrementing semaphore beyond initial value
    lease.release()
    assert not key_sem.locked()
    # Acquire once should succeed
    await asyncio.wait_for(key_sem.acquire(), timeout=0.1)
    assert key_sem.locked()
    # If released twice, acquiring a second time without release would succeed (which would be a bug)
    timed_out = False
    try:
        await asyncio.wait_for(key_sem.acquire(), timeout=0.1)
    except asyncio.TimeoutError:
        timed_out = True
    assert timed_out, "Key semaphore should not have extra permits"
    key_sem.release()


async def test_stream_concurrency_retention():
    """Verify that during a streaming response, key and global semaphores remain HELD until stream completes."""
    key_sem = asyncio.Semaphore(1)
    global_sem = asyncio.Semaphore(1)

    # Mock candidate config
    config = {
        "run_mode": "agent",
        "upstream_timeout_sec": 10.0,
        "schedule_total_budget": 10.0,
        "max_concurrency_per_key": 1,
        "candidates": {
            "chat": [
                {
                    "provider": "mock_p",
                    "key": "mock_k",
                    "model": "mock-model",
                }
            ]
        },
        "providers": {
            "mock_p": {
                "base_url": "https://api.mock.com",
                "keys": {"mock_k": "sk-mock"},
            }
        }
    }

    # Stream state flag
    stream_running = asyncio.Event()
    finish_stream = asyncio.Event()

    async def mock_handle_stream(resp, first_chunk, remainder, lease=None):
        async def event_generator():
            stream_running.set()
            yield first_chunk
            await finish_stream.wait()
            yield b"data: done\n\n"
            if lease:
                lease.release()

        # Return a simulated generator wrapper
        gen = event_generator()
        return gen

    # Patch client and peek in scheduler
    class MockStreamResp:
        status_code = 200
        content = b""
        headers = {"content-type": "text/event-stream"}
        async def aiter_bytes(self):
            # schedule() now buffers via _peek_until_payload (reads aiter_bytes
            # until the first real SSE payload) instead of _peek_first_chunk.
            yield b'data: {"choices":[{"delta":{"content":"first"}}]}\n\n'
        async def aclose(self):
            pass

    async def mock_peek(resp):
        return b"data: first\n\n", None, None

    orig_peek = sched_mod._peek_first_chunk
    sched_mod._peek_first_chunk = mock_peek

    # Intercept client request
    mock_client = AsyncMock()
    mock_req = MagicMock()
    mock_req.extensions = {}
    mock_client.build_request = MagicMock(return_value=mock_req)
    mock_client.send = AsyncMock(return_value=MockStreamResp())

    orig_get_client = sched_mod.get_client
    sched_mod.get_client = AsyncMock(return_value=mock_client)

    try:
        def build_req(cand, key, url):
            return "POST", url, {}, {"model": cand["model"]}

        # Start streaming request in background
        task = asyncio.create_task(
            schedule(
                config,
                "chat",
                build_req,
                handle_stream=mock_handle_stream,
                is_stream=True,
                category="agent",
            )
        )

        # Wait for schedule() to complete and return ScheduleResult
        sr = await asyncio.wait_for(task, timeout=2.0)
        assert sr.lease is not None
        assert not sr.lease._released, "Lease must NOT be released when schedule() returns streaming result!"

        # Now consume first chunk from generator
        gen = sr.stream_resp
        first = await gen.__anext__()
        assert first == b'data: {"choices":[{"delta":{"content":"first"}}]}\n\n', first
        assert not sr.lease._released, "Lease must STILL be held while client is consuming stream!"

        # Attempt to acquire the key semaphore with a second request - it MUST be blocked!
        sem = await get_key_semaphore("mock_p:mock_k", 1)
        blocked = False
        try:
            await asyncio.wait_for(sem.acquire(), timeout=0.1)
        except asyncio.TimeoutError:
            blocked = True
        assert blocked, "Competing request must be blocked while stream is running!"

        # Now signal finish and read remaining
        finish_stream.set()
        second = await gen.__anext__()
        assert second == b"data: done\n\n"

        # Generator exhausted
        exhausted = False
        try:
            await gen.__anext__()
        except StopAsyncIteration:
            exhausted = True
        assert exhausted, "Generator should be exhausted"

        # Now lease must be released!
        assert sr.lease._released, "Lease MUST be released after stream terminates!"

        # Now key semaphore can be acquired!
        await asyncio.wait_for(sem.acquire(), timeout=0.2)
        sem.release()

    finally:
        sched_mod._peek_first_chunk = orig_peek
        sched_mod.get_client = orig_get_client


async def test_monotonic_deadline_and_semaphore_timeout():
    """Verify that saturated key semaphore times out gracefully within bounded deadline."""
    config = {
        "run_mode": "agent",
        # Legacy `schedule_total_budget` is migrated at config-load time only;
        # the scheduler itself reads request_total_budget_sec (cap, never below
        # one attempt) and agent_first_byte_timeout_sec (single attempt).
        "upstream_timeout_sec": 5.0,
        "agent_first_byte_timeout_sec": 1.0,
        "request_total_budget_sec": 0.5,
        "max_concurrency_per_key": 1,
        "candidates": {
            "chat": [
                {
                    "provider": "sat_p",
                    "key": "sat_k",
                    "model": "sat-model",
                }
            ]
        },
        "providers": {
            "sat_p": {
                "base_url": "https://api.sat.com",
                "keys": {"sat_k": "sk-sat"},
            }
        }
    }

    # Pre-saturate key semaphore
    sem = await get_key_semaphore("sat_p:sat_k", 1)
    await sem.acquire()

    try:
        def build_req(cand, key, url):
            return "POST", url, {}, {"model": cand["model"]}

        start = time.monotonic()
        failed = False
        err_str = ""
        try:
            await schedule(config, "chat", build_req, is_stream=False, category="agent")
        except AllCandidatesFailedError as e:
            failed = True
            err_str = str(e)

        elapsed = time.monotonic() - start
        assert failed, "Expected AllCandidatesFailedError on semaphore exhaustion"
        # Hard deadline was 0.5s, so total wait should be around 0.5-1.5s, NOT hang indefinitely!
        assert elapsed < 2.0, f"Expected timeout under 2.0s, got {elapsed:.2f}s"
        assert "timed out" in err_str or "budget_exhausted" in err_str, f"Unexpected error message: {err_str}"

    finally:
        sem.release()


def run_tests():
    print("=== Running Phase 2 Automated Tests ===")
    asyncio.run(test_concurrency_lease_lifecycle_and_idempotence())
    print("  PASS: ConcurrencyLease lifecycle & idempotence")
    asyncio.run(test_stream_concurrency_retention())
    print("  PASS: Streaming Response holds concurrency lease for full duration")
    asyncio.run(test_monotonic_deadline_and_semaphore_timeout())
    print("  PASS: Monotonic deadline & key semaphore wait bounded")
    print("\nPhase 2 Summary: ALL TESTS PASSED!")


if __name__ == "__main__":
    run_tests()
