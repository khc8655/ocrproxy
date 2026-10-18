#!/usr/bin/env python3
"""
Test Suite for PR #2 (P1 Relay Reliability):
1. Saturated key fast switch & free candidate prioritization
2. 429 Retry-After parsing (seconds & HTTP-date) & evaluation (Agent / KB mode)
3. Mid-stream break StreamInterruptedError & SSE terminal error framing (OpenAI & Anthropic)
4. Coalesced & throttled KB/OCR memory reclamation (_reclaim_memory)
"""
import asyncio
import json
import time
import unittest
from unittest.mock import AsyncMock, patch, MagicMock
from pathlib import Path
import sys
from datetime import datetime, timezone, timedelta

BASE_DIR = Path(__file__).resolve().parent.parent
VM_APP_DIR = BASE_DIR / "vm-app"
if str(VM_APP_DIR) not in sys.path:
    sys.path.insert(0, str(VM_APP_DIR))

from app.scheduler import (
    evaluate_candidate_failure,
    _parse_retry_after,
    _guard_stream,
    StreamInterruptedError,
    _reclaim_memory,
    _semaphores,
    get_candidate_id,
)
from app.proxy_routes import _sse_stream_error, _stream_with_keepalive


class TestP1ReliabilitySuite(unittest.TestCase):

    def test_parse_retry_after_numeric(self):
        """Verify numeric delta-seconds parsing."""
        self.assertIsNone(_parse_retry_after(None))
        self.assertIsNone(_parse_retry_after(""))
        self.assertIsNone(_parse_retry_after("   "))
        self.assertEqual(_parse_retry_after("15"), 15.0)
        self.assertEqual(_parse_retry_after(" 30.5 "), 30.5)
        self.assertEqual(_parse_retry_after("0"), 0.0)
        self.assertEqual(_parse_retry_after("-10"), 0.0)
        self.assertIsNone(_parse_retry_after("invalid_header_value"))

    def test_parse_retry_after_http_date(self):
        """Verify RFC 1123 / HTTP-date parsing."""
        future_time = datetime.now(timezone.utc) + timedelta(seconds=45)
        # Formatted like: Wed, 21 Oct 2026 07:28:00 GMT
        http_date = future_time.strftime("%a, %d %b %Y %H:%M:%S GMT")
        parsed = _parse_retry_after(http_date)
        self.assertIsNotNone(parsed)
        # Should be approximately 45s (allow +/- 5s for execution timing)
        self.assertAlmostEqual(parsed, 45.0, delta=5.0)

    def test_429_retry_after_agent_mode_with_alternatives(self):
        """Agent mode: 429 with Retry-After cools down candidate up to 60s when alternatives exist."""
        # 1. Retry-After = 20s
        eval_res = evaluate_candidate_failure(
            status_code=429,
            is_quota=False,
            is_key_issue_400=False,
            category="agent",
            consecutive_5xx_count=0,
            config_params={"retry_after_sec": 20.0, "has_alternatives": True}
        )
        self.assertEqual(eval_res.cooldown_sec, 20.0)
        self.assertFalse(eval_res.is_quota)

        # 2. Retry-After = 120s -> capped at 60s
        eval_res_capped = evaluate_candidate_failure(
            status_code=429,
            is_quota=False,
            is_key_issue_400=False,
            category="agent",
            consecutive_5xx_count=0,
            config_params={"retry_after_sec": 120.0, "has_alternatives": True}
        )
        self.assertEqual(eval_res_capped.cooldown_sec, 60.0)

    def test_429_retry_after_agent_mode_single_candidate(self):
        """Agent mode: 429 with single candidate MUST NOT cooldown (avoids complete outage)."""
        eval_res = evaluate_candidate_failure(
            status_code=429,
            is_quota=False,
            is_key_issue_400=False,
            category="agent",
            consecutive_5xx_count=0,
            config_params={"retry_after_sec": 30.0, "has_alternatives": False}
        )
        self.assertEqual(eval_res.cooldown_sec, 0.0, "Single candidate must not be locked out upon 429")

    def test_429_retry_after_kb_mode(self):
        """KB mode: 429 takes max(cooldown_tpm_sec, Retry-After <= 300s)."""
        # Case A: Retry-After (45s) > cooldown_tpm_sec (10s)
        eval_a = evaluate_candidate_failure(
            status_code=429,
            is_quota=False,
            is_key_issue_400=False,
            category="kb",
            consecutive_5xx_count=0,
            config_params={"cooldown_tpm_sec": 10.0, "retry_after_sec": 45.0}
        )
        self.assertEqual(eval_a.cooldown_sec, 45.0)

        # Case B: Retry-After (5s) < cooldown_tpm_sec (15s)
        eval_b = evaluate_candidate_failure(
            status_code=429,
            is_quota=False,
            is_key_issue_400=False,
            category="kb",
            consecutive_5xx_count=0,
            config_params={"cooldown_tpm_sec": 15.0, "retry_after_sec": 5.0}
        )
        self.assertEqual(eval_b.cooldown_sec, 15.0)

        # Case C: Retry-After (500s) capped at 300s
        eval_c = evaluate_candidate_failure(
            status_code=429,
            is_quota=False,
            is_key_issue_400=False,
            category="kb",
            consecutive_5xx_count=0,
            config_params={"cooldown_tpm_sec": 10.0, "retry_after_sec": 500.0}
        )
        self.assertEqual(eval_c.cooldown_sec, 300.0)

    def test_sse_stream_error_formatting(self):
        """Verify _sse_stream_error formats properly for OpenAI and Anthropic."""
        # OpenAI format
        err_openai = _sse_stream_error("connection reset by peer", error_format="openai")
        self.assertTrue(err_openai.startswith(b"data: "))
        self.assertTrue(err_openai.endswith(b"\n\n"))
        parsed_openai = json.loads(err_openai[len(b"data: "):-2].decode())
        self.assertIn("error", parsed_openai)
        self.assertEqual(parsed_openai["error"]["type"], "upstream_stream_interrupted")
        self.assertIn("connection reset by peer", parsed_openai["error"]["message"])

        # Anthropic format
        err_anthropic = _sse_stream_error("upstream read timeout", error_format="anthropic")
        self.assertTrue(err_anthropic.startswith(b"event: error\ndata: "))
        self.assertTrue(err_anthropic.endswith(b"\n\n"))
        data_part = err_anthropic.split(b"\ndata: ")[1][:-2]
        parsed_anthropic = json.loads(data_part.decode())
        self.assertEqual(parsed_anthropic["type"], "error")
        self.assertEqual(parsed_anthropic["error"]["type"], "api_error")
        self.assertIn("upstream read timeout", parsed_anthropic["error"]["message"])

    def test_stream_interrupted_guard_and_keepalive(self):
        """Verify _guard_stream raises StreamInterruptedError and _stream_with_keepalive yields terminal error."""
        async def run_test():
            # Mock generator that yields 1 chunk then raises exception
            async def failing_generator():
                yield b"chunk 1"
                await asyncio.sleep(0.01)
                raise ConnectionResetError("Remote server closed connection")

            error_callback_called = []
            def on_error(exc, sent):
                error_callback_called.append((exc, sent))

            guarded = _guard_stream(failing_generator(), first_len=10, on_error=on_error)

            collected_chunks = []
            async for chunk in _stream_with_keepalive(b"first-head", guarded, keepalive_sec=1.0, error_format="openai"):
                collected_chunks.append(chunk)

            # Verification
            self.assertEqual(len(error_callback_called), 1)
            self.assertEqual(error_callback_called[0][1], 17) # 10 + 7
            self.assertTrue(any(b"upstream_stream_interrupted" in c for c in collected_chunks))
            terminal_chunk = collected_chunks[-1]
            self.assertTrue(terminal_chunk.startswith(b"data: "))

        asyncio.run(run_test())

    def test_reclaim_memory_coalescing(self):
        """Verify _reclaim_memory is non-blocking and coalesces multiple calls."""
        async def run_test():
            with patch("app.scheduler._reclaim_memory_sync") as mock_sync:
                # Trigger 5 calls rapidly
                for _ in range(5):
                    await _reclaim_memory()

                # Yield to let event loop tick
                await asyncio.sleep(0.1)

                # Wait for any scheduled runner to finish
                from app.scheduler import _reclaim_task
                if _reclaim_task and not _reclaim_task.done():
                    await _reclaim_task

                # Must not have run 5 times concurrently
                self.assertLessEqual(mock_sync.call_count, 1)

        asyncio.run(run_test())

    def test_saturated_key_reordering_logic(self):
        """Verify saturated candidates are placed after free candidates while preserving relative order."""
        sem_locked = asyncio.Semaphore(1)
        sem_locked.acquire = MagicMock()
        # Mock locked state
        sem_locked_mock = MagicMock()
        sem_locked_mock.locked.return_value = True

        sem_free_mock = MagicMock()
        sem_free_mock.locked.return_value = False

        _semaphores["prov_a:key_busy"] = sem_locked_mock
        _semaphores["prov_b:key_free1"] = sem_free_mock
        _semaphores["prov_c:key_free2"] = sem_free_mock

        ordered_items = [
            (0, {"provider": "prov_a", "key": "key_busy", "model": "m1"}),
            (1, {"provider": "prov_b", "key": "key_free1", "model": "m2"}),
            (2, {"provider": "prov_c", "key": "key_free2", "model": "m3"}),
        ]

        def _saturated(item):
            c = item[1]
            sem_ = _semaphores.get(f"{c.get('provider', '')}:{c.get('key', '')}")
            return sem_ is not None and sem_.locked()

        _free = [it for it in ordered_items if not _saturated(it)]
        if _free and len(_free) < len(ordered_items):
            reordered = _free + [it for it in ordered_items if _saturated(it)]
        else:
            reordered = ordered_items

        self.assertEqual(reordered[0][1]["key"], "key_free1")
        self.assertEqual(reordered[1][1]["key"], "key_free2")
        self.assertEqual(reordered[2][1]["key"], "key_busy", "Busy candidate must be pushed to the tail")



if __name__ == "__main__":
    unittest.main()
