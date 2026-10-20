"""tests/test_api_layer.py

Layer 2 API Integration Tests:
Tests FastAPI backend routes for configuration persistence, provider deletion,
cascading model deletion, and tombstone tracking.
Strictly sends real HTTP requests against the FastAPI app via httpx ASGITransport.
"""
import os
import sys
import tempfile
import os
import sys
import tempfile
import shutil
import httpx

# Ensure vm-app directory is in sys.path
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VM_APP_DIR = os.path.join(REPO_ROOT, "vm-app")
if VM_APP_DIR not in sys.path:
    sys.path.insert(0, VM_APP_DIR)


async def test_auth_protection():
    """Layer 2: Verify endpoint authentication (401 without auth, 200 with Bearer)."""
    from app.main import app
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        # Without auth header
        res_no_auth = await client.get("/api/config")
        assert res_no_auth.status_code == 401, f"Expected 401 without auth, got {res_no_auth.status_code}"

        # With correct auth header
        headers = {"Authorization": "Bearer test_admin_pass_123"}
        res_auth = await client.get("/api/config", headers=headers)
        assert res_auth.status_code == 200, f"Expected 200 with auth, got {res_auth.status_code}"


async def test_provider_deletion_and_model_cascade():
    """Layer 2: Verify provider deletion cascades to models and records tombstones without 403."""
    from app.main import app
    transport = httpx.ASGITransport(app=app)
    headers = {"Authorization": "Bearer test_admin_pass_123"}

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        # 1. Setup initial config with 2 providers (one vault, one local) and 3 models
        initial_payload = {
            "providers": {
                "prov_vault": {
                    "name": "Vault Provider",
                    "origin": "vault",
                    "base_url": "https://vault.example.com/v1",
                    "keys": {
                        "vk1": {"key": "sk-vault-key-1", "origin": "vault"},
                        "vk2": {"key": "sk-vault-key-2", "origin": "vault"}
                    }
                },
                "prov_local": {
                    "name": "Local Provider",
                    "origin": "local",
                    "base_url": "https://local.example.com/v1",
                    "keys": {
                        "lk1": {"key": "sk-local-key-1"}
                    }
                }
            },
            "agent_models": {
                "model_only_vault": {
                    "keys": [{"provider": "prov_vault", "key": "vk1"}]
                },
                "model_hybrid": {
                    "keys": [
                        {"provider": "prov_vault", "key": "vk2"},
                        {"provider": "prov_local", "key": "lk1"}
                    ]
                },
                "model_only_local": {
                    "keys": [{"provider": "prov_local", "key": "lk1"}]
                }
            },
            "candidates": {
                "chat": [
                    {"provider": "prov_vault", "key": "vk1", "model": "gpt-4"},
                    {"provider": "prov_local", "key": "lk1", "model": "qwen"}
                ]
            }
        }

        res_save = await client.post("/api/admin/config", headers=headers, json=initial_payload)
        assert res_save.status_code == 200, f"Initial save failed: {res_save.text}"

        # Verify initial config saved
        res_get = await client.get("/api/config", headers=headers)
        cfg1 = res_get.json()
        assert "prov_vault" in cfg1.get("providers", {})
        assert "model_only_vault" in cfg1.get("agent_models", {})
        assert "model_hybrid" in cfg1.get("agent_models", {})

        # 2. Delete prov_vault (even though origin=vault, it MUST succeed with 200 OK!)
        del cfg1["providers"]["prov_vault"]
        # Client may or may not filter models; backend MUST enforce cascade!
        res_delete = await client.post("/api/admin/config", headers=headers, json=cfg1)
        assert res_delete.status_code == 200, f"Provider deletion was blocked with status {res_delete.status_code}: {res_delete.text}"

        # 3. Verify backend cascade deletion and tombstones
        res_verify = await client.get("/api/config", headers=headers)
        cfg2 = res_verify.json()

        # Provider deleted
        assert "prov_vault" not in cfg2.get("providers", {}), "prov_vault should be deleted"
        assert "prov_local" in cfg2.get("providers", {}), "prov_local should remain"

        # Model cascade: model_only_vault had only prov_vault keys, so it MUST be completely deleted!
        models2 = cfg2.get("agent_models", {})
        assert "model_only_vault" not in models2, "model_only_vault had no remaining keys and MUST be deleted"

        # Model cascade: model_hybrid should still exist, but without the prov_vault key
        assert "model_hybrid" in models2, "model_hybrid should still exist with prov_local key"
        hybrid_keys = models2["model_hybrid"].get("keys", [])
        assert len(hybrid_keys) == 1, f"Expected 1 remaining key in model_hybrid, found {len(hybrid_keys)}"
        assert hybrid_keys[0]["provider"] == "prov_local"

        # Candidates cascade: candidate with prov_vault should be cleaned up
        chat_candidates = cfg2.get("candidates", {}).get("chat", [])
        assert len(chat_candidates) == 1, f"Expected 1 remaining candidate, found {len(chat_candidates)}"
        assert chat_candidates[0]["provider"] == "prov_local"

        # Tombstones: prov_vault MUST be recorded in tombstones
        tombstones = cfg2.get("tombstones", [])
        assert "prov_vault" in tombstones, f"prov_vault should be in tombstones: {tombstones}"


