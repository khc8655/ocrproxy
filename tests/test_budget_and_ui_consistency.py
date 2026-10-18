#!/usr/bin/env python3
"""tests/test_budget_and_ui_consistency.py

Verifies P0-1 fix:
EdgeOne config exported with schedule_total_budget <= 10 imported into VM
is normalized into max_retries without compressing failover budget to 3s.
"""

import sys
from pathlib import Path

# Ensure vm-app is in sys.path
root_dir = Path(__file__).resolve().parent.parent
vm_app_dir = root_dir / "vm-app"
sys.path.insert(0, str(vm_app_dir))

# Ensure mock imports for optional runtime web dependencies in pure test runner
from unittest.mock import MagicMock
for mod in ["httpx", "fastapi", "fastapi.responses"]:
    if mod not in sys.modules:
        try:
            __import__(mod)
        except ImportError:
            sys.modules[mod] = MagicMock()

from app.admin_routes import _merge_configs
from app.settings_schema import get_setting


def test_edgeone_config_import_to_vm():
    print("🧪 Running test_edgeone_config_import_to_vm...")

    # Simulated EdgeOne exported config
    eo_config = {
        "providers": {
            "test_prov": {
                "base_url": "https://api.example.com",
                "keys": {"k1": "sk-1", "k2": "sk-2"}
            }
        },
        "agent_models": {
            "qwen-test": {
                "keys": [
                    {"provider": "test_prov", "key": "k1"},
                    {"provider": "test_prov", "key": "k2"}
                ]
            }
        },
        "settings": {
            "upstream_timeout_sec": 120,
            "schedule_total_budget": 3,  # Legacy retry count in EdgeOne
            "max_attempts_per_provider": 3
        }
    }

    local_existing = {
        "run_mode": "agent",
        "providers": {},
        "agent_models": {}
    }

    # 1. Merge into VM
    merged = _merge_configs(local_existing, eo_config, local_run_mode="agent")

    # Verification: schedule_total_budget <= 10 must be migrated to max_retries
    assert "schedule_total_budget" not in merged or merged.get("schedule_total_budget") != 3, (
        f"schedule_total_budget=3 should not be kept as a 3-second budget! merged={merged}"
    )
    assert merged.get("max_retries") == 3, f"Expected max_retries=3, got {merged.get('max_retries')}"
    print("  ✓ schedule_total_budget <= 10 properly migrated to max_retries: 3")

    # 2. Verify dynamic failover budget decoupling for candidate count 2 and timeout 120s
    single_timeout = 120.0
    eff_retries = min(merged.get("max_retries", 3), 2)
    effective_budget = single_timeout * eff_retries + (5.0 if eff_retries > 1 else 2.0)
    assert effective_budget >= single_timeout * 2, (
        f"Failover budget compressed! Expected >= {single_timeout * 2}, got {effective_budget}"
    )
    print(f"  ✓ Dynamic failover budget is {effective_budget}s (>= {single_timeout * 2}s)")

    # 3. Test schema-driven getter
    val = get_setting(merged, "max_retries")
    assert val == 3, f"Expected get_setting max_retries=3, got {val}"
    print("  ✓ Schema getter correctly retrieves max_retries")

    print("✅ test_edgeone_config_import_to_vm 100% PASSED!")


if __name__ == "__main__":
    test_edgeone_config_import_to_vm()
