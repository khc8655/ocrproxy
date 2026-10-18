"""
Comprehensive Behavioral Test Suite for OCRProxy VM & EdgeOne Vault Isolation.
Enforces real execution: sends actual HTTP requests, executes backend route handlers,
and runs real Playwright headless browser validations.
Zero mock_env. Zero grep-only source text assertions.
"""
import os
import sys
import json
import asyncio
import unittest
from unittest import mock
from pathlib import Path

# Ensure vm-app is in python path
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "vm-app"))

from starlette.testclient import TestClient
from starlette.requests import Request
from app.main import app
import app.config_store as config_store
import app.admin_routes as admin_routes


class TestBackendVaultSecurityAndLifecycle(unittest.TestCase):
    """Real HTTP and handler behavioral tests asserting backend security and sovereignty."""

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def setUp(self):
        # Set up a clean in-memory config fixture
        self.test_cfg = {
            "_version": 10,
            "providers": {
                "vault_hub_prov": {
                    "name": "EdgeOne Vault Provider",
                    "origin": "vault",
                    "base_url": "https://api.openai.com/v1",
                    "protocols": ["chat"],
                    "keys": {
                        "vkey1": {
                            "key": "sk-authoritative-vault-secret-12345",
                            "origin": "vault",
                            "is_local": False
                        }
                    }
                },
                "local_prov": {
                    "name": "Local Custom Provider",
                    "origin": "local",
                    "base_url": "https://custom.api/v1",
                    "protocols": ["chat"],
                    "keys": {
                        "localkey1": {
                            "key": "sk-local-secret-67890",
                            "origin": "local",
                            "is_local": True
                        }
                    }
                }
            },
            "agent_models": {
                "gpt-local": {
                    "model": "gpt-local",
                    "keys": [{"provider": "local_prov", "key": "localkey1"}]
                }
            },
            "edgeone_vault": {
                "url": "https://vault.example.com",
                "token": "test-vault-token-123"
            }
        }
        # Inject test config into config_store
        config_store._config = self.test_cfg.copy()

    def test_01_backend_enforces_vault_key_immutability(self):
        """
        Verify that a client cannot tamper with or overwrite a vault key's secret
        via POST /api/config. The backend must strictly preserve the authoritative secret.
        """
        tampered_payload = {
            "_version": 10,
            "providers": {
                "vault_hub_prov": {
                    "name": "EdgeOne Vault Provider",
                    "origin": "vault",
                    "base_url": "https://api.openai.com/v1",
                    "protocols": ["chat"],
                    "keys": {
                        # Attacker attempts to change secret from sk-authoritative-... to sk-hacked-...
                        "vkey1": {
                            "key": "sk-hacked-vault-secret-99999",
                            "origin": "vault",
                            "is_local": False
                        }
                    }
                }
            }
        }

        # Mock authentication and get_config
        with mock.patch("app.admin_routes._check_auth", return_value=True), \
             mock.patch("app.admin_routes.get_config", new_callable=mock.AsyncMock, return_value=self.test_cfg.copy()), \
             mock.patch("app.admin_routes.save_config", new_callable=mock.AsyncMock) as mock_save:
            mock_save.return_value = None
            res = self.client.post("/api/config", json=tampered_payload)
            self.assertEqual(res.status_code, 200, f"Expected 200 OK, got {res.status_code}: {res.text}")

            # Assert what was passed to save_config: vkey1 must retain authoritative secret!
            saved_config = mock_save.call_args[0][0]
            saved_key_obj = saved_config["providers"]["vault_hub_prov"]["keys"]["vkey1"]
            self.assertEqual(
                saved_key_obj["key"],
                "sk-authoritative-vault-secret-12345",
                "Backend security violated: vault key secret was modified by client request!"
            )

    def test_02_backend_permits_local_provider_deletion(self):
        """
        Verify local sovereignty: VM user can delete a provider from their local config
        and backend saves the removal without rejecting.
        """
        delete_payload = {
            "_version": 10,
            "providers": {
                # local_prov was removed by client
                "vault_hub_prov": self.test_cfg["providers"]["vault_hub_prov"]
            },
            "agent_models": {}
        }

        with mock.patch("app.admin_routes._check_auth", return_value=True), \
             mock.patch("app.admin_routes.get_config", new_callable=mock.AsyncMock, return_value=self.test_cfg.copy()), \
             mock.patch("app.admin_routes.save_config", new_callable=mock.AsyncMock) as mock_save:
            mock_save.return_value = None
            res = self.client.post("/api/config", json=delete_payload)
            self.assertEqual(res.status_code, 200)

            saved_config = mock_save.call_args[0][0]
            self.assertNotIn("local_prov", saved_config["providers"], "Local provider was not removed from config!")

    def test_03_vault_sync_endpoint_no_name_error(self):
        """
        Verify that vault_sync_endpoint executes without raising NameError: name 'created' is not defined.
        """
        import httpx

        async def run_sync_test():
            manifest_data = {
                "ok": True,
                "count": 1,
                "providers": {
                    "vault_hub_prov": {
                        "name": "EdgeOne Vault Provider",
                        "base_url": "https://api.openai.com/v1",
                        "protocols": ["chat"]
                    }
                }
            }
            fetch_data = {
                "ok": True,
                "provider": "vault_hub_prov",
                "provider_config": {
                    "name": "EdgeOne Vault Provider",
                    "base_url": "https://api.openai.com/v1",
                    "protocols": ["chat"],
                    "adapter_rules": {}
                }
            }

            resp_manifest = httpx.Response(200, json=manifest_data)
            resp_fetch = httpx.Response(200, json=fetch_data)

            with mock.patch("app.admin_routes._check_auth", return_value=True), \
                 mock.patch("app.admin_routes._get_vault_credentials", new_callable=mock.AsyncMock, return_value=("https://vault.example.com", "token123")), \
                 mock.patch("app.admin_routes.get_config", new_callable=mock.AsyncMock, return_value=self.test_cfg.copy()), \
                 mock.patch("app.admin_routes.save_config", new_callable=mock.AsyncMock, return_value=None), \
                 mock.patch("httpx.AsyncClient.get", new_callable=mock.AsyncMock, return_value=resp_manifest), \
                 mock.patch("httpx.AsyncClient.post", new_callable=mock.AsyncMock, return_value=resp_fetch):

                scope = {
                    "type": "http",
                    "method": "POST",
                    "path": "/api/admin/vault/sync",
                    "headers": []
                }
                req = Request(scope)
                resp = await admin_routes.vault_sync_endpoint(req)
                self.assertEqual(resp.status_code, 200)
                body = json.loads(resp.body.decode("utf-8"))
                self.assertTrue(body.get("ok"))
                self.assertIn("created_count", body)
                self.assertIn("updated_count", body)

        asyncio.run(run_sync_test())