async def test_readding_provider_clears_tombstone():
    """Layer 2: Verify re-adding a previously deleted provider removes it from tombstones."""
    from app.main import app
    transport = httpx.ASGITransport(app=app)
    headers = {"Authorization": "Bearer test_admin_pass_123"}

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        # Save with prov_a
        await client.post("/api/admin/config", headers=headers, json={
            "providers": {"prov_a": {"name": "A", "base_url": "https://a.com", "keys": {"k1": "sk-1"}}}
        })
        # Delete prov_a -> tombstones has prov_a
        await client.post("/api/admin/config", headers=headers, json={"providers": {}})
        res = await client.get("/api/config", headers=headers)
        assert "prov_a" in res.json().get("tombstones", [])

        # Re-add prov_a -> tombstones should no longer have prov_a
        await client.post("/api/admin/config", headers=headers, json={
            "providers": {"prov_a": {"name": "A", "base_url": "https://a.com", "keys": {"k1": "sk-1"}}}
        })
        res2 = await client.get("/api/config", headers=headers)
        assert "prov_a" not in res2.json().get("tombstones", []), "Re-added provider must be cleared from tombstones"


async def test_vault_provider_import_keeps_local_keys():
    """Layer 2: whole-provider import from the EdgeOne vault (fetch-key without key_label)
    pulls all cloud keys, never overwrites a same-name key the user created locally,
    and clears the provider/key tombstones of what it imported."""
    import types
    from app.main import app
    import app.admin_routes as ar

    seen = {}
    def handler(req):
        import json as _j
        seen["body"] = _j.loads(req.content or b"{}")
        return httpx.Response(200, json={"ok": True, "provider": "prov_v", "provider_config": {
            "name": "V", "protocol": "openai", "base_url": "https://v.example.com/v1",
            "keys": {"shared": "sk-cloud-shared", "cloud_only": "sk-cloud-only"}}})
    real_client = httpx.AsyncClient
    shim = types.SimpleNamespace(**{k: getattr(httpx, k) for k in dir(httpx) if not k.startswith("__")})
    shim.AsyncClient = lambda *a, **kw: real_client(transport=httpx.MockTransport(handler), **{k: v for k, v in kw.items() if k != "transport"})
    orig = ar.httpx
    ar.httpx = shim
    transport = httpx.ASGITransport(app=app)
    headers = {"Authorization": "Bearer test_admin_pass_123"}
    try:
        async with real_client(transport=transport, base_url="http://testserver") as client:
            r = await client.post("/api/admin/config", headers=headers, json={
                "edgeone_vault": {"edgeone_url": "https://hub.example.com", "token": "t"},
                "providers": {"prov_v": {"name": "V", "base_url": "https://v.example.com/v1",
                                         "keys": {"shared": {"key": "sk-my-local", "is_local": True}}}},
            })
            assert r.status_code == 200, r.text
            cur = (await client.get("/api/config", headers=headers)).json()
            cur = cur.get("config", cur)
            cur["tombstones"] = ["prov_v"]
            cur["tombstone_keys"] = ["prov_v:cloud_only"]
            from app.config_store import save_config
            await save_config(cur)

            r = await client.post("/api/admin/vault/fetch-key", headers=headers, json={"provider": "prov_v"})
            assert r.status_code == 200 and r.json().get("ok"), r.text
            assert "key_label" not in seen["body"], f"whole-provider import must not send key_label: {seen['body']}"

            from app.config_store import get_config
            cfg = await get_config()
            keys = cfg["providers"]["prov_v"]["keys"]
            shared = keys["shared"]
            assert isinstance(shared, dict) and shared.get("key") == "sk-my-local", f"local key overwritten: {shared}"
            assert keys.get("cloud_only") == "sk-cloud-only", keys
            assert "prov_v" not in (cfg.get("tombstones") or []), cfg.get("tombstones")
            assert "prov_v:cloud_only" not in (cfg.get("tombstone_keys") or []), cfg.get("tombstone_keys")
    finally:
        ar.httpx = orig


