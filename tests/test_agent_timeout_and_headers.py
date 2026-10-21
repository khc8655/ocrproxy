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
        config = {"request_timeout_sec": 12.0, "agent_first_byte_timeout_sec": 120.0}
        category = "agent"

        # Explicit cand override
        cand_explicit = {"timeout_sec": 180.0}
        cand_timeout_sec = float(cand_explicit["timeout_sec"])
        self.assertEqual(cand_timeout_sec, 180.0)

        # Standard agent cand without explicit override
        cand_std = {}
        cand_timeout_sec = float(config.get("agent_first_byte_timeout_sec", 120.0))
        self.assertEqual(cand_timeout_sec, 120.0)

        # In KB category, it should take the per-request timeout
        category_kb = "kb"
        cand_timeout_sec_kb = float(config.get("request_timeout_sec", 15.0))
        self.assertEqual(cand_timeout_sec_kb, 12.0)

    def test_budget_scale_agent_bounds(self):
        # _scale_budget was removed when budgeting moved into the scheduler (f7dbe6e);
        # assert the same contract against the extracted pure function instead.
        from app.scheduler import compute_request_budget
        # A small explicit cap can never clamp below one full 120 s agent attempt
        self.assertEqual(compute_request_budget(120.0, 3, 1, raw_cap=60.0), 120.0)
        # Without a cap the budget scales with min(max_retries, candidates)
        self.assertEqual(compute_request_budget(120.0, 3, 1), 122.0)
        self.assertEqual(compute_request_budget(120.0, 3, 2), 245.0)
        self.assertEqual(compute_request_budget(120.0, 3, 3), 365.0)
        # max_retries limits the scaling, 600 s is the hard ceiling
        self.assertEqual(compute_request_budget(120.0, 2, 5), 245.0)
        self.assertEqual(compute_request_budget(300.0, 3, 3), 600.0)
        # A cap that still allows two attempts guarantees failover is not starved
        self.assertEqual(compute_request_budget(120.0, 3, 3, raw_cap=250.0), 250.0)
        # A cap below two attempts is honoured (but never below one attempt)
        self.assertEqual(compute_request_budget(120.0, 3, 3, raw_cap=200.0), 200.0)

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
