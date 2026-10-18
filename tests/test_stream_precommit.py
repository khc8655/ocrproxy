#!/usr/bin/env python3
"""VM 流式预提交 keep-alive (_stream_with_precommit) 与连接池耗尽不罚 Key 的回归测试。

覆盖：
  1. 宽限期内调度成功  -> 走原响应 (保留 X-Routed-Via 等头)
  2. 宽限期内调度失败  -> 仍返回真实 HTTP 状态码的 JSON 错误
  3. 首包慢 (> 宽限期) -> 先 200 + ': keep-alive'，再接上游流；lease 被释放
  4. 首包慢且最终失败  -> 200 流内以 SSE error 事件结束 (OpenAI 带 [DONE] / Anthropic event: error)
  5. 客户端在调度中断开 -> 调度任务被取消 (不再占用 Key 信号量 / 上游连接)
  6. 调度刚完成但流从未被读取就断开 -> 上游响应与 lease 仍被释放
  7. httpx.PoolTimeout -> GlobalOverloadError(503)，不冷却、不记失败到 Key
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vm-app"))

from starlette.responses import StreamingResponse  # noqa: E402

import app.proxy_routes as pr  # noqa: E402
from app.scheduler import AllCandidatesFailedError, ScheduleResult  # noqa: E402

pr._STREAM_KEEPALIVE_SEC = 0.2
CFG = {"stream_precommit_grace_sec": 0.5}
PASS, FAIL = [], []


def check(cond, name, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond else f"  -> {detail}"))


class Lease:
    def __init__(self):
        self.released = False

    def release(self):
        self.released = True


def make_sr(chunks, closed):
    lease = Lease()

    async def gen():
        try:
            for c in chunks:
                yield c
        finally:
            closed.append(True)
            lease.release()
    sr = ScheduleResult(stream_resp=StreamingResponse(gen(), media_type="text/event-stream"),
                        routed_via="p/k", fallback_attempts=0, lease=lease)
    return sr, lease


def finalize(sr):
    sr.stream_resp.headers["X-Routed-Via"] = sr.routed_via
    return sr.stream_resp


async def drain(resp, limit=None):
    out = []
    agen = resp.body_iterator
    async for c in agen:
        out.append(c if isinstance(c, bytes) else c.encode())
        if limit and len(out) >= limit:
            await agen.aclose()
            break
    return b"".join(out)


async def main():
    # 1. fast success
    closed = []
    sr, lease = make_sr([b"data: {\"x\":1}\n\n", b"data: [DONE]\n\n"], closed)

    async def fast_ok():
        return sr
    resp = await pr._stream_with_precommit(fast_ok(), finalize, CFG)
    check(resp.headers.get("X-Routed-Via") == "p/k" and "X-Proxy-Precommitted" not in resp.headers,
          "宽限期内成功：直接返回原流响应并保留路由头")
    body = await drain(resp)
    check(b"[DONE]" in body and lease.released, "宽限期内成功：流完整且 lease 释放")

    # 2. fast failure keeps real status
    async def fast_fail():
        raise AllCandidatesFailedError("x", last_status_code=429, last_response_body='{"error":{"message":"rate limited"}}')
    resp = await pr._stream_with_precommit(fast_fail(), finalize, CFG)
    check(resp.status_code == 429, "宽限期内失败：保留真实 HTTP 状态码 (429)", resp.status_code)

    # 3. slow success -> committed + keep-alive + stream
    closed = []
    sr, lease = make_sr([b"data: {\"x\":2}\n\n", b"data: [DONE]\n\n"], closed)

    async def slow_ok():
        await asyncio.sleep(1.0)
        return sr
    resp = await pr._stream_with_precommit(slow_ok(), finalize, CFG)
    check(resp.status_code == 200 and resp.headers.get("X-Proxy-Precommitted") == "1", "首包慢：预提交 200")
    body = await drain(resp)
    check(b": keep-alive" in body and b"{\"x\":2}" in body and b"[DONE]" in body, "首包慢：先心跳后接上游流", body[:120])
    check(lease.released and closed, "首包慢：流结束后 lease/上游释放")

    # 4. slow failure -> SSE error (openai + anthropic)
    for fmt, marker in (("openai", b"[DONE]"), ("anthropic", b"event: error")):
        async def slow_fail():
            await asyncio.sleep(0.8)
            raise AllCandidatesFailedError("all failed", last_status_code=503, last_response_body=None)
        resp = await pr._stream_with_precommit(slow_fail(), finalize, CFG, error_format=fmt)
        body = await drain(resp)
        check(resp.status_code == 200 and marker in body and (b"error" in body),
              f"首包慢且失败：以 SSE 错误事件结束 ({fmt})", body[-200:])

    # 5. client disconnect while scheduling -> task cancelled
    cancelled = asyncio.Event()

    async def never():
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled.set()
            raise
    resp = await pr._stream_with_precommit(never(), finalize, CFG)
    agen = resp.body_iterator
    first = await agen.__anext__()          # one keep-alive
    await agen.aclose()                      # client went away
    await asyncio.sleep(0.05)
    check(first.startswith(b": keep-alive") and cancelled.is_set(), "客户端断开：调度任务被取消")

    # 6. scheduling finished but stream never iterated -> released anyway
    closed = []
    sr, lease = make_sr([b"data: {\"x\":3}\n\n"], closed)
    gate = asyncio.Event()

    async def done_after_gate():
        await gate.wait()
        return sr
    resp = await pr._stream_with_precommit(done_after_gate(), finalize, CFG)
    agen = resp.body_iterator
    await agen.__anext__()                   # keep-alive while waiting
    gate.set()
    await asyncio.sleep(0.05)                # task completes, stream not yet read
    await agen.aclose()                      # client disconnects right now
    check(lease.released and closed, "调度完成但未读流即断开：lease 与上游仍释放")

    # 7. PoolTimeout -> GlobalOverloadError without penalising the key
    import httpx
    from app import scheduler as sched

    class FakeClient:
        def build_request(self, *a, **k):
            return httpx.Request("POST", "https://up.example/v1/chat/completions")

        async def send(self, *a, **k):
            raise httpx.PoolTimeout("pool full")

        async def request(self, *a, **k):
            raise httpx.PoolTimeout("pool full")

    async def fake_get_client():
        return FakeClient()
    orig = sched.get_client
    sched.get_client = fake_get_client
    try:
        cfg = {"run_mode": "agent", "candidates": {"chat": [{"provider": "pp", "key": "kk", "model": "m"}]},
               "providers": {"pp": {"base_url": "https://up.example", "keys": {"kk": "sk"}}}}
        try:
            await sched.schedule(cfg, "chat", lambda c, k, u: ("POST", u, {}, {"model": "m"}), category="agent")
            check(False, "PoolTimeout -> GlobalOverloadError", "no exception")
        except sched.GlobalOverloadError as e:
            cid = "pp:kk:m"
            check(sched._cooldown_until.get(cid, 0) == 0 and sched._consecutive_failures.get(cid, 0) == 0,
                  "PoolTimeout：转为 503 过载且不冷却/不记 Key 失败", str(e))
        except Exception as e:
            check(False, "PoolTimeout -> GlobalOverloadError", f"{type(e).__name__}: {e}")
    finally:
        sched.get_client = orig


asyncio.run(main())
print(f"\nPASS {len(PASS)}  FAIL {len(FAIL)}")
sys.exit(1 if FAIL else 0)