async def _run_all_tests():
    print("=== Running Layer 2 API Integration Tests ===")
    temp_dir = tempfile.mkdtemp(prefix="ocrprox_api_test_")
    old_cfg_dir = os.environ.get("CONFIG_DIR")
    old_admin_pw = os.environ.get("ADMIN_PASSWORD")
    old_proxy_key = os.environ.get("PROXY_API_KEY")

    from cryptography.fernet import Fernet
    old_enc_key = os.environ.get("ENCRYPT_KEY")
    os.environ["ENCRYPT_KEY"] = Fernet.generate_key().decode()
    os.environ["CONFIG_DIR"] = temp_dir
    os.environ["ADMIN_PASSWORD"] = "test_admin_pass_123"
    os.environ["PROXY_API_KEY"] = "sk-test-proxy-key"
    from app.config_store import clear_cache, save_to_disk
    save_to_disk({"providers": {}, "agent_models": {}, "candidates": {"chat": [], "embedding": [], "reranker": [], "ocr": []}})
    clear_cache()
    try:
        print("  -> test_auth_protection...")
        await test_auth_protection()
        print("     PASS: test_auth_protection")

        print("  -> test_provider_deletion_and_model_cascade...")
        await test_provider_deletion_and_model_cascade()
        print("     PASS: test_provider_deletion_and_model_cascade")

        print("  -> test_readding_provider_clears_tombstone...")
        await test_readding_provider_clears_tombstone()
        print("     PASS: test_readding_provider_clears_tombstone")

        print("  -> test_vault_provider_import_keeps_local_keys...")
        await test_vault_provider_import_keeps_local_keys()
        print("     PASS: test_vault_provider_import_keeps_local_keys")
        print("=== ALL LAYER 2 API TESTS PASSED! ===")
    finally:
        if old_cfg_dir:
            os.environ["CONFIG_DIR"] = old_cfg_dir
        else:
            os.environ.pop("CONFIG_DIR", None)
        if old_admin_pw:
            os.environ["ADMIN_PASSWORD"] = old_admin_pw
        else:
            os.environ.pop("ADMIN_PASSWORD", None)
        if old_proxy_key:
            os.environ["PROXY_API_KEY"] = old_proxy_key
        else:
            os.environ.pop("PROXY_API_KEY", None)
        if old_enc_key:
            os.environ["ENCRYPT_KEY"] = old_enc_key
        else:
            os.environ.pop("ENCRYPT_KEY", None)
        clear_cache()
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    import asyncio
    asyncio.run(_run_all_tests())
