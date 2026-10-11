"""
Lightweight in-process scheduled auto-restart worker.
Gracefully releases accumulated memory heap during low-traffic windows.
When auto_restart_enabled is false/unconfigured, this worker is NOT started (zero overhead).
"""
import asyncio
import datetime
import logging
import os
import re
import sys
import time
from typing import Optional, Tuple

from . import stats

logger = logging.getLogger("ocrproxy.auto_restart")

_auto_restart_task: Optional[asyncio.Task] = None
_current_target_time: Optional[str] = None
_TIME_REGEX = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def parse_time_string(time_str: str) -> Tuple[int, int]:
    """Parse and validate an 'HH:MM' time string. Defaults to (4, 0) if invalid."""
    if not time_str or not isinstance(time_str, str):
        return 4, 0
    m = _TIME_REGEX.match(time_str.strip())
    if not m:
        logger.warning("Invalid auto_restart_time format '%s', falling back to 04:00", time_str)
        return 4, 0
    return int(m.group(1)), int(m.group(2))


def calculate_next_run_delay(time_str: str, now: Optional[datetime.datetime] = None) -> float:
    """Calculate the number of seconds from now until the next occurrence of time_str (HH:MM)."""
    hh, mm = parse_time_string(time_str)
    if now is None:
        now = datetime.datetime.now()
    target = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if target <= now:
        target += datetime.timedelta(days=1)
    return max(0.0, (target - now).total_seconds())


def _perform_exit():
    """Trigger graceful process termination so systemd Restart=always can cleanly respawn it."""
    try:
        # Flush stdout/stderr before exit
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    # Exit with code 0 (clean exit). systemd Restart=always respawns it in a fresh state.
    os._exit(0)


async def _auto_restart_loop(target_time_str: str, grace_check_interval: float = 1.0):
    """Main scheduling loop for daily restart."""
    hh, mm = parse_time_string(target_time_str)
    formatted_time = f"{hh:02d}:{mm:02d}"
    logger.info("Auto-restart worker activated for daily %s", formatted_time)

    try:
        while True:
            delay = calculate_next_run_delay(formatted_time)
            logger.info(
                "Next auto-restart scheduled at %s (in %.1f hours / %d seconds)",
                formatted_time,
                delay / 3600.0,
                int(delay),
            )

            # Sleep in increments of at most 10s to allow quick cancellation on config reload
            end_time = time.time() + delay
            while True:
                remaining = end_time - time.time()
                if remaining <= 0:
                    break
                await asyncio.sleep(min(remaining, 10.0))

            # Target time reached: wait gracefully for in-flight requests
            logger.info("Auto-restart trigger time reached (%s). Checking for active requests...", formatted_time)
            wait_deadline = time.time() + 30.0  # max 30s grace period
            while stats.get_in_flight_count() > 0 and time.time() < wait_deadline:
                count = stats.get_in_flight_count()
                logger.info("Waiting for %d in-flight request(s) before restart (max wait 30s)...", count)
                await asyncio.sleep(grace_check_interval)

            remaining_in_flight = stats.get_in_flight_count()
            if remaining_in_flight > 0:
                logger.warning(
                    "Grace period expired with %d active request(s). Proceeding with scheduled restart.",
                    remaining_in_flight,
                )
            else:
                logger.info("All requests complete. Proceeding with clean scheduled restart.")

            _perform_exit()
            break
    except asyncio.CancelledError:
        logger.info("Auto-restart worker for %s was cancelled.", formatted_time)
        raise


def sync_auto_restart_worker(config: dict):
    """
    Synchronize the auto-restart worker state based on current configuration.
    If auto_restart_enabled is false/unconfigured, any running worker is cancelled and cleared.
    """
    global _auto_restart_task, _current_target_time

    enabled = bool(config.get("auto_restart_enabled", False))
    target_time = str(config.get("auto_restart_time") or "04:00").strip()
    hh, mm = parse_time_string(target_time)
    formatted_time = f"{hh:02d}:{mm:02d}"

    if not enabled:
        # Not enabled: ensure worker task is NOT running (zero overhead)
        if _auto_restart_task is not None:
            if not _auto_restart_task.done():
                _auto_restart_task.cancel()
            _auto_restart_task = None
            _current_target_time = None
            logger.info("Auto-restart is disabled. Worker stopped.")
        return

    # Enabled: check if task needs to be started or updated
    if _auto_restart_task is not None and not _auto_restart_task.done():
        if _current_target_time == formatted_time:
            # Already running with the exact same target time, keep it
            return
        # Target time changed, cancel old worker
        _auto_restart_task.cancel()
        _auto_restart_task = None

    _current_target_time = formatted_time
    _auto_restart_task = asyncio.create_task(_auto_restart_loop(formatted_time))
    logger.info("Auto-restart worker started with schedule: daily at %s", formatted_time)


def stop_auto_restart_worker():
    """Cancel and clear any active auto-restart worker."""
    global _auto_restart_task, _current_target_time
    if _auto_restart_task is not None:
        if not _auto_restart_task.done():
            _auto_restart_task.cancel()
        _auto_restart_task = None
    _current_target_time = None


def get_auto_restart_status() -> dict:
    """Return status of the auto-restart subsystem."""
    is_running = _auto_restart_task is not None and not _auto_restart_task.done()
    next_delay = calculate_next_run_delay(_current_target_time) if (_current_target_time and is_running) else None
    return {
        "enabled": is_running,
        "target_time": _current_target_time if is_running else None,
        "next_run_seconds": next_delay,
        "in_flight": stats.get_in_flight_count(),
    }
