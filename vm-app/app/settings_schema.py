"""vm-app/app/settings_schema.py

Unified settings reader and clamp engine driven by shared/config/settings.schema.json.
Provides single source of truth for parameter defaults, ranges, and alias fallbacks.
"""

from __future__ import annotations
import json
from pathlib import Path
from typing import Any, Dict, Optional

_SCHEMA_DATA: Optional[Dict[str, Any]] = None
_FIELDS_BY_KEY: Dict[str, Dict[str, Any]] = {}


def _load_schema() -> Dict[str, Any]:
    global _SCHEMA_DATA, _FIELDS_BY_KEY
    if _SCHEMA_DATA is not None:
        return _SCHEMA_DATA

    candidates = [
        Path(__file__).resolve().parent.parent.parent / "shared" / "config" / "settings.schema.json",
        Path(__file__).resolve().parent / "settings.schema.json",
    ]
    for p in candidates:
        if p.is_file():
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    _SCHEMA_DATA = data
                    _FIELDS_BY_KEY = {fld["key"]: fld for fld in data.get("fields", [])}
                    return _SCHEMA_DATA
            except Exception:
                pass

    # Safe built-in fallback if file is somehow missing
    _SCHEMA_DATA = {"version": 1, "fields": []}
    return _SCHEMA_DATA


def get_field_def(key: str) -> Optional[Dict[str, Any]]:
    _load_schema()
    return _FIELDS_BY_KEY.get(key)


def get_setting(config: Dict[str, Any], key: str, default_override: Any = None) -> Any:
    """Retrieve setting value by key with schema-driven alias migration, defaults, and bounds clamping."""
    fld = get_field_def(key)
    if not fld:
        return config.get(key, default_override)

    # 1. Look in config["settings"] block or top-level config
    val = None
    settings_blk = config.get("settings")
    if isinstance(settings_blk, dict) and key in settings_blk:
        val = settings_blk[key]
    elif key in config:
        val = config[key]

    # 2. Check aliases if not found
    if val is None:
        for alias in fld.get("aliases", []):
            if isinstance(settings_blk, dict) and alias in settings_blk:
                val = settings_blk[alias]
                break
            elif alias in config:
                val = config[alias]
                break

    # 3. Fallback to default
    if val is None:
        return default_override if default_override is not None else fld.get("default")

    # 4. Type cast and clamp
    fld_type = fld.get("type")
    try:
        if fld_type == "int":
            int_val = int(val)
            min_val = fld.get("min")
            max_val = fld.get("max")
            if min_val is not None:
                int_val = max(int_val, min_val)
            if max_val is not None:
                int_val = min(int_val, max_val)
            return int_val
        elif fld_type == "float":
            flt_val = float(val)
            min_val = fld.get("min")
            max_val = fld.get("max")
            if min_val is not None:
                flt_val = max(flt_val, float(min_val))
            if max_val is not None:
                flt_val = min(flt_val, float(max_val))
            return flt_val
        elif fld_type == "boolean":
            if isinstance(val, bool):
                return val
            if isinstance(val, (int, float)):
                return bool(val)
            return str(val).lower() in ("true", "1", "yes", "on")
        elif fld_type == "string" or fld_type == "select":
            return str(val)
    except (ValueError, TypeError):
        return default_override if default_override is not None else fld.get("default")

    return val
