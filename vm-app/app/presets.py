"""Shared 适配规则（presets）唯一加载入口。

历史背景：admin_routes 与 proxy_routes 曾各自实现「shared/presets 目录解析 +
文件名归一化 + JSON 读取 + 内存缓存」，两份实现随时间漂移（一个返回 None、
一个返回 {}，缓存各自维护）。这里收敛为单一实现，所有调用方只依赖本模块。
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Optional

logger = logging.getLogger("presets")

_PRESET_CACHE: dict = {}
_CATALOG_CACHE: dict = {}


def get_presets_dir() -> Path:
    """Resolve shared/presets in both prod (/opt/ocrproxy) and dev repo layouts."""
    p = Path(__file__).resolve().parent.parent / "shared" / "presets"
    if p.exists():
        return p
    return Path(__file__).resolve().parent.parent.parent / "shared" / "presets"


def _candidate_files(preset_id: str) -> list[Path]:
    pid = str(preset_id or "").lower().strip()
    if not pid:
        return []
    pdir = get_presets_dir()
    files = [pdir / f"{pid}.json"]
    # Fallback: "b.ai"/"b-ai" -> "bai" (dots/hyphens/underscores stripped)
    pid_clean = re.sub(r"[.\-_]", "", pid)
    if pid_clean and pid_clean != pid:
        files.append(pdir / f"{pid_clean}.json")
    return files


def load_preset(preset_id: str) -> dict:
    """Load one provider preset (adapter rules) with in-memory cache; {} when absent."""
    pid = str(preset_id or "").lower().strip()
    if not pid:
        return {}
    if pid in _PRESET_CACHE:
        return _PRESET_CACHE[pid]
    for preset_file in _candidate_files(pid):
        if not preset_file.exists():
            continue
        try:
            data = json.loads(preset_file.read_text(encoding="utf-8"))
            _PRESET_CACHE[pid] = data
            return data
        except Exception as e:
            logger.warning("Failed to read local preset %s: %s", preset_file.name, e)
    return {}


def clear_cache() -> None:
    """Invalidate cached preset/catalog data (called after rule updates)."""
    _PRESET_CACHE.clear()
    _CATALOG_CACHE.clear()


def load_catalog() -> dict:
    """Load shared/presets/catalog.json with in-memory cache."""
    if _CATALOG_CACHE:
        return _CATALOG_CACHE
    catalog_file = get_presets_dir() / "catalog.json"
    if catalog_file.exists():
        try:
            _CATALOG_CACHE.update(json.loads(catalog_file.read_text(encoding="utf-8")))
        except Exception as e:
            logger.warning("Failed to read local catalog.json: %s", e)
    return _CATALOG_CACHE or {"version": "1.1.0", "providers": []}
