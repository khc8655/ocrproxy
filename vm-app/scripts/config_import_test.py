#!/usr/bin/env python3
"""
Test suite for configuration import and export endpoints.
Verifies auth isolation, export payload integrity, overwrite import,
merge import, payload validation, and snapshot backups.
"""
import os
import sys
import json
import time
import shutil
import tempfile
import asyncio
from cryptography.fernet import Fernet

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Set up test environment
TMP_DIR = tempfile.mkdtemp(prefix="ocrproxy_import_test_")
os.environ["CONFIG_DIR"] = os.path.join(TMP_DIR, "config")
os.environ["ENCRYPT_KEY"] = Fernet.generate_key().decode()
os.environ["ADMIN_PASSWORD"] = "test_admin_secret_123"
os.environ["PROXY_API_KEY"] = "test_proxy_key_456"

from httpx import AsyncClient, ASGITransport
from app.main import app
from app.config_store import save_config, get_config, clear_cache


SAMPLE_CONFIG = {
    "providers": {
        "provA": {
            "base_url": "https://api.prov-a.com",
            "keys": {"k1": "sk-provA-k1", "k2": "sk-provA-k2"}
        },
        "provB": {
            "base_url": "https://api.prov-b.com",
            "keys": {"primary": "sk-provB-primary"}
        }
    },
    "candidates": {
        "chat": [{"provider": "provA", "key": "k1", "model": "model-a"}],
        "embedding": [{"provider": "provB", "key": "primary", "model": "emb-b"}],
        "reranker": [],
        "ocr": []
    },
    "agent_models": {
        "gpt-test": {
            "keys": [{"provider": "provA", "key": "k1"}, {"provider": "provA", "key": "k2"}],
            "upstream_model": "gpt-test-real"
        }
    },
    "upstream_timeout": 15,
    "schedule_total_budget": 30
}


