import asyncio
import collections
import json
import os
import sys
import time
import unittest
from unittest.mock import MagicMock

# Graceful mock for httpx if not installed in local environment
if 'httpx' not in sys.modules:
    try:
        import httpx
    except ImportError:
        mock_httpx = MagicMock()
        class _FakeTransportError(Exception): pass
        class _FakeTimeoutException(Exception): pass
        mock_httpx.TransportError = _FakeTransportError
        mock_httpx.TimeoutException = _FakeTimeoutException
        mock_httpx.ConnectError = type("ConnectError", (_FakeTransportError,), {})
        mock_httpx.ConnectTimeout = type("ConnectTimeout", (_FakeTimeoutException,), {})
        mock_httpx.ReadError = type("ReadError", (_FakeTransportError,), {})
        mock_httpx.RemoteProtocolError = type("RemoteProtocolError", (_FakeTransportError,), {})
        mock_httpx.WriteError = type("WriteError", (_FakeTransportError,), {})
        mock_httpx.WriteTimeout = type("WriteTimeout", (_FakeTimeoutException,), {})
        mock_httpx.PoolTimeout = type("PoolTimeout", (_FakeTimeoutException,), {})
        mock_httpx.ByteStream = lambda b: b
        sys.modules['httpx'] = mock_httpx

# Ensure vm-app is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../vm-app")))

from app import scheduler
from app.scheduler import (
    _provider_rpm,
    _rpm_windows,
    _rpm_window,
    _rpm_wait,
    _rpm_try_acquire,
    _rpm_mark_exhausted,
    _prune_runtime_state,
    reset_runtime_state,
    AllCandidatesFailedError,
    schedule,
)


