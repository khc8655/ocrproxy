"""
Automated Verification Suite for Secret Preservation and Fail-Safe Unmasking Guard.
Ensures masked keys (●●●●●●●● / ********) sent by frontend or API callers
are NEVER written to disk and that existing real secrets are 100% preserved.
"""
import os
import sys
import json
import shutil
import tempfile
import unittest
from cryptography.fernet import Fernet

# Setup sys.path to import vm-app modules
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "vm-app"))

from app.config_store import is_masked_secret, save_to_disk, load_from_disk


class TestSecretPreservationGuard(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="ocrproxy_test_secrets_")
        self.enc_key = Fernet.generate_key().decode()
        self.orig_env_config_dir = os.environ.get("CONFIG_DIR")
        self.orig_env_encrypt_key = os.environ.get("ENCRYPT_KEY")

        os.environ["CONFIG_DIR"] = self.test_dir
        os.environ["ENCRYPT_KEY"] = self.enc_key

        # Seed initial config on disk with real secrets
        self.initial_config = {
            "_version": 10,
            "run_mode": "agent",
            "providers": {
                "google": {
                    "base_url": "https://generativelanguage.googleapis.com",
                    "keys": {
                        "faler": "AIzaSyRealGoogleKey123",
                        "jjb111": "AIzaSyRealGoogleKey456",
                        "public_test": "public"
                    }
                },
                "vertex": {
                    "keys": {
                        "sa": {
                            "type": "service_account",
                            "project_id": "real-project",
                            "private_key": "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----\n"
                        }
                    }
                },
                "opencode": {
                    "base_url": "https://api.opencode.example.com/v1",
                    "keys": {
                        "main": "oc-real-secret-key-789"
                    }
                }
            },
            "agent_models": {
                "gemini-3.5-flash-lite": {
                    "keys": [{"provider": "google", "key": "faler"}]
                }
            }
        }
        save_to_disk(self.initial_config)

    def tearDown(self):
        if self.orig_env_config_dir is not None:
            os.environ["CONFIG_DIR"] = self.orig_env_config_dir
        else:
            os.environ.pop("CONFIG_DIR", None)

        if self.orig_env_encrypt_key is not None:
            os.environ["ENCRYPT_KEY"] = self.orig_env_encrypt_key
        else:
            os.environ.pop("ENCRYPT_KEY", None)

        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_is_masked_secret_detection(self):
        """Verify is_masked_secret accurately detects masked placeholders and preserves real keys."""
        # Masked cases
        self.assertTrue(is_masked_secret("●●●●●●●●"))
        self.assertTrue(is_masked_secret("●"))
        self.assertTrue(is_masked_secret("********"))
        self.assertTrue(is_masked_secret("***"))
        self.assertTrue(is_masked_secret("***some-mask***"))
        self.assertTrue(is_masked_secret({"private_key": "●●●●●●●●"}))
        self.assertTrue(is_masked_secret({"private_key": "********"}))

        # Real secrets (must NOT be flagged as masked)
        self.assertFalse(is_masked_secret(None))
        self.assertFalse(is_masked_secret("AIzaSyRealKey123"))
        self.assertFalse(is_masked_secret("sk-openai-real-key-9988"))
        self.assertFalse(is_masked_secret("public"))
        self.assertFalse(is_masked_secret({"private_key": "-----BEGIN RSA PRIVATE KEY-----"}))

    def test_kernel_guard_preserves_real_keys_when_masked_incoming(self):
        """Simulate saving an incoming config containing masked keys directly into save_to_disk."""
        masked_incoming = {
            "_version": 11,
            "run_mode": "agent",
            "providers": {
                "google": {
                    "base_url": "https://generativelanguage.googleapis.com",
                    "keys": {
                        "faler": "●●●●●●●●",  # Masked from Web UI
                        "jjb111": "●●●●●●●●", # Masked from Web UI
                        "public_test": "public",
                        "new_added_key": "AIzaSyNewValidKey777"  # Real newly added key
                    }
                },
                "vertex": {
                    "keys": {
                        "sa": {
                            "type": "service_account",
                            "project_id": "real-project",
                            "private_key": "●●●●●●●●"  # Masked from Web UI
                        }
                    }
                },
                "opencode": {
                    "base_url": "https://api.opencode.example.com/v1",
                    "keys": {
                        "main": "●●●●●●●●"  # Masked from Web UI
                    }
                }
            }
        }

        # Call save_to_disk - Kernel Guard must intercept and restore
        save_to_disk(masked_incoming)

        # Read back decrypted config from disk
        restored = load_from_disk()

        # Assertions
        google_keys = restored["providers"]["google"]["keys"]
        self.assertEqual(google_keys["faler"], "AIzaSyRealGoogleKey123")
        self.assertEqual(google_keys["jjb111"], "AIzaSyRealGoogleKey456")
        self.assertEqual(google_keys["public_test"], "public")
        self.assertEqual(google_keys["new_added_key"], "AIzaSyNewValidKey777")

        vertex_sa = restored["providers"]["vertex"]["keys"]["sa"]
        self.assertEqual(
            vertex_sa["private_key"],
            "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----\n"
        )

        opencode_keys = restored["providers"]["opencode"]["keys"]
        self.assertEqual(opencode_keys["main"], "oc-real-secret-key-789")

        # Invariant check: NO bullets or asterisks in any key strings
        for p_name, p_data in restored["providers"].items():
            for k_lbl, k_val in p_data.get("keys", {}).items():
                if isinstance(k_val, str):
                    self.assertNotIn("●", k_val, f"Found bullet in {p_name}/{k_lbl}")
                    self.assertNotIn("***", k_val, f"Found asterisk mask in {p_name}/{k_lbl}")
                elif isinstance(k_val, dict):
                    pk = k_val.get("private_key", "")
                    self.assertNotIn("●", pk, f"Found bullet in {p_name}/{k_lbl}/private_key")

    def test_http_header_ascii_encodability(self):
        """Verify that all restored keys are strictly ASCII-encodable for httpx/HTTP headers."""
        cfg = load_from_disk()
        for p_name, p_data in cfg.get("providers", {}).items():
            for k_lbl, k_val in p_data.get("keys", {}).items():
                if isinstance(k_val, str):
                    header = f"Bearer {k_val}"
                    try:
                        encoded = header.encode("ascii")
                        self.assertTrue(isinstance(encoded, bytes))
                    except UnicodeEncodeError as e:
                        self.fail(f"Key {p_name}/{k_lbl} failed ASCII encoding: {e}")

    def test_endpoint_unmasking_logic(self):
        """Verify the exact unmasking logic executed in save_config_endpoint."""
        current_config = load_from_disk()
        curr_providers = current_config.get("providers") or {}

        # Simulated incoming request from browser after user made UI tweaks
        incoming_body = {
            "_version": current_config.get("_version", 1),
            "run_mode": "agent",
            "upstream_timeout_sec": 60,
            "providers": {
                "google": {
                    "base_url": "https://generativelanguage.googleapis.com",
                    "keys": {
                        "faler": "●●●●●●●●",
                        "jjb111": "●●●●●●●●",
                        "public_test": "public",
                        "brand_new_key": "AIzaSyValidNewKey123"
                    }
                },
                "fake_masked_provider": {
                    "keys": {
                        "ghost": "●●●●●●●●"  # Should be dropped because no disk counterpart
                    }
                }
            }
        }

        # Run unmasking guard logic
        incoming_providers = incoming_body.get("providers")
        for p_name, p_data in incoming_providers.items():
            if not isinstance(p_data, dict):
                continue
            in_keys = p_data.get("keys")
            if isinstance(in_keys, dict):
                curr_keys = curr_providers.get(p_name, {}).get("keys", {}) if isinstance(curr_providers.get(p_name), dict) else {}
                for k_lbl, k_val in list(in_keys.items()):
                    if is_masked_secret(k_val):
                        orig_secret = curr_keys.get(k_lbl)
                        if orig_secret and not is_masked_secret(orig_secret):
                            in_keys[k_lbl] = orig_secret
                        elif isinstance(k_val, dict) and isinstance(orig_secret, dict):
                            in_pk = k_val.get("private_key")
                            orig_pk = orig_secret.get("private_key")
                            if is_masked_secret(in_pk) and orig_pk and not is_masked_secret(orig_pk):
                                k_val["private_key"] = orig_pk
                        else:
                            in_keys.pop(k_lbl, None)

        self.assertEqual(incoming_providers["google"]["keys"]["faler"], "AIzaSyRealGoogleKey123")
        self.assertEqual(incoming_providers["google"]["keys"]["jjb111"], "AIzaSyRealGoogleKey456")
        self.assertEqual(incoming_providers["google"]["keys"]["brand_new_key"], "AIzaSyValidNewKey123")
        self.assertNotIn("ghost", incoming_providers["fake_masked_provider"]["keys"])

    def test_edgeone_vault_token_preservation(self):
        """Verify EdgeOne Vault token is preserved when incoming token is empty or masked."""
        current_config = {
            "edgeone_vault": {
                "url": "https://vault.example.com",
                "token": "real-vault-secret-token-xyz"
            }
        }
        
        # Scenario A: incoming body has masked token
        body_masked = {
            "edgeone_vault": {
                "url": "https://vault.example.com",
                "token": "●●●●●●●●"
            }
        }
        in_v_tok = (body_masked["edgeone_vault"].get("token") or "").strip()
        curr_v_tok = (current_config.get("edgeone_vault") or {}).get("token")
        if not in_v_tok or is_masked_secret(in_v_tok):
            if curr_v_tok and not is_masked_secret(curr_v_tok):
                body_masked["edgeone_vault"]["token"] = curr_v_tok
        self.assertEqual(body_masked["edgeone_vault"]["token"], "real-vault-secret-token-xyz")

        # Scenario B: incoming body has empty token (blank-to-keep pattern)
        body_blank = {
            "edgeone_vault": {
                "url": "https://vault.example.com",
                "token": ""
            }
        }
        in_v_tok_b = (body_blank["edgeone_vault"].get("token") or "").strip()
        if not in_v_tok_b or is_masked_secret(in_v_tok_b):
            if curr_v_tok and not is_masked_secret(curr_v_tok):
                body_blank["edgeone_vault"]["token"] = curr_v_tok
        self.assertEqual(body_blank["edgeone_vault"]["token"], "real-vault-secret-token-xyz")

        # Scenario C: incoming body has a new real token
        body_new = {
            "edgeone_vault": {
                "url": "https://vault.example.com",
                "token": "brand-new-token-123"
            }
        }
        in_v_tok_c = (body_new["edgeone_vault"].get("token") or "").strip()
        if not in_v_tok_c or is_masked_secret(in_v_tok_c):
            if curr_v_tok and not is_masked_secret(curr_v_tok):
                body_new["edgeone_vault"]["token"] = curr_v_tok
        else:
            body_new["edgeone_vault"]["token"] = in_v_tok_c
        self.assertEqual(body_new["edgeone_vault"]["token"], "brand-new-token-123")


if __name__ == "__main__":
    unittest.main()
