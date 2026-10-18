import asyncio
import json
import time
import unittest
from unittest.mock import MagicMock
import sys
from pathlib import Path

# Ensure vm-app is in sys.path
vm_app_path = Path(__file__).resolve().parent.parent / "vm-app"
if str(vm_app_path) not in sys.path:
    sys.path.insert(0, str(vm_app_path))

from app.scheduler import (
    _sse_event_verdict,
    _scan_sse_prefix,
    _inband_status,
    _nonstream_inband_error,
    _stall_bench_seconds,
    _stall_strikes,
    _peek_until_payload,
    reset_runtime_state,
)


class FakeResponse:
    """Mock httpx streaming response."""
    def __init__(self, chunks, delay=0.0):
        self._chunks = list(chunks)
        self._delay = delay

    async def aiter_bytes(self):
        for chunk in self._chunks:
            if self._delay > 0:
                await asyncio.sleep(self._delay)
            yield chunk


class TestSchedulerFirstPayload(unittest.TestCase):
    def setUp(self):
        reset_runtime_state()
        _stall_strikes.clear()

    def test_sse_event_verdict_preamble_and_done(self):
        # Empty string
        v, err = _sse_event_verdict("")
        self.assertEqual(v, "preamble")
        self.assertIsNone(err)

        # [DONE]
        v, err = _sse_event_verdict("[DONE]")
        self.assertEqual(v, "done")
        self.assertIsNone(err)

        # Invalid JSON
        v, err = _sse_event_verdict("not a json")
        self.assertEqual(v, "unknown")

        # Role-only OpenAI chunk
        role_only = json.dumps({"choices": [{"index": 0, "delta": {"role": "assistant"}}]})
        v, err = _sse_event_verdict(role_only)
        self.assertEqual(v, "preamble")

        # Anthropic message_start
        ant_start = json.dumps({"type": "message_start", "message": {"id": "msg_1"}})
        v, err = _sse_event_verdict(ant_start)
        self.assertEqual(v, "preamble")

        # Anthropic message_stop
        ant_stop = json.dumps({"type": "message_stop"})
        v, err = _sse_event_verdict(ant_stop)
        self.assertEqual(v, "done")

    def test_sse_event_verdict_payload(self):
        # OpenAI content delta
        content_chunk = json.dumps({"choices": [{"delta": {"content": "Hello world"}}]})
        v, err = _sse_event_verdict(content_chunk)
        self.assertEqual(v, "payload")

        # OpenAI reasoning delta
        reasoning_chunk = json.dumps({"choices": [{"delta": {"reasoning_content": "Thinking..."}}]})
        v, err = _sse_event_verdict(reasoning_chunk)
        self.assertEqual(v, "payload")

        # OpenAI tool calls
        tool_chunk = json.dumps({"choices": [{"delta": {"tool_calls": [{"id": "call_1"}]}}]})
        v, err = _sse_event_verdict(tool_chunk)
        self.assertEqual(v, "payload")

        # Anthropic content_block_delta text
        ant_delta = json.dumps({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hi"}})
        v, err = _sse_event_verdict(ant_delta)
        self.assertEqual(v, "payload")

        # Anthropic content_block_start tool_use
        ant_tool = json.dumps({"type": "content_block_start", "content_block": {"type": "tool_use", "id": "t1"}})
        v, err = _sse_event_verdict(ant_tool)
        self.assertEqual(v, "payload")

    def test_sse_event_verdict_inband_error(self):
        # OpenAI style in-band error
        err_chunk = json.dumps({"error": {"message": "Rate limit reached", "type": "rate_limit_error", "code": 429}})
        v, err = _sse_event_verdict(err_chunk)
        self.assertEqual(v, "error")
        self.assertIsNotNone(err)
        self.assertEqual(err["error"]["code"], 429)

        # Anthropic style in-band error
        ant_err = json.dumps({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})
        v, err = _sse_event_verdict(ant_err)
        self.assertEqual(v, "error")
        self.assertEqual(ant_err_status := _inband_status(err), 503)

    def test_inband_status_mapping(self):
        self.assertEqual(_inband_status({"error": {"type": "rate_limit_error"}}), 429)
        self.assertEqual(_inband_status({"error": {"type": "overloaded_error"}}), 503)
        self.assertEqual(_inband_status({"error": {"type": "authentication_error"}}), 401)
        self.assertEqual(_inband_status({"error": {"code": 403}}), 403)
        self.assertEqual(_inband_status({"error": {"message": "unknown"}}), 502)

    def test_nonstream_inband_error(self):
        err_bytes = json.dumps({"error": {"message": "Quota exceeded", "code": 429}}).encode("utf-8")
        parsed = _nonstream_inband_error(err_bytes)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["error"]["code"], 429)

        valid_bytes = json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode("utf-8")
        self.assertIsNone(_nonstream_inband_error(valid_bytes))

    def test_stall_bench_seconds_ladder(self):
        cand = "provider_a#key1"
        self.assertEqual(_stall_bench_seconds(cand), 30.0)
        self.assertEqual(_stall_bench_seconds(cand), 120.0)
        self.assertEqual(_stall_bench_seconds(cand), 600.0)
        self.assertEqual(_stall_bench_seconds(cand), 600.0)

        # Resetting upon success
        _stall_strikes.pop(cand, None)
        self.assertEqual(_stall_bench_seconds(cand), 30.0)

    def test_async_peek_payload_and_inband_failover(self):
        async def run_async_tests():
            # Scenario 1: Preamble followed by payload
            chunks = [
                b": keep-alive\n\n",
                b'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
                b'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
                b"data: [DONE]\n\n"
            ]
            resp = FakeResponse(chunks)
            deadline = time.monotonic() + 5.0
            buf, remainder, verdict, info = await _peek_until_payload(resp, deadline)
            self.assertEqual(verdict, "payload")
            self.assertIn(b"Hi", buf)
            self.assertIsNotNone(remainder)

            # Scenario 2: In-band 200 error frame
            err_chunks = [
                b": keep-alive\n\n",
                b'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
                b'data: {"error":{"message":"Rate limit exceeded","type":"rate_limit_error","code":429}}\n\n',
            ]
            resp_err = FakeResponse(err_chunks)
            deadline = time.monotonic() + 5.0
            buf_err, rem_err, verdict_err, info_err = await _peek_until_payload(resp_err, deadline)
            self.assertEqual(verdict_err, "error")
            self.assertIsNone(rem_err)
            self.assertEqual(_inband_status(info_err), 429)

            # Scenario 3: Empty completion (preamble followed by [DONE] without any payload)
            empty_chunks = [
                b'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
                b"data: [DONE]\n\n"
            ]
            resp_empty = FakeResponse(empty_chunks)
            deadline = time.monotonic() + 5.0
            buf_emp, rem_emp, verdict_emp, _ = await _peek_until_payload(resp_empty, deadline)
            self.assertEqual(verdict_emp, "empty")
            self.assertIsNone(rem_emp)

        asyncio.run(run_async_tests())


if __name__ == "__main__":
    unittest.main()