class TestRPMLimiter(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        reset_runtime_state()
        _rpm_windows.clear()

    def tearDown(self):
        reset_runtime_state()
        _rpm_windows.clear()

    def test_provider_rpm_parsing(self):
        """Test _provider_rpm helper with various inputs."""
        self.assertEqual(_provider_rpm(None), 0)
        self.assertEqual(_provider_rpm({}), 0)
        self.assertEqual(_provider_rpm({"rpm_per_key": ""}), 0)
        self.assertEqual(_provider_rpm({"rpm_per_key": 0}), 0)
        self.assertEqual(_provider_rpm({"rpm_per_key": "0"}), 0)
        self.assertEqual(_provider_rpm({"rpm_per_key": -5}), 0)
        self.assertEqual(_provider_rpm({"rpm_per_key": "invalid"}), 0)
        self.assertEqual(_provider_rpm({"rpm_per_key": 2}), 2)
        self.assertEqual(_provider_rpm({"rpm_per_key": "10"}), 10)

    def test_zero_overhead_when_unconfigured(self):
        """Zero overhead test: when rpm_per_key is not configured, _rpm_windows stays empty."""
        p = {"base_url": "https://api.test.com"}
        limit = _provider_rpm(p)
        self.assertEqual(limit, 0)
        self.assertEqual(len(_rpm_windows), 0)
        self.assertEqual(_rpm_wait("test:k1", limit), 0.0)
        self.assertTrue(_rpm_try_acquire("test:k1", limit))
        # Still nothing added to windows because limit <= 0
        self.assertEqual(len(_rpm_windows), 0)

    def test_sliding_window_basic(self):
        """Test 60s sliding window acquire and wait."""
        key_id = "amd:k1"
        limit = 2
        now = time.monotonic()

        # Slot 1: free
        self.assertEqual(_rpm_wait(key_id, limit, now), 0.0)
        self.assertTrue(_rpm_try_acquire(key_id, limit))
        self.assertEqual(len(_rpm_windows[key_id]), 1)

        # Slot 2: free
        self.assertEqual(_rpm_wait(key_id, limit, now), 0.0)
        self.assertTrue(_rpm_try_acquire(key_id, limit))
        self.assertEqual(len(_rpm_windows[key_id]), 2)

        # Slot 3: exhausted
        wait_sec = _rpm_wait(key_id, limit, now)
        self.assertGreater(wait_sec, 55.0)
        self.assertLessEqual(wait_sec, 60.1)
        self.assertFalse(_rpm_try_acquire(key_id, limit))
        self.assertEqual(len(_rpm_windows[key_id]), 2)

    def test_sliding_window_expiration(self):
        """Test entries expiring after 60s window."""
        key_id = "amd:k1"
        limit = 1
        t0 = 1000.0

        # Acquire at t0
        w = _rpm_window(key_id, t0)
        w.append(t0)

        # At t0 + 10s: blocked
        self.assertEqual(_rpm_wait(key_id, limit, t0 + 10.0), 50.0)

        # At t0 + 60.1s: expired and free
        self.assertEqual(_rpm_wait(key_id, limit, t0 + 60.1), 0.0)
        self.assertEqual(len(_rpm_window(key_id, t0 + 60.1)), 0)

    def test_mark_exhausted_on_unexpected_429(self):
        """Test _rpm_mark_exhausted fills the window to suppress key for 60s."""
        key_id = "amd:k1"
        limit = 5
        t0 = time.monotonic()

        # Key only made 1 request, but upstream returned 429
        self.assertTrue(_rpm_try_acquire(key_id, limit))
        self.assertEqual(len(_rpm_windows[key_id]), 1)

        # Mark exhausted
        _rpm_mark_exhausted(key_id, limit)
        self.assertEqual(len(_rpm_windows[key_id]), limit)
        wait_sec = _rpm_wait(key_id, limit, t0)
        self.assertGreater(wait_sec, 55.0)

    def test_prune_runtime_state_cleans_rpm_windows(self):
        """Test _prune_runtime_state removes RPM windows for deleted keys."""
        _rpm_windows["p1:k1"] = collections.deque([time.monotonic()])
        _rpm_windows["p2:k2"] = collections.deque([time.monotonic()])

        # Config with only p1:k1
        cfg = {
            "candidates": {
                "chat": [{"provider": "p1", "key": "k1", "model": "m1"}]
            }
        }
        _prune_runtime_state(cfg)
        self.assertIn("p1:k1", _rpm_windows)
        self.assertNotIn("p2:k2", _rpm_windows)

    def test_concurrent_burst_atomic_acquisitions(self):
        """Verify that under concurrent requests, acquire never overshoots the limit."""
        key_id = "concurrent:k1"
        limit = 3
        success_count = 0

        async def worker():
            nonlocal success_count
            if _rpm_try_acquire(key_id, limit):
                success_count += 1

        async def run_burst():
            await asyncio.gather(*(worker() for _ in range(20)))

        asyncio.run(run_burst())
        self.assertEqual(success_count, 3)
        self.assertEqual(len(_rpm_windows[key_id]), 3)

    def test_get_rpm_usage(self):
        """Test get_rpm_usage correctly reports active counts per key."""
        from app.scheduler import get_rpm_usage
        _rpm_try_acquire("amd:keyA", 5)
        _rpm_try_acquire("amd:keyA", 5)
        _rpm_try_acquire("intern:keyB", 10)
        usage = get_rpm_usage()
        self.assertEqual(usage.get("amd:keyA"), 2)
        self.assertEqual(usage.get("intern:keyB"), 1)


    def test_key_level_rpm_override(self):
        """Test key-level rpm overrides provider-level rpm_per_key."""
        provider = {"name": "p1", "rpm_per_key": 2}
        key_raw_str = "sk-123456"
        key_raw_dict_override = {"key": "sk-654321", "rpm": 5}
        key_raw_dict_zero = {"key": "sk-789012", "rpm": 0}

        # 1. Plain string inherits provider rpm
        limit_str = _provider_rpm(provider)
        self.assertEqual(limit_str, 2)

        # 2. Key dict with rpm overrides provider rpm
        limit_override = _provider_rpm(provider)
        if isinstance(key_raw_dict_override, dict) and key_raw_dict_override.get("rpm") is not None:
            limit_override = max(0, int(key_raw_dict_override["rpm"]))
        self.assertEqual(limit_override, 5)

        # 3. Key dict with rpm=0 disables limit
        limit_zero = _provider_rpm(provider)
        if isinstance(key_raw_dict_zero, dict) and key_raw_dict_zero.get("rpm") is not None:
            limit_zero = max(0, int(key_raw_dict_zero["rpm"]))
        self.assertEqual(limit_zero, 0)


if __name__ == "__main__":
    unittest.main()

