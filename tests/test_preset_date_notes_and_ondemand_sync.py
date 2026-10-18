"""
test_preset_date_notes_and_ondemand_sync.py — Test suite for:
1. Standardized updated_at (YYYY-MM-DD) and update_notes in all presets & catalog.
2. Strict on-demand pulling (single preset detail).
3. Physical-level defense: update_preset_rules strictly limits updates to existing local providers.
4. EdgeOne & VM backend parity for preset date and notes propagation.
"""

import os
import sys
import json
import re
import asyncio
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "vm-app"))

import tests.mock_env  # noqa: F401

PRESETS_DIR = REPO_ROOT / "shared" / "presets"
DATE_REGEX = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class TestPresetDateNotesAndOnDemandSync(unittest.TestCase):

    def test_01_all_preset_files_have_date_and_notes(self):
        """Verify all 16 JSON presets have valid updated_at and update_notes."""
        preset_files = [f for f in PRESETS_DIR.glob("*.json") if f.name != "catalog.json"]
        self.assertGreaterEqual(len(preset_files), 16, f"Expected at least 16 preset files, found {len(preset_files)}")

        for f in preset_files:
            data = json.loads(f.read_text(encoding="utf-8"))
            pid = f.stem
            self.assertIn("updated_at", data, f"Preset {pid} missing 'updated_at'")
            self.assertTrue(DATE_REGEX.match(data["updated_at"]), f"Preset {pid} has invalid date format: {data['updated_at']}")
            self.assertIn("update_notes", data, f"Preset {pid} missing 'update_notes'")
            self.assertGreater(len(data["update_notes"].strip()), 0, f"Preset {pid} has empty 'update_notes'")

    def test_02_catalog_json_has_date_and_notes(self):
        """Verify catalog.json has updated_at and update_notes for all catalog items."""
        catalog_path = PRESETS_DIR / "catalog.json"
        self.assertTrue(catalog_path.exists(), "shared/presets/catalog.json must exist")
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        self.assertIn("providers", catalog)
        self.assertGreaterEqual(len(catalog["providers"]), 16)

        for p in catalog["providers"]:
            pid = p.get("id")
            self.assertIn("updated_at", p, f"Catalog item {pid} missing 'updated_at'")
            self.assertTrue(DATE_REGEX.match(p["updated_at"]), f"Catalog item {pid} invalid date: {p['updated_at']}")
            self.assertIn("update_notes", p, f"Catalog item {pid} missing 'update_notes'")
            self.assertGreater(len(p["update_notes"].strip()), 0, f"Catalog item {pid} has empty 'update_notes'")

    def test_03_vm_check_preset_updates_returns_date_and_notes(self):
        """Verify VM admin_routes.py check_preset_updates returns updated_at and update_notes."""
        async def run_async():
            from app.admin_routes import check_preset_updates_endpoint
            from starlette.requests import Request

            dummy_body = {
                "providers": [
                    {"provider_id": "minimax", "preset_id": "minimax", "current_version": "1.0.0", "rule_hash": "old_hash"}
                ]
            }

            req = Request({
                "type": "http",
                "method": "POST",
                "headers": [(b"authorization", b"Bearer dummy_admin_token")],
            })
            req._json = dummy_body

            with patch("app.admin_routes._check_auth", return_value=True):
                resp = await check_preset_updates_endpoint(req)
                self.assertEqual(resp.status_code, 200)
                data = json.loads(resp.body.decode("utf-8"))
                self.assertTrue(data.get("ok"))
                self.assertGreater(len(data.get("updates", [])), 0)
                u = data["updates"][0]
                self.assertEqual(u["provider_id"], "minimax")
                self.assertIn("updated_at", u)
                self.assertTrue(DATE_REGEX.match(u["updated_at"]))
                self.assertIn("update_notes", u)
                self.assertGreater(len(u["update_notes"]), 0)

        asyncio.run(run_async())

    def test_04_vm_update_rules_strictly_filters_existing_local_providers(self):
        """Verify update_preset_rules_endpoint rejects non-existent providers and updates only local ones."""
        async def run_async():
            from app.admin_routes import update_preset_rules_endpoint
            from starlette.requests import Request

            mock_config = {
                "providers": {
                    "minimax": {
                        "base_url": "https://api.minimaxi.com/v1",
                        "preset_id": "minimax",
                        "preset_version": "1.0.0",
                        "keys": {"k1": "sk-test"}
                    }
                }
            }

            # Case A: Requesting only providers that do NOT exist in local config
            req_invalid = Request({
                "type": "http",
                "method": "POST",
                "headers": [(b"authorization", b"Bearer dummy")],
            })
            req_invalid._json = {"provider_ids": ["non_existent_provider", "openai"]}

            with patch("app.admin_routes._check_auth", return_value=True), \
                 patch("app.admin_routes.get_config", AsyncMock(return_value=mock_config)):
                resp_invalid = await update_preset_rules_endpoint(req_invalid)
                self.assertEqual(resp_invalid.status_code, 400)
                data = json.loads(resp_invalid.body.decode("utf-8"))
                self.assertFalse(data.get("ok"))
                self.assertIn("None of the specified providers exist", data.get("error", ""))

            # Case B: Requesting existing local provider + non-existing provider
            # Should ONLY update the existing local provider and ignore/exclude non-existing ones
            saved_configs = []

            async def mock_save_config(cfg):
                saved_configs.append(cfg)

            req_valid = Request({
                "type": "http",
                "method": "POST",
                "headers": [(b"authorization", b"Bearer dummy")],
            })
            req_valid._json = {"provider_ids": ["minimax", "non_existent_provider"]}

            with patch("app.admin_routes._check_auth", return_value=True), \
                 patch("app.admin_routes.get_config", AsyncMock(return_value=mock_config)), \
                 patch("app.admin_routes.save_config", mock_save_config):
                resp_valid = await update_preset_rules_endpoint(req_valid)
                self.assertEqual(resp_valid.status_code, 200)
                data = json.loads(resp_valid.body.decode("utf-8"))
                self.assertTrue(data.get("ok"))
                self.assertEqual(len(data.get("updated", [])), 1)
                updated_item = data["updated"][0]
                self.assertEqual(updated_item["provider_id"], "minimax")
                self.assertIn("updated_at", updated_item)
                self.assertIn("update_notes", updated_item)

                # Verify saved config received the update and date/notes
                self.assertEqual(len(saved_configs), 1)
                saved = saved_configs[0]
                pdata = saved["providers"]["minimax"]
                self.assertEqual(pdata.get("preset_updated_at"), updated_item["updated_at"])
                self.assertEqual(pdata.get("preset_update_notes"), updated_item["update_notes"])
                self.assertNotIn("non_existent_provider", saved["providers"])

        asyncio.run(run_async())

    def test_05_edgeone_hub_strictly_filters_existing_local_providers(self):
        """Verify EdgeOne hub.js code includes the physical filtering safeguard."""
        hub_file = REPO_ROOT / "agent-edgeone" / "edge-functions" / "lib" / "presets" / "hub.js"
        self.assertTrue(hub_file.exists())
        content = hub_file.read_text(encoding="utf-8")
        self.assertIn("targetIds.filter((pid) => Boolean(providers[pid]))", content)
        self.assertIn("updated_at: remotePreset.updated_at", content)
        self.assertIn("preset_updated_at = presetData.updated_at", content)
        self.assertIn("preset_update_notes = presetData.update_notes", content)

    def test_06_frontend_ui_has_date_and_ondemand_pull(self):
        """Verify providers.js UI renders updated_at and uses on-demand pull."""
        providers_js = REPO_ROOT / "shared" / "admin" / "js" / "providers.js"
        content = providers_js.read_text(encoding="utf-8")
        self.assertIn("📅 更新日期:", content)
        self.assertIn("📝 适配说明：", content)
        self.assertIn("一键更新本地已存供应商规则", content)
        self.assertIn("/api/admin/presets/detail?id=", content)
        self.assertIn("preset_updated_at", content)
        self.assertIn("preset_update_notes", content)


if __name__ == "__main__":
    unittest.main()
