"""
Regression & Architecture Isolation Test Suite for OCRProxy Core Agnostic Engine
Verifies:
1. Complete elimination of provider-specific hardcoding in core files (proxy_routes, scheduler, admin_routes).
2. Declarative dynamic placeholder engine (${random_session_id}, ${timestamp}, ${uuid}).
3. Declarative auth header & custom header injection.
4. Presets consistency: opencode-free eliminated, clean opencode preserved.
"""
import unittest
import sys
import os
import re
import time
import json
from pathlib import Path

# Add vm-app to sys.path
BASE_DIR = Path(__file__).resolve().parent.parent
VM_APP_DIR = BASE_DIR / "vm-app"
if str(VM_APP_DIR) not in sys.path:
    sys.path.insert(0, str(VM_APP_DIR))

from app.proxy_routes import _resolve_dynamic_placeholder


class TestAgnosticEngineAndRulesIsolation(unittest.TestCase):

    def test_no_opencode_in_core_backend_files(self):
        """Rule: Core engine must be 100% agnostic and contain ZERO hardcoded vendor names."""
        core_files = [
            VM_APP_DIR / "app" / "proxy_routes.py",
            VM_APP_DIR / "app" / "scheduler.py",
            VM_APP_DIR / "app" / "admin_routes.py",
        ]
        for f in core_files:
            content = f.read_text(encoding="utf-8")
            self.assertNotIn("opencode-free", content, f"Hardcoded 'opencode-free' found in {f.name}")
            self.assertNotIn("opencode_free", content, f"Hardcoded 'opencode_free' found in {f.name}")
            self.assertNotIn("_gen_opencode_session_id", content, f"Vendor-specific function found in {f.name}")
            self.assertNotIn("_is_opencode_free", content, f"Vendor-specific function found in {f.name}")

    def test_dynamic_placeholder_session_id(self):
        """Test ${random_session_id} dynamic placeholder generation."""
        template = "Bearer ${random_session_id}"
        resolved = _resolve_dynamic_placeholder(template)
        self.assertTrue(resolved.startswith("Bearer ses_"), f"Unexpected resolved value: {resolved}")
        self.assertNotIn("${random_session_id}", resolved)
        # Verify CLI regex pattern: ses_[0-9a-f]{12}[0-9A-Za-z]{14}
        ses_id = resolved.split("Bearer ")[1]
        self.assertTrue(re.match(r"^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$", ses_id), f"Invalid session format: {ses_id}")

    def test_dynamic_placeholder_timestamp_and_uuid(self):
        """Test ${timestamp} and ${uuid} placeholders."""
        t_template = "req-${timestamp}"
        resolved_t = _resolve_dynamic_placeholder(t_template)
        self.assertTrue(resolved_t.startswith("req-"))
        self.assertTrue(resolved_t[4:].isdigit())

        u_template = "trace-${uuid}"
        resolved_u = _resolve_dynamic_placeholder(u_template)
        self.assertTrue(resolved_u.startswith("trace-"))
        raw_uuid = resolved_u[6:]
        self.assertEqual(len(raw_uuid.split("-")), 5)

    def test_presets_catalog_opencode_free_removed(self):
        """Verify catalog.json has opencode-free removed but opencode standard preserved."""
        catalog_file = BASE_DIR / "shared" / "presets" / "catalog.json"
        self.assertTrue(catalog_file.exists())
        catalog_raw = json.loads(catalog_file.read_text(encoding="utf-8"))
        providers = catalog_raw.get("providers", [])
        item_ids = [item.get("id") for item in providers]
        self.assertNotIn("opencode-free", item_ids, "opencode-free should be removed from catalog.json")
        self.assertIn("opencode", item_ids, "Standard opencode should remain in catalog.json")

    def test_no_opencode_free_preset_file(self):
        """Verify shared/presets/opencode-free.json is deleted."""
        preset_file = BASE_DIR / "shared" / "presets" / "opencode-free.json"
        self.assertFalse(preset_file.exists(), "opencode-free.json must be deleted")

    def test_frontend_providers_cleaned(self):
        """Verify shared/admin/js/providers.js has no opencode-free but keeps opencode."""
        frontend_providers = (BASE_DIR / "shared" / "admin" / "js" / "providers.js").read_text(encoding="utf-8")
        self.assertNotIn("'opencode-free':", frontend_providers)
        self.assertNotIn('"opencode-free":', frontend_providers)
        self.assertIn("opencode:", frontend_providers)

    def test_declarative_effort_map_and_adaptive_thinking(self):
        """Verify declarative effort_map (none -> low), force_adaptive_thinking, and Anthropic output_config.effort."""
        from app.proxy_routes import _normalise_for_provider, _normalise_messages_for_provider

        body_openai = {
            "model": "minimax-m3.1-flash-preview",
            "reasoning_effort": "none",
            "thinking": {"type": "disabled"},
            "reasoning_split": False,
            "output_config": {"format": "text", "effort": "high"},
        }
        _normalise_for_provider(body_openai, "minimax")
        self.assertEqual(body_openai["model"], "MiniMax-M3.1-Flash-Preview")
        self.assertEqual(body_openai["reasoning_effort"], "low")
        self.assertEqual(body_openai["thinking"]["type"], "adaptive")
        self.assertEqual(body_openai["reasoning_split"], True)
        self.assertNotIn("output_config", body_openai)

        body_anthropic = {
            "model": "minimax-m3.1-flash-preview",
            "thinking": {"type": "disabled"},
            "output_config": {"format": "text", "effort": "none"},
        }
        _normalise_messages_for_provider(body_anthropic, "minimax")
        self.assertEqual(body_anthropic["model"], "MiniMax-M3.1-Flash-Preview")
        self.assertEqual(body_anthropic["thinking"]["type"], "adaptive")
        self.assertEqual(body_anthropic["output_config"], {"effort": "low"})


if __name__ == "__main__":
    unittest.main()

