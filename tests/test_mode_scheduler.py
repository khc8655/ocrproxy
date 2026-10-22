"""tests/test_mode_scheduler.py — 按时段自动切换运行模式 (vm-app/app/mode_scheduler.py).

覆盖：
  1. 时段计算（跨零点 / 同一天 / 边界）
  2. 关闭时不动作
  3. 进入 KB 时段切到 kb，只切一次；state 文件记录 slot；不整包覆盖其它配置
  4. 时段内手动切换（包括调度器 deferred 窗口）会保留到下一个边界
  5. KB → Agent：等空闲，最多顺延 1 小时后强制切换；Agent → KB 最多顺延 15 分钟
  6. 原子写入：调度器不会用旧快照覆盖并发发生的管理端修改，_version 单调
  7. 已在目标模式时只标记 state，不写配置 / 不 bump 版本 / 不产生备份
  8. 管理端保存的 CAS：读到写之间被其它写者更新时抛 ConfigVersionConflict
  9. ActivityTracker 中间件对流式响应在最后一个字节后才计为结束
"""
import asyncio
import glob
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
    w2 = ((1, 0), (5, 30))
    assert current_slot(_dt("2026-10-23 03:00"), *w2)[:2] == ("kb", "kb@2026-10-23T01:00")
    assert current_slot(_dt("2026-10-23 00:30"), *w2)[:2] == ("agent", "agent@2026-10-22T05:30")
    assert current_slot(_dt("2026-10-23 06:00"), *w2)[:2] == ("agent", "agent@2026-10-23T05:30")


async def _cfg():
    from app.config_store import get_config, clear_cache
    clear_cache()
    return await get_config()


async def _save(cfg):
    # test setup writes bypass CAS (the CAS path is covered by test_cas_conflict)
    from app.config_store import save_config
    await save_config(cfg)


def _set_activity(inflight, last_done):
    from app import mode_scheduler as ms
    ms._inflight = inflight
    ms._last_done = last_done


