"""tests/test_mode_scheduler.py — Layer 1/2: 按时段自动切换运行模式 (vm-app/app/mode_scheduler.py).

覆盖：
  1. 时段计算（跨零点 / 不跨零点 / 边界时刻）
  2. 关闭时不动作
  3. 进入 KB 时段切到 kb，只切一次；时段内手动切回 agent 会被保留
  4. KB → Agent：有进行中/刚结束的请求时顺延，空闲后才切（入库不被切断）
  5. Agent → KB：繁忙时最多顺延 15 分钟，然后强制切换
  6. 只改 run_mode：其它两种模式的配置原样保留，_version 递增
  7. 管理端保存 /api/admin/config 与导入不会覆盖本机的时段标记
  8. ActivityTracker 中间件对流式响应在最后一个字节后才计为结束
"""
import asyncio
import os
import shutil
import sys
import tempfile
import time
from datetime import datetime

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "vm-app"))

ADMIN = {"Authorization": "Bearer test_admin_pass_123"}


def _dt(s):
    from app.mode_scheduler import TZ
    return datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=TZ)


def test_slots():
    from app.mode_scheduler import current_slot
    w = ((22, 0), (8, 0))
    assert current_slot(_dt("2026-10-22 23:00"), *w)[:2] == ("kb", "kb@2026-10-22T22:00")
    assert current_slot(_dt("2026-10-23 07:59"), *w)[:2] == ("kb", "kb@2026-10-22T22:00")
    assert current_slot(_dt("2026-10-23 08:00"), *w)[:2] == ("agent", "agent@2026-10-23T08:00")
    assert current_slot(_dt("2026-10-23 21:59"), *w)[:2] == ("agent", "agent@2026-10-23T08:00")
    assert current_slot(_dt("2026-10-23 22:00"), *w)[:2] == ("kb", "kb@2026-10-23T22:00")
    w2 = ((1, 0), (5, 30))  # same-day window
    assert current_slot(_dt("2026-10-23 03:00"), *w2)[:2] == ("kb", "kb@2026-10-23T01:00")
    assert current_slot(_dt("2026-10-23 00:30"), *w2)[:2] == ("agent", "agent@2026-10-22T05:30")
    assert current_slot(_dt("2026-10-23 06:00"), *w2)[:2] == ("agent", "agent@2026-10-23T05:30")


async def _cfg():
    from app.config_store import get_config, clear_cache
    clear_cache()
    return await get_config()


async def _save(cfg):
    from app.config_store import save_config
    await save_config(cfg)


def _set_activity(inflight, last_done):
    from app import mode_scheduler as ms
    ms._inflight = inflight
    ms._last_done = last_done


async def test_scheduler_flow():
    from app import mode_scheduler as ms
    base = await _cfg()
    base = dict(base)
    base.update({
        "run_mode": "agent",
        "agent_models": {"claude": [{"provider": "p", "key": "k"}]},
        "candidates": {"chat": [{"provider": "p", "key": "k", "model": "m"}], "embedding": [], "reranker": [], "ocr": []},
        "kb_max_concurrency_per_key": 10,
        "agent_first_byte_timeout_sec": 90,
        "_version": 5,
    })
    await _save(base)
    _set_activity(0, 0)

    # 2. disabled -> no-op
    assert await ms.tick(_dt("2026-10-22 22:01")) is None
    assert (await _cfg())["run_mode"] == "agent"

    await _save({**(await _cfg()), "mode_schedule_enabled": True,
                 "mode_schedule_kb_start": "22:00", "mode_schedule_kb_end": "08:00"})

    # 3. enter KB window -> switch once
    assert await ms.tick(_dt("2026-10-22 22:01")) == "switched"
    c = await _cfg()
    assert c["run_mode"] == "kb" and c[ms.SLOT_KEY] == "kb@2026-10-22T22:00"
    assert os.environ.get("RUN_MODE") == "kb"
    # 6. only run_mode changed
    assert c["agent_models"] == base["agent_models"] and c["candidates"] == base["candidates"]
    assert c["kb_max_concurrency_per_key"] == 10 and c["agent_first_byte_timeout_sec"] == 90
    assert c["_version"] == 6
    assert await ms.tick(_dt("2026-10-22 22:05")) == "handled"

    # manual switch back to agent inside the window is kept
    await _save({**c, "run_mode": "agent"})
    assert await ms.tick(_dt("2026-10-22 23:30")) == "handled"
    assert (await _cfg())["run_mode"] == "agent"
    await _save({**(await _cfg()), "run_mode": "kb"})

    # 4. KB -> Agent waits while ingestion is running / just finished
    now = time.time()
    _set_activity(2, now)
    assert await ms.tick(_dt("2026-10-23 08:00")) == "deferred"
    _set_activity(0, now - 60)
    assert await ms.tick(_dt("2026-10-23 09:30")) == "deferred"  # no upper bound for KB
    assert (await _cfg())["run_mode"] == "kb"
    _set_activity(0, now - ms.IDLE_SEC - 1)
    assert await ms.tick(_dt("2026-10-23 09:31")) == "switched"
    c = await _cfg()
    assert c["run_mode"] == "agent" and c[ms.SLOT_KEY] == "agent@2026-10-23T08:00"

    # 5. Agent -> KB: busy defers, but at most 15 minutes
    _set_activity(1, time.time())
    assert await ms.tick(_dt("2026-10-23 22:05")) == "deferred"
    assert await ms.tick(_dt("2026-10-23 22:15")) == "switched"
    assert (await _cfg())["run_mode"] == "kb"
    _set_activity(0, 0)

    # already in desired mode at a new boundary -> just mark
    await _save({**(await _cfg()), "run_mode": "agent"})
    assert await ms.tick(_dt("2026-10-24 08:00")) == "already"
    assert (await _cfg())[ms.SLOT_KEY] == "agent@2026-10-24T08:00"


