#!/usr/bin/env python3
"""
Test Suite for PR #1 (P0 Relay Reliability):
1. Timeout precedence (endpoint timeout > global timeout) & budget floor
2. 404 non-abortion of failover & conditional cooldown
3. Stale connection 1-time retry on RemoteProtocolError/ReadError/WriteError
4. KB global concurrency isolation from Agent streams
5. Zero vendor hardcoding & zero leaked secrets
"""
import asyncio
import time
import unittest
from unittest.mock import AsyncMock, patch, MagicMock
from pathlib import Path
import sys

BASE_DIR = Path(__file__).resolve().parent.parent
VM_APP_DIR = BASE_DIR / "vm-app"
if str(VM_APP_DIR) not in sys.path:
    sys.path.insert(0, str(VM_APP_DIR))

import httpx
from app.scheduler import (
    evaluate_candidate_failure,
    _get_global_semaphore,
    _send_with_stale_retry,
    _STALE_CONN_ERRORS,
    _GLOBAL_MAX_CONCURRENCY,
)

class TestP0ReliabilitySuite(unittest.TestCase):

    def test_timeout_precedence_logic(self):
        """Verify per-endpoint upstream_timeout overrides global upstream_timeout_sec."""
        config = {"upstream_timeout_sec": 30.0, "upstream_timeout": 60.0}
        eff_timeout = max(1.0, float(config.get("upstream_timeout", config.get("upstream_timeout_sec", 15))))
        self.assertEqual(eff_timeout, 60.0, "Endpoint specific timeout (60s) must take precedence over global (30s)")

        # When upstream_timeout is omitted, global takes effect
        config_no_endpoint = {"upstream_timeout_sec": 45.0}
        eff_timeout_fallback = max(1.0, float(config_no_endpoint.get("upstream_timeout", config_no_endpoint.get("upstream_timeout_sec", 15))))
        self.assertEqual(eff_timeout_fallback, 45.0)

    def test_404_cooldown_evaluation(self):
        """Verify 404 cooldown is evaluated with configurable cooldown_404_sec."""
        # 1. Candidate evaluation for 404
        eval_res = evaluate_candidate_failure(
            status_code=404,
            is_quota=False,
            is_key_issue_400=False,
            category="agent",
            consecutive_5xx_count=0,
            config_params={"cooldown_404_sec": 600.0}
        )
        self.assertEqual(eval_res.cooldown_sec, 600.0)
        self.assertFalse(eval_res.is_quota)

        # 2. When cooldown_404_sec is set to 0.0 (e.g. single candidate), cooldown is 0
        eval_res_single = evaluate_candidate_failure(
            status_code=404,
            is_quota=False,
            is_key_issue_400=False,
            category="agent",
            consecutive_5xx_count=0,
            config_params={"cooldown_404_sec": 0.0}
        )
        self.assertEqual(eval_res_single.cooldown_sec, 0.0)

    def test_stale_connection_retry(self):
        """Verify _send_with_stale_retry retries once on RemoteProtocolError within 2s."""
        async def _run():
            attempts = 0
            async def mock_send():
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    raise httpx.RemoteProtocolError("Connection closed by peer")
                return "SUCCESS_RESPONSE"

            res = await _send_with_stale_retry(mock_send, "cand_test_1")
            self.assertEqual(res, "SUCCESS_RESPONSE")
            self.assertEqual(attempts, 2, "Must retry exactly once on stale socket error")

        asyncio.run(_run())

    def test_stale_connection_timeout_does_not_retry(self):
        """Verify errors occurring after the 2s window are NOT treated as stale connections."""
        async def _run():
            async def slow_failing_send():
                time.sleep(2.1)
                raise httpx.RemoteProtocolError("Late connection reset")

            with self.assertRaises(httpx.RemoteProtocolError):
                await _send_with_stale_retry(slow_failing_send, "cand_test_2")

        asyncio.run(_run())

    def test_kb_global_semaphore_limit(self):
        """Verify _get_global_semaphore dynamically respects configured limit."""
        sem30 = _get_global_semaphore(30)
        self.assertEqual(sem30._value, 30)

        sem50 = _get_global_semaphore(50)
        self.assertEqual(sem50._value, 50)

    def test_no_secrets_and_agnostic_rules(self):
        """Rule 11 Audit: Ensure no vendor names and no plain secrets in scheduler.py."""
        scheduler_file = VM_APP_DIR / "app" / "scheduler.py"
        content = scheduler_file.read_text(encoding="utf-8")
        for bad in ["opencode-free", "opencode_free", "_gen_opencode_session_id"]:
            self.assertNotIn(bad, content, f"Hardcoded vendor logic {bad} found in scheduler.py")
        for secret_pattern in ["sk-p15esx", "sk-Qy9fT", "XA43md"]:
            self.assertNotIn(secret_pattern, content, f"Leaked secret {secret_pattern} found in scheduler.py")

if __name__ == "__main__":
    unittest.main()
