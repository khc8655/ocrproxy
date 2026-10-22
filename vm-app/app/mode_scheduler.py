"""
mode_scheduler.py — 按时段自动切换 VM 运行模式（KB 夜间入库 / 白天 Agent）。

配置（settings.schema.json，仅 VM）：
    mode_schedule_enabled   bool   默认 False
    mode_schedule_kb_start  "HH:MM" 默认 "22:00"（Asia/Shanghai）
    mode_schedule_kb_end    "HH:MM" 默认 "08:00"
在 [kb_start, kb_end) 时段内应为 kb，其余时段应为 agent，支持跨零点。

稳定性规则：
1. 只在「时段边界」动作（边沿触发）：每个时段只切一次。已处理的 slot 记录在
   config 目录下独立的 mode_schedule_state.json（不写进配置，避免每次边界无意义
   bump _version / 生成备份 / 让管理端误收 409）。
2. 切换前等待当前模式空闲：/v1 没有进行中的请求，且最近 IDLE_SEC 内没有请求结束。
   - KB → Agent：默认最多顺延 1 小时（KB_TO_AGENT_MAX_DEFER_SEC），避免持续探活/
     零散流量把白天 Agent 永久占住；到点强制切换。
   - Agent → KB：最多顺延 15 分钟（AGENT_TO_KB_MAX_DEFER_SEC），保证夜间入库。
3. 切换通过 config_store.update_config() 做原子 read-modify-write（锁内重新读取最新
   配置），只改 run_mode / _version 两个字段；不会用旧快照覆盖并发发生的改 Key/
   改设置等写入。滚动备份与 .env RUN_MODE 同步沿用管理端保存路径。
4. 手动切换会通过 note_manual_switch() 标记当前时段，直到下一个时段边界都不再自动
   改回去（包括调度器正在 deferred 的窗口）。
5. 多 worker 场景用文件锁选主，只有抢到锁的进程运行调度循环；其余进程跳过。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

logger = logging.getLogger("ocrproxy")

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Asia/Shanghai")
except Exception:  # pragma: no cover - minimal images without tzdata
    TZ = timezone(timedelta(hours=8))

TICK_SEC = 30.0
IDLE_SEC = 300.0
AGENT_TO_KB_MAX_DEFER_SEC = 900.0       # 夜间入库最多等 15 分钟
KB_TO_AGENT_MAX_DEFER_SEC = 3600.0      # 白天 Agent 最多等 1 小时
STATE_FILE_NAME = "mode_schedule_state.json"
LOCK_FILE_NAME = ".mode_scheduler.lock"

_leader_fd: Optional[int] = None


# ---------------------------------------------------------------------------
# /v1 activity tracking (single uvicorn process, so module globals are enough)
# ---------------------------------------------------------------------------
_inflight = 0
_last_done = 0.0


class ActivityTrackerASGIMiddleware:
    """Counts in-flight /v1 requests; for streams the count drops after the last byte."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/v1"):
            return await self.app(scope, receive, send)
        global _inflight, _last_done
        _inflight += 1
        try:
            await self.app(scope, receive, send)
        finally:
            _inflight -= 1
            _last_done = time.time()


def activity() -> Tuple[int, float]:
    return _inflight, _last_done


def is_idle(now: Optional[float] = None, idle_sec: float = IDLE_SEC) -> bool:
    now = time.time() if now is None else now
    return _inflight <= 0 and (now - _last_done) >= idle_sec


# ---------------------------------------------------------------------------
# Persisted slot marker + single-leader lock (outside the main config)
# ---------------------------------------------------------------------------
def _config_dir() -> str:
    return os.environ.get("CONFIG_DIR") or "/opt/ocrproxy/config"


def _state_path() -> str:
    return os.path.join(_config_dir(), STATE_FILE_NAME)


def load_state() -> dict:
    try:
        with open(_state_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as e:  # corrupt state must never break the scheduler
        logger.warning("mode scheduler state unreadable: %s", e)
        return {}


def _save_state(slot_id: str) -> None:
    path = _state_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"slot": slot_id, "updated_at": time.time()}, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except Exception as e:
        logger.warning("mode scheduler could not persist slot %s: %s", slot_id, e)


def state_slot() -> Optional[str]:
    slot = load_state().get("slot")
    return slot if isinstance(slot, str) else None


def _acquire_leader_lock() -> bool:
    """Only one uvicorn worker may run the scheduler loop."""
    global _leader_fd
    if _leader_fd is not None:
        return True
    path = os.path.join(_config_dir(), LOCK_FILE_NAME)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    except Exception as e:
        logger.warning("mode scheduler lock open failed: %s", e)
        return False
    try:
        import fcntl  # Linux/macOS
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except ImportError:  # pragma: no cover - non-POSIX fallback: single process assumed
        pass
    except OSError:
        os.close(fd)
        return False
    _leader_fd = fd
    try:
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode())
    except Exception:
        pass
    return True


def _release_leader_lock() -> None:
    global _leader_fd
    if _leader_fd is None:
        return
    try:
        os.close(_leader_fd)
    except Exception:
        pass
    _leader_fd = None