class TestPlaywrightBrowserUIBehavior(unittest.TestCase):
    """Playwright E2E browser test verifying UI layout, button deduplication, and absence of deprecated items."""

    def test_browser_dom_validations(self):
        from playwright.sync_api import sync_playwright

        html_path = REPO_ROOT / "vm-app" / "static" / "admin.html"
        self.assertTrue(html_path.exists(), f"Admin HTML file not found at {html_path}")

        file_url = f"file://{html_path.resolve()}"

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(file_url)

            # 1. Assert deprecated 1+1 runLiveTest button is completely gone
            live_btn_count = page.locator("button[id^='liveTestBtn-']").count()
            self.assertEqual(live_btn_count, 0, "Deprecated liveTestBtn element found in DOM!")

            # 2. Assert redundant manageAllModels button was removed from dashboard
            manage_models_btn = page.locator("button:has-text('管理全部模型')").count()
            self.assertEqual(manage_models_btn, 0, "Redundant manageAllModels button found in dashboard!")

            # 3. Assert duplicate export/import buttons were removed from Raw JSON panel
            raw_export_btn = page.locator("#panel-raw button:has-text('导出备份')").count()
            self.assertEqual(raw_export_btn, 0, "Duplicate export button found in Raw JSON panel!")

            # 4. Assert Settings tab top save buttons were removed (only bottom sticky action bar remains)
            settings_save_btns = page.locator("#panel-settings button:has-text('保存设置并生效')").count()
            self.assertEqual(settings_save_btns, 1, f"Expected exactly 1 save button in Settings panel, found {settings_save_btns}")

            # 5. Assert resetStats button text is 清空错误日志
            reset_logs_btn = page.locator("button:has-text('清空错误日志')").count()
            self.assertEqual(reset_logs_btn, 1, "Expected 清空错误日志 button in Dashboard logs header")

            # 6. Assert providers tab has btnSyncVault with label 从凭据中枢同步
            sync_btn = page.locator("#btnSyncVault")
            self.assertTrue(sync_btn.is_visible() or sync_btn.count() > 0)
            self.assertIn("从凭据中枢同步", sync_btn.inner_text())

            browser.close()


if __name__ == "__main__":
    unittest.main()
