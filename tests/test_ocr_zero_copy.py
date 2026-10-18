import asyncio
import json
import unittest
from pathlib import Path
import sys

# Add vm-app to sys.path
vm_app_path = Path(__file__).resolve().parent.parent / "vm-app"
if str(vm_app_path) not in sys.path:
    sys.path.insert(0, str(vm_app_path))

from unittest.mock import MagicMock

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
            self.body = json.dumps(content).encode("utf-8") if isinstance(content, dict) else b""
    resp_mock.JSONResponse = MockJSONResponse
    resp_mock.Response = MagicMock
    resp_mock.StreamingResponse = MagicMock
    sys.modules["fastapi.responses"] = resp_mock

from app.proxy_routes import (
    _OCR_IMG_PLACEHOLDER,
    _ReplayableBody,
    _ocr_stream_body,
    _replace_placeholder,
)


class TestOcrZeroCopy(unittest.TestCase):
    def test_stream_body_reconstruction(self):
        chat_body = {
            "model": "ocr-vision-v1",
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "请识别此图片并返回纯文本。"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64," + _OCR_IMG_PLACEHOLDER}}
                ]
            }],
            "max_tokens": 4096,
            "stream": False
        }
        b64_content = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        body = _ocr_stream_body(chat_body, b64_content)
        self.assertIsNotNone(body)
        self.assertIsInstance(body, _ReplayableBody)

        # Collect async chunks
        async def collect():
            return [chunk async for chunk in body]

        chunks = asyncio.run(collect())
        full_bytes = b"".join(chunks)
        self.assertEqual(len(full_bytes), body.length)

        # Parse JSON and assert contents match
        parsed = json.loads(full_bytes.decode("utf-8"))
        expected_url = "data:image/png;base64," + b64_content
        self.assertEqual(parsed["messages"][0]["content"][1]["image_url"]["url"], expected_url)

    def test_replayable_multiple_iterations(self):
        body = _ReplayableBody(b'{"head":', "abcdef123456", b',"tail":true}')
        
        async def collect():
            return b"".join([c async for c in body])

        res1 = asyncio.run(collect())
        res2 = asyncio.run(collect())
        self.assertEqual(res1, res2)
        self.assertEqual(len(res1), body.length)
        self.assertEqual(res1, b'{"head":abcdef123456,"tail":true}')

    def test_fallback_on_unsafe_characters(self):
        chat_body = {
            "messages": [{"content": [{"type": "image_url", "image_url": {"url": _OCR_IMG_PLACEHOLDER}}]}]
        }
        # Image text containing quote or newline or control char
        unsafe_image = 'base64"with"quotes\nand\newline'
        body = _ocr_stream_body(chat_body, unsafe_image)
        self.assertIsNone(body, "Should detect unsafe characters and return None")

        # Fallback replacement works
        fallback = _replace_placeholder(chat_body, unsafe_image)
        self.assertEqual(fallback["messages"][0]["content"][0]["image_url"]["url"], unsafe_image)

    def test_fallback_on_missing_or_duplicate_placeholder(self):
        chat_body_no_ph = {"messages": []}
        self.assertIsNone(_ocr_stream_body(chat_body_no_ph, "abc"))

        chat_body_dup_ph = {
            "a": _OCR_IMG_PLACEHOLDER,
            "b": _OCR_IMG_PLACEHOLDER
        }
        self.assertIsNone(_ocr_stream_body(chat_body_dup_ph, "abc"))

    def test_large_image_slice_streaming(self):
        # 1MB image text
        large_image = "A" * (1024 * 1024)
        chat_body = {
            "model": "test",
            "messages": [{"content": [{"image_url": {"url": _OCR_IMG_PLACEHOLDER}}]}]
        }
        body = _ocr_stream_body(chat_body, large_image)
        self.assertIsNotNone(body)

        async def count_chunks():
            chunks = [c async for c in body]
            return len(chunks), b"".join(chunks)

        chunk_count, full_bytes = asyncio.run(count_chunks())
        # Head + 4 slices of 256KB + Tail = 6 chunks
        self.assertEqual(chunk_count, 6)
        self.assertEqual(len(full_bytes), body.length)


if __name__ == "__main__":
    unittest.main()