def _backups():
    return glob.glob(os.path.join(os.environ["CONFIG_DIR"], "proxy_config.enc.bak-*"))


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
    ms._save_state("")  # reset marker
    _set_activity(0, 0)

    # 2. disabled -> no-op
    assert await ms.tick(_dt("2026-10-22 22:01")) is None
    assert (await _cfg())["run_mode"] == "agent"

    await _save({**(await _cfg()), "mode_schedule_enabled": True,
                 "mode_schedule_kb_start": "22:00", "mode_schedule_kb_end": "08:00"})

    # 3. enter KB window -> switch once, slot in the state file, other config untouched
    assert await ms.tick(_dt("2026-10-22 22:01")) == "switched"
    c = await _cfg()
    assert c["run_mode"] == "kb" and ms.state_slot() == "kb@2026-10-22T22:00"
    assert os.environ.get("RUN_MODE") == "kb"
    assert c["agent_models"] == base["agent_models"] and c["candidates"] == base["candidates"]
    assert c["kb_max_concurrency_per_key"] == 10 and c["agent_first_byte_timeout_sec"] == 90
    v = c["_version"]
    assert await ms.tick(_dt("2026-10-22 22:05")) == "handled"
    assert (await _cfg())["_version"] == v, "handled tick must not write config"

    # 4a. manual switch inside the window is kept (state marks the slot)
    await _save({**(await _cfg()), "run_mode": "agent", "_version": (await _cfg())["_version"] + 1})
    await ms.note_manual_switch(_dt("2026-10-22 22:06"))
    assert await ms.tick(_dt("2026-10-22 23:30")) == "handled"
    assert (await _cfg())["run_mode"] == "agent"
    await _save({**(await _cfg()), "run_mode": "kb", "_version": (await _cfg())["_version"] + 1})

    # 4b. manual switch during the deferred entry window is kept too
    await _save({**(await _cfg()), "run_mode": "kb", "_version": (await _cfg())["_version"] + 1})
    ms._save_state("kb@2026-10-22T22:00")
    now = time.time()
    _set_activity(2, now)
    assert await ms.tick(_dt("2026-10-23 08:00")) == "deferred"  # KB -> Agent entry, busy
    await _save({**(await _cfg()), "run_mode": "agent", "_version": (await _cfg())["_version"] + 1})
    await ms.note_manual_switch(_dt("2026-10-23 08:01"))
    _set_activity(0, 0)
    assert await ms.tick(_dt("2026-10-23 08:02")) == "handled"
    assert (await _cfg())["run_mode"] == "agent"

    # 5a. KB -> Agent: no upper bound before, now forced after KB_TO_AGENT_MAX_DEFER_SEC
    await _save({**(await _cfg()), "run_mode": "kb", "_version": (await _cfg())["_version"] + 1})
    ms._save_state("kb@2026-10-22T22:00")
    _set_activity(0, time.time())  # just finished -> not idle
    assert await ms.tick(_dt("2026-10-23 08:30")) == "deferred"
    assert await ms.tick(_dt("2026-10-23 09:01")) == "switched"  # forced after 1h
    assert (await _cfg())["run_mode"] == "agent"

    # 5b. Agent -> KB: busy defers, forced after 15 minutes
    await _save({**(await _cfg()), "run_mode": "agent", "_version": (await _cfg())["_version"] + 1})
    ms._save_state("agent@2026-10-23T08:00")
    _set_activity(1, time.time())
    assert await ms.tick(_dt("2026-10-23 22:05")) == "deferred"
    assert await ms.tick(_dt("2026-10-23 22:15")) == "switched"
    assert (await _cfg())["run_mode"] == "kb"

    # 6. atomic update: a concurrent admin change must survive the scheduler write
    await _save({**(await _cfg()), "run_mode": "agent", "_version": (await _cfg())["_version"] + 1})
    ms._save_state("agent@2026-10-23T08:00")
    _set_activity(0, 0)
    c = await _cfg()
    await _save({**c, "proxy_api_key": "ADMIN-NEW", "_version": c["_version"] + 1})
    await ms._apply("kb", "kb@2026-10-23T22:00")
    c = await _cfg()
    assert c["proxy_api_key"] == "ADMIN-NEW", "scheduler stale write must not lose admin changes"
    assert c["run_mode"] == "kb"

    # 7. already in the desired mode: only mark the state, no config write / backup
    await _save({**(await _cfg()), "run_mode": "kb", "mode_schedule_enabled": True})
    v = (await _cfg())["_version"]
    _set_activity(0, 0)
    ms._save_state("kb@2026-10-22T22:00")
    nb = len(_backups())
    assert await ms.tick(_dt("2026-10-23 22:00")) == "already"  # kb slot was marked by the earlier switch
    assert (await _cfg())["_version"] == v and len(_backups()) == nb


async def test_apply_skips_when_mode_changed():
    from app import mode_scheduler as ms
    from app.config_store import get_config
    c = await _cfg()
    c = {**c, "run_mode": "kb", "_version": c["_version"] + 1}
    await _save(c)
    v = (await get_config())["_version"]
    assert await ms._apply("agent", "agent@2026-10-23T08:00", expected_mode="agent") == "skipped"
    c = await get_config()
    assert c["run_mode"] == "kb" and c["_version"] == v, "manual mode must win over a stale scheduled switch"


async def test_state_and_manual_switch_via_admin():
    import httpx
    from app.main import app
    from app import mode_scheduler as ms
    from app.config_store import get_config

    c = await _cfg()
    assert c.get("mode_schedule_enabled") is True
    # point the KB window at "now" so the admin-save manual switch marks the real slot
    now = datetime.now(ms.TZ)
    start = (now - __import__("datetime").timedelta(hours=1)).strftime("%H:%M")
    end = (now + __import__("datetime").timedelta(hours=1)).strftime("%H:%M")
    c = {**c, "mode_schedule_kb_start": start, "mode_schedule_kb_end": end}
    await _save(c)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        r = await client.get("/api/admin/config", headers=ADMIN)
        body = r.json()
        body["run_mode"] = "kb" if body.get("run_mode") != "kb" else "agent"
        r = await client.post("/api/admin/config", headers=ADMIN, json=body)
        assert r.status_code == 200, r.text
    expected_slot = ms.current_slot(datetime.now(ms.TZ), ms.parse_hhmm(start, "22:00"), ms.parse_hhmm(end, "08:00"))[1]
    assert ms.state_slot() == expected_slot, (ms.state_slot(), expected_slot)
    assert (await get_config())["run_mode"] in ("kb", "agent")


