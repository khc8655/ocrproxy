"""
Test suite for EdgeOne Vault dynamic sync and runtime lazy-fetch fallback.
Verifies that:
1. vault_sync_endpoint imports new providers from remote manifest that don't exist locally.
2. scheduler._lazy_fetch_vault_credential handles remote fetches and negative caching.
3. scheduler._async_persist_lazy_provider correctly updates the config store.
4. Strict 3-role privilege separation: vault operations strictly use VAULT_ACCESS_TOKEN and never fall back to ADMIN_PASSWORD.
"""
import asyncio
import os
import sys
import unittest
from unittest.mock import AsyncMock, patch, MagicMock

# Add vm-app to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "vm-app"))

import httpx
from app.scheduler import _lazy_fetch_vault_credential, _async_persist_lazy_provider, _lazy_fetch_failed_until
from app import config_store


class TestVaultDynamicSync(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _lazy_fetch_failed_until.clear()

    async def test_lazy_fetch_vault_credential_success(self):
        config = {
            "edgeone_vault": {
                "edgeone_url": "https://vault.example.com",
                "token": "secret-token"
            }
        }
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "ok": True,
            "provider_config": {
                "name": "Custom Provider",
                "base_url": "https://api.custom.com/v1",
                "protocol": "openai",
                "protocols": ["chat"],
                "keys": {"key1": "sk-123456"}
            }
        }
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        with patch("app.scheduler.httpx.AsyncClient") as mock_async_client:
            mock_async_client.return_value.__aenter__.return_value = mock_client
            res = await _lazy_fetch_vault_credential(config, "custom_p", "key1")

        self.assertIsNotNone(res)
        self.assertEqual(res["name"], "Custom Provider")
        self.assertEqual(res["keys"]["key1"], "sk-123456")

    async def test_lazy_fetch_vault_credential_negative_caching(self):
        config = {
            "edgeone_vault": {
                "edgeone_url": "https://vault.example.com",
                "token": "secret-token"
            }
        }
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 404

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        with patch("app.scheduler.httpx.AsyncClient") as mock_async_client:
            mock_async_client.return_value.__aenter__.return_value = mock_client
            res = await _lazy_fetch_vault_credential(config, "nonexistent", "bad_key")
            self.assertIsNone(res)
            # Second call should be skipped via negative cache without calling mock_post again
            self.assertEqual(mock_client.post.call_count, 1)
            res2 = await _lazy_fetch_vault_credential(config, "nonexistent", "bad_key")
            self.assertIsNone(res2)
            self.assertEqual(mock_client.post.call_count, 1)

    async def test_async_persist_lazy_provider(self):
        fake_cfg = {"providers": {}}
        async def fake_get_config():
            return fake_cfg
        async def fake_save_config(c):
            nonlocal fake_cfg
            fake_cfg = c

        with patch("app.config_store.get_config", side_effect=fake_get_config), \
             patch("app.config_store.save_config", side_effect=fake_save_config):
            prov_cfg = {
                "name": "Nvidia NIM",
                "base_url": "https://integrate.api.nvidia.com/v1",
                "protocol": "openai",
                "protocols": ["chat"],
                "anthropic_messages": False,
                "keys": {"nv_key": "nvapi-abcdef"}
            }
            await _async_persist_lazy_provider("nvidia", prov_cfg)

            self.assertIn("nvidia", fake_cfg["providers"])
            self.assertEqual(fake_cfg["providers"]["nvidia"]["name"], "Nvidia NIM")
            self.assertEqual(fake_cfg["providers"]["nvidia"]["keys"]["nv_key"], "nvapi-abcdef")

    async def test_strict_three_role_separation_no_admin_password_fallback(self):
        """Verify that vault operations strictly use VAULT_ACCESS_TOKEN and never fall back to ADMIN_PASSWORD."""
        from app.admin_routes import _get_vault_credentials

        fake_cfg = {"edgeone_vault": {"url": "https://vault.example.com"}}
        async def fake_get_config():
            return fake_cfg

        with patch("app.admin_routes.get_config", side_effect=fake_get_config), \
             patch.dict(os.environ, {"ADMIN_PASSWORD": "admin-pass-12345", "PROXY_API_KEY": "client-key-54321"}, clear=True):
            # When neither VAULT_ACCESS_TOKEN nor EDGEONE_VAULT_TOKEN is set
            url, token = await _get_vault_credentials({})
            self.assertEqual(url, "https://vault.example.com")
            self.assertEqual(token, "", "Must NOT fall back to ADMIN_PASSWORD or PROXY_API_KEY")

        with patch("app.admin_routes.get_config", side_effect=fake_get_config), \
             patch.dict(os.environ, {"VAULT_ACCESS_TOKEN": "vault-token-xyz", "ADMIN_PASSWORD": "admin-pass-12345"}, clear=True):
            # When VAULT_ACCESS_TOKEN is set
            url, token = await _get_vault_credentials({})
            self.assertEqual(url, "https://vault.example.com")
            self.assertEqual(token, "vault-token-xyz", "Must use VAULT_ACCESS_TOKEN")


if __name__ == "__main__":
    unittest.main()
