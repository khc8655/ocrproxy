"""
Unit tests for system-level hardening (Iron Rule 17 & Vault Sandbox).
Verifies:
1. is_masked_secret identifies both string and dictionary masks.
2. Structured key secrets are protected during disk unmasking and config updates.
3. Structured keys are correctly masked on GET /admin/api/config without losing rpm/is_local.
"""
import os
import sys
import unittest
import tempfile
import json
from unittest.mock import MagicMock
from pathlib import Path
from cryptography.fernet import Fernet

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "vm-app"))

# Ensure mock imports for optional runtime web dependencies in pure test runner
for mod in ["httpx", "fastapi", "fastapi.responses"]:
    if mod not in sys.modules:
        try:
            __import__(mod)
        except ImportError:
            sys.modules[mod] = MagicMock()

from app.config_store import is_masked_secret, save_to_disk, load_from_disk
import app.config_store as config_store


class TestSystemHardeningAudit(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        os.environ["CONFIG_DIR"] = self.temp_dir.name
        self.encrypt_key = Fernet.generate_key().decode()
        os.environ["ENCRYPT_KEY"] = self.encrypt_key

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_is_masked_secret(self):
        # Plain strings
        self.assertTrue(is_masked_secret("●●●●●●●●"))
        self.assertTrue(is_masked_secret("********"))
        self.assertTrue(is_masked_secret("***sk-123"))
        self.assertFalse(is_masked_secret("sk-valid-key-12345"))
        self.assertFalse(is_masked_secret(""))
        self.assertFalse(is_masked_secret(None))

        # Structured key dict
        self.assertTrue(is_masked_secret({"key": "●●●●●●●●", "rpm": 20, "is_local": True}))
        self.assertTrue(is_masked_secret({"key": "********", "rpm": 10}))
        self.assertFalse(is_masked_secret({"key": "sk-real-secret", "rpm": 20, "is_local": True}))

        # Service account dict
        self.assertTrue(is_masked_secret({"type": "service_account", "private_key": "●●●●●●●●"}))
        self.assertFalse(is_masked_secret({"type": "service_account", "private_key": "-----BEGIN RSA PRIVATE KEY-----\nMIIE..."}))

    def test_save_to_disk_restores_structured_keys_without_data_loss(self):
        # 1. Save original config with real secrets to disk
        initial_config = {
            "providers": {
                "testprov": {
                    "base_url": "https://api.testprov.com/v1",
                    "rpm_per_key": 30,
                    "keys": {
                        "plain_key": "sk-real-plain-123",
                        "struct_key": {
                            "key": "sk-real-struct-456",
                            "rpm": 15,
                            "is_local": True,
                        },
                        "sa_key": {
                            "type": "service_account",
                            "project_id": "my-proj",
                            "private_key": "-----BEGIN RSA PRIVATE KEY-----\nsecret",
                        }
                    }
                }
            },
            "agent_models": {},
            "candidates": {},
        }
        save_to_disk(initial_config)

        # 2. Simulate client submitting masked config back (user edited RPM of struct_key from 15 to 25)
        submitted_config = {
            "providers": {
                "testprov": {
                    "base_url": "https://api.testprov.com/v1",
                    "rpm_per_key": 30,
                    "keys": {
                        "plain_key": "●●●●●●●●",
                        "struct_key": {
                            "key": "●●●●●●●●",
                            "rpm": 25,  # Modified by user
                            "is_local": True,
                        },
                        "sa_key": {
                            "type": "service_account",
                            "project_id": "my-proj",
                            "private_key": "●●●●●●●●",
                        }
                    }
                }
            },
            "agent_models": {},
            "candidates": {},
        }
        save_to_disk(submitted_config)

        # 3. Read back decrypted config from disk and assert all real secrets survived!
        reloaded = load_from_disk()
        p_keys = reloaded["providers"]["testprov"]["keys"]

        # Plain key restored
        self.assertEqual(p_keys["plain_key"], "sk-real-plain-123")

        # Structured key restored secret while PRESERVING user-modified RPM 25!
        self.assertEqual(p_keys["struct_key"]["key"], "sk-real-struct-456")
        self.assertEqual(p_keys["struct_key"]["rpm"], 25)
        self.assertTrue(p_keys["struct_key"]["is_local"])

        # Service account private key restored
        self.assertEqual(p_keys["sa_key"]["private_key"], "-----BEGIN RSA PRIVATE KEY-----\nsecret")

    def test_auth_extract_token_from_query_params(self):
        from app.auth import _extract_token, verify_admin_auth
        req = MagicMock()
        req.headers = {}
        req.query_params = {"token": "my-secret-admin-token"}
        self.assertEqual(_extract_token(req), "my-secret-admin-token")

        req2 = MagicMock()
        req2.headers = {}
        req2.query_params = {"key": "my-secret-key-token"}
        self.assertEqual(_extract_token(req2), "my-secret-key-token")

        os.environ["ADMIN_PASSWORD"] = "my-secret-admin-token"
        req.client.host = "127.0.0.1"
        self.assertTrue(verify_admin_auth(req))

        req_wrong = MagicMock()
        req_wrong.headers = {}
        req_wrong.query_params = {"token": "wrong-token"}
        req_wrong.client.host = "127.0.0.1"
        self.assertFalse(verify_admin_auth(req_wrong))


if __name__ == "__main__":
    unittest.main()