def test_leader_lock():
    """Only one process may run the scheduler loop."""
    import subprocess
    from app import mode_scheduler as ms
    assert ms._acquire_leader_lock() is True
    vm_app = os.path.join(REPO_ROOT, "vm-app")
    code = (
        "import sys; sys.path.insert(0, %r); "
        "from app.mode_scheduler import _acquire_leader_lock; "
        "print(_acquire_leader_lock())" % vm_app
    )
    out = subprocess.run([sys.executable, "-c", code], env=os.environ, capture_output=True, text=True)
    assert out.stdout.strip() == "False", (out.stdout, out.stderr)
    ms._release_leader_lock()
    assert ms._acquire_leader_lock() is True
    ms._release_leader_lock()


async def test_cas_conflict():
    from app.config_store import get_config, replace_config, ConfigVersionConflict
    c = await _cfg()
    await replace_config({**c, "_version": c["_version"] + 1}, expected_version=c["_version"])
    stale = c["_version"]
    try:
        await replace_config({**c, "_version": stale + 1}, expected_version=stale)
    except ConfigVersionConflict as e:
        assert e.expected == stale
    else:
        raise AssertionError("stale CAS write must raise ConfigVersionConflict")


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
    await mw({"type": "http", "method": "POST", "path": "/v1/chat/completions"}, None, send)
    assert seen == [1, 1] and ms._inflight == 0 and ms._last_done > 0
    _set_activity(0, 0)
    await mw({"type": "http", "path": "/api/admin/stats"}, None, send)
    assert ms._last_done == 0, "admin traffic must not count as activity"
    await mw({"type": "http", "method": "GET", "path": "/v1/models"}, None, send)
    assert ms._last_done == 0, "GET /v1/models probes must not block a scheduled switch"


async def test_preset_update_keeps_concurrent_switch():
    """presets/update-rules 拉规则期间发生的 run_mode 切换不能被旧快照写回。"""
    import httpx
    from app.main import app
    from app import admin_routes
    from app.config_store import update_config
    await _save({**(await _cfg()), "run_mode": "agent",
                 "providers": {"p1": {"base_url": "http://127.0.0.1:1/v1", "keys": {"k": "sk"}, "preset_id": "p1"}}})
    before = (await _cfg())["_version"]
    orig = admin_routes._fetch_remote_json

    async def slow_fetch(urls, timeout=2.5):
        def flip(cfg):
            cfg["run_mode"] = "kb"
            cfg["_version"] = int(cfg.get("_version", 1)) + 1
            return cfg
        await update_config(flip)  # the scheduler switches while rules are downloading
        return {"version": "9.9.9", "adapter_rules": {"x": 1}}

    admin_routes._fetch_remote_json = slow_fetch
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            r = await client.post("/api/admin/presets/update-rules", headers=ADMIN, json={"provider_ids": ["p1"]})
            assert r.status_code == 200, r.text
    finally:
        admin_routes._fetch_remote_json = orig
    c = await _cfg()
    assert c["run_mode"] == "kb", "rule update must not revert a concurrent mode switch"
    assert c["providers"]["p1"]["preset_version"] == "9.9.9" and c["providers"]["p1"]["adapter_rules"] == {"x": 1}
    assert c["_version"] == before + 2


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
            await test_apply_skips_when_mode_changed(); print("  PASS apply skip guard")
            await test_state_and_manual_switch_via_admin(); print("  PASS manual switch via admin")
            await test_cas_conflict(); print("  PASS CAS conflict")
            test_leader_lock(); print("  PASS leader lock")
            await test_activity_middleware(); print("  PASS activity middleware")
            await test_preset_update_keeps_concurrent_switch(); print("  PASS preset update keeps switch")
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
