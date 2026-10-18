import unittest
import httpx
from unittest.mock import MagicMock

from app.proxy_routes import _mark_retryable, _RETRYABLE_STATUSES
from app.scheduler import _transport_error_status, _PROVIDER_LEVEL_STATUSES, _PROVIDER_LEVEL_EXC

class TestRetryableLogic(unittest.TestCase):
    def test_transport_error_status_mapping(self):
        # Connect errors map to 502 Bad Gateway
        self.assertEqual(_transport_error_status(httpx.ConnectError("connection refused")), 502)
        self.assertEqual(_transport_error_status(httpx.ConnectTimeout("connect timeout")), 502)
        self.assertEqual(_transport_error_status(httpx.PoolTimeout("pool timeout")), 502)
        self.assertEqual(_transport_error_status(httpx.ReadError("connection reset by peer")), 502)
        self.assertEqual(_transport_error_status(httpx.RemoteProtocolError("server disconnected")), 502)

        # Read timeout maps to 504 Gateway Timeout
        self.assertEqual(_transport_error_status(httpx.ReadTimeout("read timeout")), 504)

        # Non-transport error maps to None
        self.assertIsNone(_transport_error_status(ValueError("bad value")))

    def test_mark_retryable_headers(self):
        # 502 Bad Gateway
        resp502 = MagicMock()
        resp502.status_code = 502
        resp502.headers = {}
        _mark_retryable(resp502)
        self.assertEqual(resp502.headers["x-should-retry"], "true")
        self.assertEqual(resp502.headers["Retry-After"], "1")

        # 504 Gateway Timeout
        resp504 = MagicMock()
        resp504.status_code = 504
        resp504.headers = {}
        _mark_retryable(resp504)
        self.assertEqual(resp504.headers["x-should-retry"], "true")
        self.assertEqual(resp504.headers["Retry-After"], "1")

        # 400 Bad Request
        resp400 = MagicMock()
        resp400.status_code = 400
        resp400.headers = {}
        _mark_retryable(resp400)
        self.assertEqual(resp400.headers["x-should-retry"], "false")

        # 429 Rate Limit
        resp429 = MagicMock()
        resp429.status_code = 429
        resp429.headers = {"retry-after": "60"}
        _mark_retryable(resp429)
        self.assertEqual(resp429.headers["x-should-retry"], "true")
        self.assertEqual(resp429.headers["retry-after"], "60")

    def test_provider_level_definitions(self):
        self.assertIn(502, _PROVIDER_LEVEL_STATUSES)
        self.assertIn(503, _PROVIDER_LEVEL_STATUSES)
        self.assertIn(504, _PROVIDER_LEVEL_STATUSES)
        self.assertIn(520, _PROVIDER_LEVEL_STATUSES)
        self.assertIn(524, _PROVIDER_LEVEL_STATUSES)

        self.assertIn(httpx.ReadError, _PROVIDER_LEVEL_EXC)
        self.assertIn(httpx.ConnectError, _PROVIDER_LEVEL_EXC)
        self.assertIn(httpx.RemoteProtocolError, _PROVIDER_LEVEL_EXC)

if __name__ == "__main__":
    unittest.main()
