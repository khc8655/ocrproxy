"""tests/test_agent_metrics.py — Layer 1: Agent dashboard summary (vm-app/app/agent_metrics.py).

Pure logic, no network: usage parsing for both APIs (stream + non-stream, split
frames, Anthropic cache tokens), TTFT skips SSE keep-alive comments, error frame
inside a 200 stream counts as failure, unscheduled requests are not recorded,
day rollover, persistence across a "restart", and clear().
"""
import json
import os
import shutil
import sys
import tempfile
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "vm-app"))


def main():
    tmp = tempfile.mkdtemp(prefix="agent_metrics_")
    old = os.environ.get("CONFIG_DIR")
    os.environ["CONFIG_DIR"] = tmp
    try:
        from app import agent_metrics as am
        am.reset()
        am.clear()

        # 1. OpenAI stream with include_usage, keep-alive first, usage frame split across chunks
        t = am.AgentRequestTracker(); t.note_schedule("claude")
        t.on_chunk(b": keep-alive\n\n")
        assert t.ttft_ms is None, "keep-alive must not count as first token"
        time.sleep(0.01)
        t.on_chunk(b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
        assert t.ttft_ms and t.ttft_ms >= 10
        t.on_chunk(b'data: {"choices":[],"us')
        t.on_chunk(b'age":{"prompt_tokens":120,"completion_tokens":30}}\n\ndata: [DONE]\n\n')
        t.note_success(1)
        t.finish(True)

        # 2. Anthropic stream: message_start (input + cache) then message_delta (output, cumulative)
        t = am.AgentRequestTracker(); t.note_schedule("claude")
        t.on_chunk(b'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,'
                   b'"cache_read_input_tokens":90,"cache_creation_input_tokens":5,"output_tokens":1}}}\n\n')
        t.on_chunk(b'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n')
        t.note_success(0)
        t.finish(True)

        # 3. OpenAI stream without usage (client did not ask) -> success, no usage
        t = am.AgentRequestTracker(); t.note_schedule("gpt")
        t.on_chunk(b'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n')
        t.finish(True)

        # 4. error frame inside a 200 stream -> failure
        t = am.AgentRequestTracker(); t.note_schedule("gpt")
        t.on_chunk(b'data: {"error":{"message":"upstream broke","code":"502"}}\n\ndata: [DONE]\n\n')
        t.finish(True)

        # 5. non-stream JSON (Anthropic shape) + HTTP error
        t = am.AgentRequestTracker(); t.note_schedule("claude")
        t.on_body(json.dumps({"usage": {"input_tokens": 7, "output_tokens": 3}}).encode())
        t.finish(True)
        t = am.AgentRequestTracker(); t.note_schedule("claude")
        t.finish(False)

        # 5b. normal content that merely mentions "event: error" must NOT count as a failure
        t = am.AgentRequestTracker(); t.note_schedule("gpt")
        t.on_chunk(b'data: {"choices":[{"delta":{"content":"the token event: error is documented"}}]}\n\ndata: [DONE]\n\n')
        t.finish(True)

        # 5c. Anthropic error event (event: error + JSON type=error) -> failure
        t = am.AgentRequestTracker(); t.note_schedule("claude")
        t.on_chunk(b'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n')
        t.finish(True)

        # 5d. OpenAI-style error frame with irregular spacing / type=error -> failure
        t = am.AgentRequestTracker(); t.note_schedule("gpt")
        t.on_chunk(b'data:  {"type":"error","message":"boom"}\n\ndata: [DONE]\n\n')
        t.finish(True)

        # 5e. keep-alive comment and the first real event in the same chunk -> that is the TTFT
        t = am.AgentRequestTracker(); t.note_schedule("claude")
        time.sleep(0.01)
        t.on_chunk(b': keep-alive\n\ndata: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
        assert t.ttft_ms is not None and t.ttft_ms >= 10, f"comment+data chunk must start the TTFT clock: {t.ttft_ms}"
        t.finish(True)

        # 6. never reached routing (auth / validation / KB) -> not recorded
        t = am.AgentRequestTracker()
        t.on_body(b'{"usage":{"prompt_tokens":999}}')
        t.finish(True)

        s = am.snapshot()
        assert s["window"] == "today" and s["timezone"] == "Asia/Shanghai", s
        assert s["requests"] == 10, s
        assert s["failures"] == 4, s
        assert s["failovers"] == 1, s
        assert s["tokens_in"] == 120 + 105 + 7, s
        assert s["tokens_out"] == 30 + 42 + 3, s
        assert s["usage_requests"] == 3, s
        assert s["ttft_ms_avg"] is not None and s["total_ms_avg"] is not None
        assert s["models"]["claude"]["requests"] == 6 and s["models"]["gpt"]["failures"] == 2, s["models"]

        # 7. persistence: flush, drop memory, reload from disk
        am.flush()
        assert os.path.exists(os.path.join(tmp, "agent_summary.json"))
        am.reset()
        assert am.snapshot()["requests"] == 10, "today's summary must survive a restart"

        # 8. a file from another day is ignored; rollover resets
        with open(os.path.join(tmp, "agent_summary.json"), "w", encoding="utf-8") as f:
            json.dump({"date": "2000-01-01", "requests": 99}, f)
        am.reset()
        assert am.snapshot()["requests"] == 0, "yesterday's numbers must not show today"

        # 9. clear()
        t = am.AgentRequestTracker(); t.note_schedule("m"); t.finish(True)
        assert am.snapshot()["requests"] == 1
        am.clear()
        assert am.snapshot()["requests"] == 0

        # 10. stats.get_stats() exposes it, stats.reset() clears it
        from app import stats
        t = am.AgentRequestTracker(); t.note_schedule("m"); t.finish(True)
        assert stats.get_stats()["agent"]["summary"]["requests"] == 1
        stats.reset()
        assert stats.get_stats()["agent"]["summary"]["requests"] == 0
        print("PASS: agent_metrics summary (usage parsing, TTFT, failures, persistence, reset)")
    finally:
        if old is None:
            os.environ.pop("CONFIG_DIR", None)
        else:
            os.environ["CONFIG_DIR"] = old
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