async def test_admin_save_keeps_slot():
    import httpx
    from app.main import app
    from app import mode_scheduler as ms
    c = await _cfg()
    marker = c[ms.SLOT_KEY]
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        r = await client.get("/api/admin/config", headers=ADMIN)
        assert r.status_code == 200
        body = r.json()
        body[ms.SLOT_KEY] = "kb@1999-01-01T00:00"  # stale / forged marker from a tab
        body["run_mode"] = "kb"
        r = await client.post("/api/admin/config", headers=ADMIN, json=body)
        assert r.status_code == 200, r.text
    c = await _cfg()
    assert c[ms.SLOT_KEY] == marker and c["run_mode"] == "kb"


async def test_activity_middleware():
    from app.mode_scheduler import ActivityTrackerASGIMiddleware
    from app import mode_scheduler as ms
    _set_activity(0, 0)
    seen = []

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        seen.append(ms._inflight)
        await send({"type": "http.response.body", "body": b"a", "more_body": True})
        await asyncio.sleep(0.01)
        seen.append(ms._inflight)
        await send({"type": "http.response.body", "body": b"b"})

    async def send(msg):
        pass

    mw = ActivityTrackerASGIMiddleware(app)
    await mw({"type": "http", "path": "/v1/chat/completions"}, None, send)
    assert seen == [1, 1] and ms._inflight == 0 and ms._last_done > 0
    _set_activity(0, 0)
    await mw({"type": "http", "path": "/api/admin/stats"}, None, send)
    assert ms._last_done == 0, "admin traffic must not count as activity"


def main():
    from cryptography.fernet import Fernet
    tmp = tempfile.mkdtemp(prefix="mode_sched_")
    saved = {k: os.environ.get(k) for k in ("ENCRYPT_KEY", "CONFIG_DIR", "ADMIN_PASSWORD", "PROXY_API_KEY", "RUN_MODE")}
    os.environ.update({"ENCRYPT_KEY": Fernet.generate_key().decode(), "CONFIG_DIR": tmp,
                       "ADMIN_PASSWORD": "test_admin_pass_123", "PROXY_API_KEY": "sk-test"})
    try:
        from app.config_store import save_to_disk, clear_cache
        save_to_disk({"providers": {}, "agent_models": {}, "candidates": {"chat": [], "embedding": [], "reranker": [], "ocr": []}})
        clear_cache()
        test_slots(); print("  PASS slots")

        async def run():
            await test_scheduler_flow(); print("  PASS scheduler flow")
            await test_admin_save_keeps_slot(); print("  PASS admin save keeps slot")
            await test_activity_middleware(); print("  PASS activity middleware")
        asyncio.run(run())
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(tmp, ignore_errors=True)
    print("ALL MODE SCHEDULER TESTS PASSED")


if __name__ == "__main__":
    main()