async def run_tests():
    print("=" * 60)
    print("  OCRProxy Config Import & Export Test Suite")
    print("=" * 60)

    # Initialize disk with sample config
    await save_config(SAMPLE_CONFIG)
    clear_cache()

    transport = ASGITransport(app=app)
    admin_auth = {"Authorization": f"Bearer {os.environ['ADMIN_PASSWORD']}"}
    proxy_auth = {"Authorization": f"Bearer {os.environ['PROXY_API_KEY']}"}

    async with AsyncClient(transport=transport, base_url="http://test") as client:

        # ── Test 1: Auth Isolation for Export ────────────────────
        print("\n[1] Testing Auth Isolation for Export...")
        r_anon = await client.get("/api/admin/config/export")
        assert r_anon.status_code == 401, f"Expected 401, got {r_anon.status_code}"
        r_proxy = await client.get("/api/admin/config/export", headers=proxy_auth)
        assert r_proxy.status_code == 401, f"Expected 401 for PROXY_KEY, got {r_proxy.status_code}"
        print("  [PASS] Unauthenticated and PROXY_KEY requests correctly rejected (401)")

        # ── Test 2: Config Export ─────────────────────────────────
        print("\n[2] Testing Config Export...")
        r_exp = await client.get("/api/admin/config/export", headers=admin_auth)
        assert r_exp.status_code == 200, f"Expected 200, got {r_exp.status_code}"
        assert "attachment" in r_exp.headers.get("content-disposition", "")
        export_data = r_exp.json()
        assert "_exported_at" in export_data
        assert export_data["_version"] == "3.3"
        assert "provA" in export_data["providers"]
        assert export_data["providers"]["provA"]["keys"]["k1"] == "sk-provA-k1"
        assert "gpt-test" in export_data["agent_models"]
        print(f"  [PASS] Config successfully exported: {len(export_data['providers'])} providers, {len(export_data['agent_models'])} agent models")

        # ── Test 3: Auth Isolation for Import ────────────────────
        print("\n[3] Testing Auth Isolation for Import...")
        r_imp_anon = await client.post("/api/admin/config/import", json={"mode": "overwrite", "config": SAMPLE_CONFIG})
        assert r_imp_anon.status_code == 401, f"Expected 401, got {r_imp_anon.status_code}"
        r_imp_proxy = await client.post("/api/admin/config/import", headers=proxy_auth, json={"mode": "overwrite", "config": SAMPLE_CONFIG})
        assert r_imp_proxy.status_code == 401, f"Expected 401 for PROXY_KEY, got {r_imp_proxy.status_code}"
        print("  [PASS] Unauthenticated and PROXY_KEY import requests correctly rejected (401)")

        # ── Test 4: Overwrite Import ─────────────────────────────
        print("\n[4] Testing Overwrite Import...")
        new_config = {
            "providers": {
                "provC": {
                    "base_url": "https://api.prov-c.com",
                    "keys": {"k_new": "sk-provC-new"}
                }
            },
            "candidates": {
                "chat": [{"provider": "provC", "key": "k_new", "model": "model-c"}],
                "embedding": [],
                "reranker": [],
                "ocr": []
            },
            "agent_models": {
                "model-c": {"keys": [{"provider": "provC", "key": "k_new"}]}
            },
            "upstream_timeout": 25
        }
        r_imp = await client.post("/api/admin/config/import", headers=admin_auth, json={
            "mode": "overwrite",
            "config": new_config
        })
        assert r_imp.status_code == 200, f"Expected 200, got {r_imp.status_code}: {r_imp.text}"
        resp_json = r_imp.json()
        assert resp_json["success"] is True
        assert resp_json["summary"]["providers_count"] == 1
        assert resp_json["summary"]["total_keys"] == 1

        # Verify config in store
        cur = await get_config()
        assert "provC" in cur["providers"]
        assert "provA" not in cur["providers"], "Overwrite should replace old providers"
        assert cur["upstream_timeout"] == 25
        print("  [PASS] Overwrite import successfully replaced all configuration")

        # ── Test 5: Merge Import ─────────────────────────────────
        print("\n[5] Testing Merge Import...")
        merge_incoming = {
            "providers": {
                "provC": {
                    "keys": {"k_extra": "sk-provC-extra"}
                },
                "provD": {
                    "base_url": "https://api.prov-d.com",
                    "keys": {"k_d1": "sk-provD-1"}
                }
            },
            "candidates": {
                "chat": [{"provider": "provD", "key": "k_d1", "model": "model-d"}],
                "embedding": [],
                "reranker": [],
                "ocr": []
            },
            "agent_models": {
                "model-d": {"keys": [{"provider": "provD", "key": "k_d1"}]}
            },
            "upstream_timeout_ocr": 80
        }
        r_merge = await client.post("/api/admin/config/import", headers=admin_auth, json={
            "mode": "merge",
            "config": merge_incoming
        })
        assert r_merge.status_code == 200, f"Expected 200, got {r_merge.status_code}: {r_merge.text}"
        merge_resp = r_merge.json()
        assert merge_resp["summary"]["providers_count"] == 2  # provC + provD
        assert merge_resp["summary"]["total_keys"] == 3       # k_new + k_extra + k_d1

        cur_after_merge = await get_config()
        assert "provC" in cur_after_merge["providers"]
        assert "provD" in cur_after_merge["providers"]
        assert "k_new" in cur_after_merge["providers"]["provC"]["keys"]
        assert "k_extra" in cur_after_merge["providers"]["provC"]["keys"]
        assert "model-c" in cur_after_merge["agent_models"]
        assert "model-d" in cur_after_merge["agent_models"]
        assert len(cur_after_merge["candidates"]["chat"]) == 2  # model-c + model-d
        assert cur_after_merge["upstream_timeout_ocr"] == 80
        print("  [PASS] Merge import successfully combined new providers, keys, and candidates")

        # ── Test 6: Invalid Payloads & Validation ────────────────
        print("\n[6] Testing Payload Validation & Rejection...")
        # (a) Missing config
        r_bad1 = await client.post("/api/admin/config/import", headers=admin_auth, json={"mode": "overwrite"})
        assert r_bad1.status_code == 400

        # (b) Invalid mode
        r_bad2 = await client.post("/api/admin/config/import", headers=admin_auth, json={"mode": "delete_all", "config": {}})
        assert r_bad2.status_code == 400

        # (c) Missing providers/candidates structure
        r_bad3 = await client.post("/api/admin/config/import", headers=admin_auth, json={"mode": "overwrite", "config": {"hello": "world"}})
        assert r_bad3.status_code == 400

        # (d) Large payload check
        r_bad4 = await client.post(
            "/api/admin/config/import",
            headers={**admin_auth, "Content-Length": str(3 * 1024 * 1024)},
            content=b"large"
        )
        assert r_bad4.status_code == 413
        print("  [PASS] Invalid payloads, modes, and oversized requests correctly rejected (400/413)")

        # ── Test 7: Snapshot Backup Verification ─────────────────
        print("\n[7] Verifying Snapshot Backup Creation...")
        config_dir = os.environ["CONFIG_DIR"]
        bak_files = [f for f in os.listdir(config_dir) if "proxy_config.enc.bak-" in f]
        assert len(bak_files) >= 1, f"Expected at least 1 backup file, found {bak_files}"
        print(f"  [PASS] Pre-import snapshot backups created: {bak_files}")

    print("\n" + "=" * 60)
    print("  ALL 7 CONFIG IMPORT/EXPORT TESTS PASSED!")
    print("=" * 60)


if __name__ == "__main__":
    try:
        asyncio.run(run_tests())
    finally:
        shutil.rmtree(TMP_DIR, ignore_errors=True)
