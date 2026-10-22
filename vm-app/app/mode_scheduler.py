"""
mode_scheduler.py — 按时段自动切换 VM 运行模式（KB 夜间入库 / 白天 Agent）。

配置（settings.schema.json，仅 VM）：
    mode_schedule_enabled   bool   默认 False
    mode_schedule_kb_start  "HH:MM" 默认 "22:00"（Asia/Shanghai）
    mode_schedule_kb_end    "HH:MM" 默认 "08:00"
在 [kb_start, kb_end) 时段内应为 kb，其余时段应为 agent，支持跨零点。

稳定性规则：
1. 只在「时段边界」动作（边沿触发）：每个时段只切一次，记录在 config["_mode_schedule_slot"]。
   时段内用户手动切换不会被下一分钟改回去；服务重启也不会重复切换。
2. 切换前等待当前模式空闲：/v1 没有进行中的请求，且最近 IDLE_SEC 内没有请求结束。
   - KB → Agent：没有等待上限，入库没跑完就一直顺延，不会把入库切断。
   - Agent → KB：最多顺延 AGENT_TO_KB_MAX_DEFER_SEC，之后强制切换，避免耽误夜间入库。
3. 切换走与管理端保存相同的路径：滚动备份、_version+1、同步 .env 的 RUN_MODE。
   进行中的请求在开始时已拿到旧配置对象，切换不影响它们；新请求按新模式处理。
   打开着的管理页面再保存会收到 409（版本冲突），刷新即可。
4. 只切换 run_mode 一个字段；两种模式的其它配置本来就分开存放，互不覆盖。
"""
from __future__ import annotations

import asyncio
import logging
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
AGENT_TO_KB_MAX_DEFER_SEC = 900.0
SLOT_KEY = "_mode_schedule_slot"

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

    # Latest boundary of each kind at or before now.
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
async def _apply(config: dict, desired: str, slot_id: str) -> None:
    """Persist run_mode + slot marker through the same path as an admin save."""
    from . import admin_routes
    from .config_store import save_config
    new_cfg = dict(config)
    new_cfg["run_mode"] = desired
    new_cfg[SLOT_KEY] = slot_id
    new_cfg["_version"] = int(config.get("_version", 1) or 1) + 1
    if config.get("run_mode") != desired:
        admin_routes._rolling_config_backup()
        admin_routes._sync_env_run_mode(desired)
    await save_config(new_cfg)


async def tick(now: Optional[datetime] = None) -> Optional[str]:
    """One scheduler step. Returns a short status string (for logs/tests)."""
    from .config_store import get_config, get_run_mode
    config = await get_config()
    sched = schedule_of(config)
    if not sched:
        return None
    now = now or datetime.now(TZ)
    desired, slot_id, began = current_slot(now, *sched)
    if config.get(SLOT_KEY) == slot_id:
        return "handled"
    current = get_run_mode(config)
    if current == desired:
        await _apply(config, desired, slot_id)  # just mark the slot as handled
        return "already"
    waited = (now - began).total_seconds()
    force = current == "agent" and waited >= AGENT_TO_KB_MAX_DEFER_SEC
    if not is_idle() and not force:
        return "deferred"
    await _apply(config, desired, slot_id)
    try:
        from .logger_utils import vm_logger
        vm_logger.info("ConfigAudit", "Run mode switched by schedule", run_mode=desired, previous=current,
                       slot=slot_id, forced=force)
    except Exception:
        logger.info("Run mode switched by schedule: %s -> %s (%s)", current, desired, slot_id)
    return "switched"


async def run_forever() -> None:
    while True:
        try:
            await tick()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # never let the loop die
            logger.warning("mode scheduler tick failed: %s", e)
        await asyncio.sleep(TICK_SEC)
