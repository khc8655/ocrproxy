#!/usr/bin/env python3
"""
Unit tests for log folding, candidate status freshness, ASGI security headers,
and streamlined candidates_status keys (v2026.10.11-06).
"""
import sys
import time
import unittest
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
VM_APP_DIR = BASE_DIR / "vm-app"
if str(VM_APP_DIR) not in sys.path:
    sys.path.insert(0, str(VM_APP_DIR))

from app import stats


class TestLogFoldingAndPerformance(unittest.TestCase):
    def setUp(self):
        stats.reset()

    def tearDown(self):
        stats.reset()

    def test_kb_log_folding_does_not_skip_candidate_status_update(self):
        """Verify that when a KB error log is folded, candidate node status and latency still update!"""
        # First 429: latency 0.1s (100ms)
        stats.record_kb(
            kb_type="chat",
            status_code=429,
            latency=0.1,
            provider="deepseek",
            key="key1",
            model="deepseek-chat",
            error_msg="Rate limit exceeded tier 1"
        )
        st1 = stats.get_stats()
        cand_key = "kb:chat:deepseek:key1:deepseek-chat"
        self.assertIn(cand_key, st1["candidates_status"])
        self.assertEqual(st1["candidates_status"][cand_key]["status"], 429)
        self.assertEqual(st1["candidates_status"][cand_key]["latency_ms"], 100)
        self.assertEqual(len(st1["error_logs"]), 1)
        self.assertEqual(st1["error_logs"][0]["repeat_count"], 1)

        # Second 429 after 200ms: latency increases to 0.9s (900ms)
        stats.record_kb(
            kb_type="chat",
            status_code=429,
            latency=0.9,
            provider="deepseek",
            key="key1",
            model="deepseek-chat",
            error_msg="Rate limit exceeded tier 1"
        )
        st2 = stats.get_stats()
        # 1. Error log folded
        self.assertEqual(len(st2["error_logs"]), 1, "Error logs should fold into single entry")
        self.assertEqual(st2["error_logs"][0]["repeat_count"], 2)

        # 2. Candidate status latency MUST be updated to 900ms (NOT skipped!)
        self.assertEqual(st2["candidates_status"][cand_key]["status"], 429)
        self.assertEqual(
            st2["candidates_status"][cand_key]["latency_ms"],
            900,
            "Latency must update to 900ms even when error log is folded!"
        )

    def test_multi_key_alternating_error_folding_in_sliding_window(self):
        """Verify alternating errors across multiple keys (round-robin) are folded via sliding window search."""
        # Alternate 5 times between key_a and key_b (total 10 errors)
        for i in range(5):
            stats.record_agent(
                model_name="glm-4-flash",
                status_code=429,
                latency=0.15,
                provider="zhipu",
                key="key_a",
                error_msg="Zhipu rate limit 429"
            )
            stats.record_agent(
                model_name="glm-4-flash",
                status_code=429,
                latency=0.18,
                provider="zhipu",
                key="key_b",
                error_msg="Zhipu rate limit 429"
            )

        st = stats.get_stats()
        # Should fold into exactly 2 entries (one for key_a, one for key_b), NOT 10 entries!
        self.assertEqual(len(st["error_logs"]), 2, "Alternating errors must fold into 2 entries, not 10")
        counts = {log["key"]: log["repeat_count"] for log in st["error_logs"]}
        self.assertEqual(counts.get("key_a"), 5)
        self.assertEqual(counts.get("key_b"), 5)

    def test_error_message_truncation_to_300_chars(self):
        """Verify Agent and KB error messages are strictly bounded to 300 chars."""
        long_err = "x" * 1000
        stats.record_agent(
            model_name="test-model",
            status_code=500,
            latency=0.5,
            provider="test-p",
            key="test-k",
            error_msg=long_err
        )
        st = stats.get_stats()
        self.assertEqual(len(st["error_logs"]), 1)
        self.assertEqual(len(st["error_logs"][0]["error"]), 300)
        self.assertEqual(st["error_logs"][0]["error"], "x" * 300)

    def test_candidate_status_has_no_redundant_duplicate_keys(self):
        """Verify backend writes only the single canonical node key to candidate_status."""
        stats.record_agent(
            model_name="gemini-flash",
            status_code=200,
            latency=0.3,
            provider="google",
            key="k1"
        )
        stats.record_kb(
            kb_type="chat",
            status_code=200,
            latency=0.4,
            provider="openai",
            key="k2",
            model="gpt-4o-mini"
        )
        st = stats.get_stats()
        cand_keys = list(st["candidates_status"].keys())

        # Exact expected keys
        self.assertIn("agent:gemini-flash:google:k1", cand_keys)
        self.assertIn("kb:chat:openai:k2:gpt-4o-mini", cand_keys)

        # Legacy redundant keys should NOT exist
        self.assertNotIn("google:k1:agent:gemini-flash", cand_keys)
        self.assertNotIn("kb:chat:openai:k2", cand_keys)
        self.assertNotIn("openai:k2:chat", cand_keys)
    def test_asgi_security_headers(self):
        """Verify SecurityHeadersASGIMiddleware attaches headers directly via ASGI protocol."""
        import asyncio
        from app.middleware import SecurityHeadersASGIMiddleware

        async def dummy_app(scope, receive, send):
            await send({
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json")]
            })
            await send({
                "type": "http.response.body",
                "body": b'{"ok": true}'
            })

        middleware = SecurityHeadersASGIMiddleware(dummy_app)
        sent_messages = []

        async def mock_send(msg):
            sent_messages.append(msg)

        scope = {"type": "http", "method": "GET", "path": "/"}
        asyncio.run(middleware(scope, None, mock_send))

        self.assertEqual(len(sent_messages), 2)
        start_msg = sent_messages[0]
        self.assertEqual(start_msg["type"], "http.response.start")
        headers_dict = {k.decode().lower(): v.decode() for k, v in start_msg["headers"]}
        self.assertEqual(headers_dict.get("x-content-type-options"), "nosniff")
        self.assertEqual(headers_dict.get("x-frame-options"), "DENY")
        self.assertEqual(headers_dict.get("server"), "webserver")
        self.assertEqual(headers_dict.get("content-type"), "application/json")

    def test_loginerr_function_exists_in_bundles(self):
        """Verify that loginErr is defined in shared and bundled admin JS to prevent login breakdown."""
        core_js_path = BASE_DIR / "shared" / "admin" / "js" / "core.js"
        vm_core_js_path = BASE_DIR / "vm-app" / "static" / "js" / "core.js"
        admin_html_path = BASE_DIR / "vm-app" / "static" / "admin.html"

        core_content = core_js_path.read_text(encoding="utf-8")
        self.assertIn("function loginErr(", core_content, "shared core.js must define loginErr function")

        vm_core_content = vm_core_js_path.read_text(encoding="utf-8")
        self.assertIn("function loginErr(", vm_core_content, "vm-app static core.js must define loginErr function")

        admin_html_content = admin_html_path.read_text(encoding="utf-8")
        self.assertIn("loginErr", admin_html_content, "vm-app admin.html must reference loginErr")


if __name__ == "__main__":
    unittest.main()

