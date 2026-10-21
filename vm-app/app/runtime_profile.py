"""三运行时默认值解析（shared/config/runtime-profiles.json 唯一真理源）。

只有「流程相同、数值不同」的参数（默认超时/冷却/并发/重试/窗口）允许出现在这里；
能力有无、控制流、数据形状差异必须由代码分支或 HOST 能力位表达，禁止塞进 profile。
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger("runtime_profile")

_PROFILES: Optional[Dict[str, Any]] = None
_FALLBACK = {"settings": {}, "cooldowns": {}}


def _profiles_path() -> Path:
    for p in (
        Path(__file__).resolve().parent.parent.parent / "shared" / "config" / "runtime-profiles.json",
        Path(__file__).resolve().parent / "runtime-profiles.json",
    ):
        if p.is_file():
            return p
    return Path(__file__).resolve().parent / "runtime-profiles.json"


def load_profiles() -> Dict[str, Any]:
    global _PROFILES
    if _PROFILES is not None:
        return _PROFILES
    try:
        data = json.loads(_profiles_path().read_text(encoding="utf-8"))
        _PROFILES = data.get("profiles", {}) if isinstance(data, dict) else {}
    except Exception as e:  # keep runtime alive if the file is missing/corrupt
        logger.warning("Failed to load runtime profiles: %s", e)
        _PROFILES = {}
    return _PROFILES


def active_profile_name(config: Optional[dict] = None) -> str:
    """EdgeOne has its own profile; VM splits by run_mode."""
    mode = (config or {}).get("run_mode") or os.environ.get("RUN_MODE") or "agent"
    return "vm-kb" if str(mode).lower().strip() == "kb" else "vm-agent"


def profile(config: Optional[dict] = None) -> Dict[str, Any]:
    return dict(load_profiles().get(active_profile_name(config)) or _FALLBACK)


def settings(config: Optional[dict] = None) -> Dict[str, Any]:
    return dict(profile(config).get("settings") or {})


def cooldowns(config: Optional[dict] = None) -> Dict[str, Any]:
    return dict(profile(config).get("cooldowns") or {})


def setting(config: Optional[dict], key: str, default: Any = None) -> Any:
    """Profile default for one key (caller still applies get_setting() overrides)."""
    return settings(config).get(key, default)


def edge_profile() -> Dict[str, Any]:
    return dict(load_profiles().get("edgeone") or _FALLBACK)
