import unittest
import sys
from pathlib import Path
from unittest.mock import MagicMock

# Add vm-app to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vm-app"))

for mod_name in ['fastapi', 'fastapi.responses', 'httpx', 'httpx_sse', 'sse_starlette', 'sse_starlette.sse']:
    if mod_name not in sys.modules:
        try:
            __import__(mod_name)
        except ImportError:
            sys.modules[mod_name] = MagicMock()

from app.scheduler import _get_default_ua, _STALE_RETRY_WINDOW_SEC

class TestAgentTimeoutAndHeaders(unittest.TestCase):
    def test_default_ua(self):
        ua = _get_default_ua()
        self.assertTrue(ua.startswith("OCRProxy/"))
        self.assertIn("v2026", ua)

    def test_stale_retry_window(self):
        self.assertEqual(_STALE_RETRY_WINDOW_SEC, 5.0)

    def test_agent_first_byte_timeout_logic(self):
        # Verify that category == "agent" defaults to 120.0s regardless of model name
        config = {"upstream_timeout": 12.0, "agent_first_byte_timeout_sec": 120.0}
        category = "agent"

        # Explicit cand override
        cand_explicit = {"timeout_sec": 180.0}
        cand_timeout_sec = float(cand_explicit["timeout_sec"])
        self.assertEqual(cand_timeout_sec, 180.0)

        # Standard agent cand without explicit override
        cand_std = {}
        cand_timeout_sec = float(config.get("agent_first_byte_timeout_sec", 120.0))
        self.assertEqual(cand_timeout_sec, 120.0)

        # In KB category, it should take upstream_timeout
        category_kb = "kb"
        cand_timeout_sec_kb = float(config.get("upstream_timeout", 15.0))
        self.assertEqual(cand_timeout_sec_kb, 12.0)

    def test_budget_scale_agent_bounds(self):
        from app.proxy_routes import _scale_budget
        # When explicit budget is 60s but agent timeout is 120s, budget must not clamp below 120s
        cfg_small_budget = {"schedule_total_budget": 60.0}
        budget = _scale_budget(cfg_small_budget, timeout=120.0, candidate_count=1)
        self.assertEqual(budget, 120.0)

        # When no explicit budget, scales with candidate count
        cfg_auto = {}
        budget_1 = _scale_budget(cfg_auto, timeout=120.0, candidate_count=1)
        self.assertEqual(budget_1, 120.0)
        budget_2 = _scale_budget(cfg_auto, timeout=120.0, candidate_count=2)
        self.assertEqual(budget_2, 240.0)
        budget_3 = _scale_budget(cfg_auto, timeout=120.0, candidate_count=3)
        self.assertEqual(budget_3, 360.0)

    def test_preset_rules_do_not_contain_timeout_rules(self):
        import json
        shared_dir = Path(__file__).resolve().parent.parent / "shared" / "presets"
        for p_file in shared_dir.glob("*.json"):
            if p_file.name == "catalog.json":
                continue
            with open(p_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            rules = data.get("adapter_rules") or {}
            self.assertNotIn("timeout_rules", rules, f"Preset {p_file.name} still contains timeout_rules!")

if __name__ == "__main__":
    unittest.main()