# ---------------------------------------------------------------------------
# Pure schedule logic
# ---------------------------------------------------------------------------
def parse_hhmm(value, default: str) -> Tuple[int, int]:
    for raw in (value, default):
        try:
            h, m = str(raw).strip().split(":")
            h, m = int(h), int(m)
            if 0 <= h < 24 and 0 <= m < 60:
                return h, m
        except Exception:
            continue
    return 0, 0


def schedule_of(config: dict) -> Optional[Tuple[Tuple[int, int], Tuple[int, int]]]:
    from .settings_schema import get_setting
    if not bool(get_setting(config, "mode_schedule_enabled", False)):
        return None
    start = parse_hhmm(get_setting(config, "mode_schedule_kb_start", "22:00"), "22:00")
    end = parse_hhmm(get_setting(config, "mode_schedule_kb_end", "08:00"), "08:00")
    if start == end:
        return None
    return start, end


def current_slot(now: datetime, start: Tuple[int, int], end: Tuple[int, int]) -> Tuple[str, str, datetime]:
    """Return (desired_mode, slot_id, slot_began_at) for local time `now`.

    slot_id identifies one occurrence of a window, e.g. "kb@2026-10-22T22:00".
    """
    now = now.astimezone(TZ)

    def at(day: datetime, hm: Tuple[int, int]) -> datetime:
        return day.replace(hour=hm[0], minute=hm[1], second=0, microsecond=0)

    def last_boundary(hm):
        b = at(now, hm)
        return b if b <= now else b - timedelta(days=1)

    kb_began = last_boundary(start)
    agent_began = last_boundary(end)
    if kb_began > agent_began:
        mode, began = "kb", kb_began
    else:
        mode, began = "agent", agent_began
    return mode, f"{mode}@{began.strftime('%Y-%m-%dT%H:%M')}", began


# ---------------------------------------------------------------------------
# Runtime loop
# ---------------------------------------------------------------------------
async def _apply(desired: str, slot_id: str, expected_mode: Optional[str] = None) -> str:
    """Persist run_mode through an atomic read-modify-write of the latest config.

    expected_mode guards a concurrent manual switch: if the mode changed between
    tick()'s read and this write, the manual choice wins and no switch happens.
    """
    from . import admin_routes
    from .config_store import get_run_mode, update_config

    # Pre-save encrypted backup (same path as admin saves), then only touch run_mode.
    admin_routes._rolling_config_backup()
    prev = {}
    skipped = {}

    def mutator(cfg):
        actual = get_run_mode(cfg)
        if expected_mode is not None and actual != expected_mode:
            skipped["mode"] = actual
            return cfg
        prev["mode"] = actual
        cfg["run_mode"] = desired
        cfg["_version"] = int(cfg.get("_version", 1) or 1) + 1
        return cfg

    await update_config(mutator)
    if skipped:
        logger.info("scheduled switch skipped: manual mode change won (%s)", skipped.get("mode"))
        return "skipped"
    if prev.get("mode") != desired:
        admin_routes._sync_env_run_mode(desired)
    _save_state(slot_id)
    return "switched"


async def note_manual_switch(now: Optional[datetime] = None) -> Optional[str]:
    """Mark the current slot as handled after a manual run_mode change."""
    from .config_store import get_config

    config = await get_config()
    sched = schedule_of(config)
    if not sched:
        return None
    _, slot_id, _ = current_slot(now or datetime.now(TZ), *sched)
    _save_state(slot_id)
    return slot_id


async def tick(now: Optional[datetime] = None) -> Optional[str]:
    """One scheduler step. Returns a short status string (for logs/tests)."""
    from .config_store import get_config, get_run_mode

    config = await get_config()
    sched = schedule_of(config)
    if not sched:
        return None
    now = now or datetime.now(TZ)
    desired, slot_id, began = current_slot(now, *sched)
    if state_slot() == slot_id:
        return "handled"
    current = get_run_mode(config)
    if current == desired:
        # Already in the right mode: only remember the slot (no config write).
        _save_state(slot_id)
        return "already"
    waited = (now - began).total_seconds()
    force = (
        current == "agent" and waited >= AGENT_TO_KB_MAX_DEFER_SEC
    ) or (
        current == "kb" and waited >= KB_TO_AGENT_MAX_DEFER_SEC
    )
    if not is_idle() and not force:
        return "deferred"
    result = await _apply(desired, slot_id, expected_mode=current)
    if result == "skipped":
        return result
    try:
        from .logger_utils import vm_logger
        vm_logger.info(
            "ConfigAudit", "Run mode switched by schedule",
            run_mode=desired, previous=current, slot=slot_id, forced=force,
        )
    except Exception:
        logger.info("Run mode switched by schedule: %s -> %s (%s)", current, desired, slot_id)
    return "switched"


async def run_forever() -> None:
    if not _acquire_leader_lock():
        logger.info("mode scheduler loop skipped: another worker owns the leader lock")
        return
    try:
        while True:
            try:
                await tick()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # never let the loop die
                logger.warning("mode scheduler tick failed: %s", e)
            await asyncio.sleep(TICK_SEC)
    finally:
        _release_leader_lock()
