"""
Test suite for unified logging and secret redaction on VM.
"""
import unittest
import sys
import os

# Add vm-app to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "vm-app")))

from app.logger_utils import mask_secret, sanitize_meta, format_vm_log


class TestUnifiedVMLogging(unittest.TestCase):
    def test_mask_secret(self):
        # Empty / short
        self.assertEqual(mask_secret(None), "")
        self.assertEqual(mask_secret(""), "")
        self.assertEqual(mask_secret("123"), "****")
        self.assertEqual(mask_secret("12345678"), "****")

        # OpenAI style key
        sk_key = "sk-proj-1234567890abcdef1234"
        masked_sk = mask_secret(sk_key)
        self.assertTrue(masked_sk.startswith("sk-proj"))
        self.assertTrue(masked_sk.endswith("1234"))
        self.assertIn("****", masked_sk)
        self.assertNotIn("1234567890abcdef", masked_sk)

        # Standard token
        token = "secret_password_token_here"
        masked_token = mask_secret(token)
        self.assertEqual(masked_token, "secr****here")

    def test_sanitize_meta(self):
        meta = {
            "key": "sk-1234567890",
            "api_key": "my-secret-key",
            "password": "super-secret-admin-pass",
            "token": "bearer-token-val",
            "normal_field": "deepseek-chat",
            "bearer_header": "Bearer raw_token_secret",
            "long_body": "x" * 500,
        }
        clean = sanitize_meta(meta)
        self.assertEqual(clean["key"], "[REDACTED_SECRET]")
        self.assertEqual(clean["api_key"], "[REDACTED_SECRET]")
        self.assertEqual(clean["password"], "[REDACTED_SECRET]")
        self.assertEqual(clean["token"], "[REDACTED_SECRET]")
        self.assertEqual(clean["normal_field"], "deepseek-chat")
        self.assertEqual(clean["bearer_header"], "Bearer [REDACTED_SECRET]")
        self.assertTrue(clean["long_body"].endswith("[TRUNCATED]"))

    def test_format_vm_log(self):
        line = format_vm_log("AuthError", "Admin password invalid", {"ip": "1.2.3.4", "password": "pass"})
        self.assertTrue(line.startswith("[VM:AuthError] Admin password invalid |"))
        self.assertIn("ip=1.2.3.4", line)
        self.assertIn("password=[REDACTED_SECRET]", line)
        self.assertNotIn("pass=", line)


if __name__ == "__main__":
    unittest.main()
