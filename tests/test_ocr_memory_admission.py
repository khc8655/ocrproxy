import asyncio
import unittest
from unittest.mock import MagicMock
import httpx
import sys
from pathlib import Path

# Add vm-app to sys.path
vm_app_path = Path(__file__).resolve().parent.parent / "vm-app"
if str(vm_app_path) not in sys.path:
    sys.path.insert(0, str(vm_app_path))

# Mock fastapi if not installed locally
if "fastapi" not in sys.modules:
    fastapi_mock = MagicMock()
    fastapi_mock.__path__ = []
    fastapi_mock.FastAPI = MagicMock
    fastapi_mock.Request = MagicMock
    fastapi_mock.APIRouter = MagicMock
    sys.modules["fastapi"] = fastapi_mock
    resp_mock = MagicMock()
    class MockJSONResponse:
        def __init__(self, content=None, status_code=200, headers=None):
            self.content = content
            self.status_code = status_code
            self.headers = headers or {}
            import json
            self.body = json.dumps(content).encode("utf-8") if isinstance(content, dict) else b""
    resp_mock.JSONResponse = MockJSONResponse
    resp_mock.Response = MagicMock
    resp_mock.StreamingResponse = MagicMock
    sys.modules["fastapi.responses"] = resp_mock

from app.scheduler import release_httpx_response
from app.proxy_routes import _ocr_limits, _get_ocr_semaphore, _ocr_busy_response


class TestOcrMemoryAdmission(unittest.TestCase):
    def test_release_httpx_response(self):
        # 1. Safe no-op on None
        release_httpx_response(None)

        # 2. Breaks stream cycle on real Response
        resp = httpx.Response(status_code=200, content=b"hello")
        self.assertIsInstance(resp.stream, httpx.ByteStream)
        
        # Simulate a cyclic bound stream
        mock_stream = MagicMock()
        resp.stream = mock_stream
        release_httpx_response(resp)
        self.assertIsInstance(resp.stream, httpx.ByteStream)
        self.assertNotEqual(resp.stream, mock_stream)

    def test_ocr_limits_defaults_and_custom(self):
        # Default limits
        limit, wait = _ocr_limits({})
        self.assertEqual(limit, 6)
        self.assertEqual(wait, 30.0)

        # Custom valid limits
        limit, wait = _ocr_limits({"ocr_max_inflight": 3, "ocr_queue_timeout_sec": 15.0})
        self.assertEqual(limit, 3)
        self.assertEqual(wait, 15.0)

        # Invalid formats fallback safely
        limit, wait = _ocr_limits({"ocr_max_inflight": "bad", "ocr_queue_timeout_sec": None})
        self.assertEqual(limit, 6)
        self.assertEqual(wait, 30.0)

    def test_ocr_semaphore_caching(self):
        sem1 = _get_ocr_semaphore(4)
        self.assertIsInstance(sem1, asyncio.Semaphore)
        
        # Re-fetching with same limit returns cached instance
        sem2 = _get_ocr_semaphore(4)
        self.assertIs(sem1, sem2)

        # Changing limit rebuilds semaphore
        sem3 = _get_ocr_semaphore(8)
        self.assertIsNot(sem1, sem3)

    def test_ocr_busy_response(self):
        resp = _ocr_busy_response(6, 12.5)
        self.assertEqual(resp.status_code, 503)
        self.assertIn("Retry-After", resp.headers)
        self.assertEqual(resp.headers["Retry-After"], "10")
        import json
        data = json.loads(resp.body.decode("utf-8"))
        self.assertEqual(data["error"]["code"], "ocr_queue_full")


if __name__ == "__main__":
    unittest.main()
