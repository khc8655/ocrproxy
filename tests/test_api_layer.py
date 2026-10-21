"""tests/test_api_layer.py

Layer 2 API Integration Tests:
Tests FastAPI backend routes for configuration persistence, provider deletion,
cascading model deletion, and the one-shot vault pull rules.
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
    """Layer 2: Verify provider deletion cascades to models and without 403 and without tombstones."""
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

        # Tombstones are gone: deleting is just deleting
        assert not cfg2.get("tombstones"), f"tombstones must no longer be written: {cfg2.get('tombstones')}"


def _mock_vault(handler):
    """Patch app.admin_routes.httpx so outgoing vault calls hit a MockTransport."""
    import types
    import app.admin_routes as ar
    real_client = httpx.AsyncClient
    shim = types.SimpleNamespace(**{k: getattr(httpx, k) for k in dir(httpx) if not k.startswith("__")})
    shim.AsyncClient = lambda *a, **kw: real_client(transport=httpx.MockTransport(handler),
                                                     **{k: v for k, v in kw.items() if k != "transport"})
    orig = ar.httpx
    ar.httpx = shim
    return lambda: setattr(ar, "httpx", orig)


async def test_vault_pull_once_rules_only_sync():
    """Layer 2: VM vault rules.
    1. 「新增供应商」整体拉取：规则 + 全部 Key 落地，Key 标记 origin=vault；本地已存在则 409。
    2. 中枢 Key 只读（改值被后端还原）但可删；自加 Key 为 origin=local。
    3. 「同步中枢规则」只更新 origin=vault 供应商的规则，不拉 Key（删掉的不回来、新增的不下来），
       不碰本地自建的同名供应商。
    """
    import json as _j
    from app.main import app
    calls = []
    hub = {"base_url": "https://v1.example.com/v1", "keys": {"k1": "sk-hub-1", "k2": {"key": "sk-hub-2"}}}

    def handler(req):
        calls.append(req.url.path)
        if req.url.path.endswith("/api/vault/fetch"):
            body = _j.loads(req.content or b"{}")
            assert "key_label" not in body, body
            return httpx.Response(200, json={"ok": True, "provider": body["provider"], "provider_config": {
                "name": "Hub P", "protocol": "openai", "base_url": hub["base_url"],
                "adapter_rules": {"v": 1}, "keys": hub["keys"]}})
        if req.url.path.endswith("/api/vault/manifest"):
            return httpx.Response(200, json={"ok": True, "providers": {
                "hub_p": {"name": "Hub P", "base_url": "https://v2.example.com/v1", "protocol": "openai",
                          "adapter_rules": {"v": 2}, "keys": ["k1", "k2", "k3_new"]},
                "mine": {"name": "Mine on hub", "base_url": "https://hub-mine.example.com", "keys": ["x"]}}})
        return httpx.Response(404)

    restore = _mock_vault(handler)
    transport = httpx.ASGITransport(app=app)
    H = {"Authorization": "Bearer test_admin_pass_123"}
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            r = await c.post("/api/admin/config", headers=H, json={
                "edgeone_vault": {"edgeone_url": "https://hub.example.com", "token": "t"},
                "providers": {"mine": {"name": "Mine", "origin": "local", "base_url": "https://mine.example.com",
                                       "keys": {"m1": {"key": "sk-m1", "origin": "local", "is_local": True}}}},
                "agent_models": {}})
            assert r.status_code == 200, r.text

            # 1. pull
            r = await c.post("/api/admin/vault/fetch-key", headers=H, json={"provider": "hub_p"})
            assert r.status_code == 200 and r.json().get("key_count") == 2, r.text
            from app.config_store import get_config
            cfg = await get_config()
            p = cfg["providers"]["hub_p"]
            assert p["origin"] == "vault" and p["base_url"] == "https://v1.example.com/v1"
            assert all(isinstance(v, dict) and v["origin"] == "vault" and v["is_local"] is False
                       for v in p["keys"].values()), p["keys"]
            assert p["keys"]["k1"]["key"] == "sk-hub-1" and p["keys"]["k2"]["key"] == "sk-hub-2"
            r = await c.post("/api/admin/vault/fetch-key", headers=H, json={"provider": "HUB_P"})
            assert r.status_code == 409, r.text

            # 2. vault key read-only but deletable; user key local
            cur = (await c.get("/api/config", headers=H)).json()
            cur = cur.get("config", cur)
            cur["providers"]["hub_p"]["keys"]["k1"] = {"key": "sk-tampered", "origin": "local", "is_local": True}
            cur["providers"]["hub_p"]["keys"].pop("k2")
            cur["providers"]["hub_p"]["keys"]["mykey"] = {"key": "sk-mine", "origin": "local", "is_local": True}
            r = await c.post("/api/admin/config", headers=H, json=cur)
            assert r.status_code == 200, r.text
            keys = (await get_config())["providers"]["hub_p"]["keys"]
            assert keys["k1"]["key"] == "sk-hub-1" and keys["k1"]["origin"] == "vault", "vault key value must stay"
            assert "k2" not in keys, "vault key must be deletable"
            assert keys["mykey"]["origin"] == "local"

            # 3. sync = rules only
            calls.clear()
            r = await c.post("/api/admin/vault/sync", headers=H, json={})
            assert r.status_code == 200 and r.json().get("ok"), r.text
            assert not any(x.endswith("/api/vault/fetch") for x in calls), f"sync must not pull keys: {calls}"
            cfg = await get_config()
            p = cfg["providers"]["hub_p"]
            assert p["base_url"] == "https://v2.example.com/v1" and p["adapter_rules"] == {"v": 2}
            assert set(p["keys"]) == {"k1", "mykey"}, f"sync must not add/restore keys: {set(p['keys'])}"
            assert cfg["providers"]["mine"]["base_url"] == "https://mine.example.com", "local same-name provider untouched"
            assert cfg["providers"]["mine"]["origin"] == "local"
            assert not cfg.get("tombstones") and not cfg.get("tombstone_keys")

            # delete provider -> can pull again
            cur = (await c.get("/api/config", headers=H)).json()
            cur = cur.get("config", cur)
            cur["providers"].pop("hub_p")
            assert (await c.post("/api/admin/config", headers=H, json=cur)).status_code == 200
            r = await c.post("/api/admin/vault/fetch-key", headers=H, json={"provider": "hub_p"})
            assert r.status_code == 200, r.text
            assert set((await get_config())["providers"]["hub_p"]["keys"]) == {"k1", "k2"}
    finally:
        restore()


async def test_vault_add_keys_explicit():
    """Layer 2: 「+ Key → 从中枢添加」：给已拉取的中枢供应商显式补拉选中的 Key。
    只新增不覆盖、不碰规则和已有绑定；本地自建供应商不允许；中枢没有的 label 报 missing。
    """
    import json as _j
    from app.main import app
    hub_keys = {"k1": "sk-q1", "k2": "sk-q2"}
    fetch_bodies = []

    def handler(req):
        if req.url.path.endswith("/api/vault/fetch"):
            body = _j.loads(req.content or b"{}")
            fetch_bodies.append(body)
            want = body.get("keys") or list(hub_keys)
            got = {k: hub_keys[k] for k in want if k in hub_keys}
            if body.get("credentials_only"):
                return httpx.Response(200, json={"ok": True, "provider": body["provider"], "keys": got})
            return httpx.Response(200, json={"ok": True, "provider": body["provider"], "provider_config": {
                "name": "Hub Q", "protocol": "openai", "base_url": "https://q.example.com/v1", "keys": got}})
        return httpx.Response(404)

    restore = _mock_vault(handler)
    transport = httpx.ASGITransport(app=app)
    H = {"Authorization": "Bearer test_admin_pass_123"}
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            from app.config_store import get_config
            r = await c.post("/api/admin/vault/fetch-key", headers=H, json={"provider": "hub_q"})
            assert r.status_code == 200, r.text

            # bind k1 into KB + Agent, delete k2, add a local key
            cur = (await c.get("/api/config", headers=H)).json()
            cur = cur.get("config", cur)
            cur["edgeone_vault"] = {"edgeone_url": "https://hub.example.com", "token": "t"}
            cur["providers"]["hub_q"]["keys"].pop("k2")
            cur["providers"]["hub_q"]["keys"]["mykey"] = {"key": "sk-mine", "origin": "local", "is_local": True}
            cur.setdefault("candidates", {}).setdefault("chat", []).append(
                {"provider": "hub_q", "key": "k1", "model": "m-q", "enabled": True})
            cur.setdefault("agent_models", {})["agent-q"] = {"keys": [{"provider": "hub_q", "key": "k1", "model": "m-q"}]}
            assert (await c.post("/api/admin/config", headers=H, json=cur)).status_code == 200

            # hub gains k3
            hub_keys["k3"] = {"key": "sk-q3"}
            fetch_bodies.clear()
            r = await c.post("/api/admin/vault/add-keys", headers=H,
                             json={"provider": "hub_q", "keys": ["k3", "k1", "mykey", "ghost"]})
            assert r.status_code == 200, r.text
            d = r.json()
            assert d["added"] == ["k3"] and set(d["skipped"]) == {"k1", "mykey"} and d["missing"] == ["ghost"], d
            assert fetch_bodies and set(fetch_bodies[-1]["keys"]) == {"k3", "ghost"}, fetch_bodies
            cfg = await get_config()
            keys = cfg["providers"]["hub_q"]["keys"]
            assert keys["k3"]["key"] == "sk-q3" and keys["k3"]["origin"] == "vault" and keys["k3"]["is_local"] is False
            assert keys["k1"]["key"] == "sk-q1" and keys["mykey"]["key"] == "sk-mine"
            assert "k2" not in keys, "deleted key must not come back unless picked"
            assert any(x.get("key") == "k1" and x.get("provider") == "hub_q" for x in cfg["candidates"]["chat"]), "KB binding kept"
            assert cfg["agent_models"]["agent-q"]["keys"][0]["key"] == "k1", "Agent binding kept"

            # explicitly picking a deleted key brings it back
            r = await c.post("/api/admin/vault/add-keys", headers=H, json={"provider": "hub_q", "keys": ["k2"]})
            assert r.status_code == 200 and r.json()["added"] == ["k2"], r.text

            # local provider / unknown provider / empty selection rejected
            cur = (await c.get("/api/config", headers=H)).json()
            cur = cur.get("config", cur)
            cur["providers"]["mine_q"] = {"name": "Mine Q", "origin": "local", "base_url": "https://m.example.com", "keys": {}}
            assert (await c.post("/api/admin/config", headers=H, json=cur)).status_code == 200
            r = await c.post("/api/admin/vault/add-keys", headers=H, json={"provider": "mine_q", "keys": ["k1"]})
            assert r.status_code == 400, r.text
            r = await c.post("/api/admin/vault/add-keys", headers=H, json={"provider": "nope", "keys": ["k1"]})
            assert r.status_code == 404, r.text
            r = await c.post("/api/admin/vault/add-keys", headers=H, json={"provider": "hub_q", "keys": []})
            assert r.status_code == 400, r.text
    finally:
        restore()


async def test_vault_write_version_and_legacy_key_guard():
    """Layer 2: vault writes bump `_version` (a stale tab gets 409 instead of silently
    deleting what was just pulled) and legacy bare-string hub keys stay read-only.
    Also checks that POST /stats reset returns the fresh stats payload."""
    import json as _j
    from app.main import app
    from app.config_store import get_config
    H = {"Authorization": "Bearer test_admin_pass_123"}

    def handler(req):
        if req.url.path.endswith("/api/vault/fetch"):
            body = _j.loads(req.content or b"{}")
            return httpx.Response(200, json={"ok": True, "provider": body["provider"], "provider_config": {
                "name": "Legacy P", "protocol": "openai", "base_url": "https://legacy.example.com/v1",
                "keys": {"h1": "sk-hub-h1"}}})
        return httpx.Response(404)

    restore = _mock_vault(handler)
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            def body_of(res):
                d = res.json()
                return d.get("config", d)

            # --- legacy data: hub-pulled provider whose keys are still unmarked bare strings
            cur = body_of(await c.get("/api/config", headers=H))
            cur["providers"] = {"legacy_p": {"name": "Legacy P", "origin": "vault",
                                             "base_url": "https://legacy.example.com/v1",
                                             "keys": {"old": "sk-legacy-old"}}}
            assert (await c.post("/api/admin/config", headers=H, json=cur)).status_code == 200

            # 1) backend keeps the legacy hub key read-only (value restored), and it is masked on GET
            shown = body_of(await c.get("/api/config", headers=H))
            assert shown["providers"]["legacy_p"]["keys"]["old"] == "●●●●●●●●", shown["providers"]["legacy_p"]["keys"]
            cur = body_of(await c.get("/api/config", headers=H))
            cur["providers"]["legacy_p"]["keys"]["old"] = "sk-tampered"
            assert (await c.post("/api/admin/config", headers=H, json=cur)).status_code == 200
            assert (await get_config())["providers"]["legacy_p"]["keys"]["old"] == "sk-legacy-old", \
                "legacy hub key under origin=vault provider must not be overwritable"

            # 1b) 本地 Key 与管理端一致：可查看/可编辑（EdgeOne 同款），中枢 Key 仍掩码
            cur = body_of(await c.get("/api/config", headers=H))
            cur["providers"]["local_p"] = {
                "name": "Local P", "origin": "local", "base_url": "https://local.example.com/v1",
                "keys": {"mine": {"key": "sk-local-mine", "origin": "local", "is_local": True}},
            }
            assert (await c.post("/api/admin/config", headers=H, json=cur)).status_code == 200
            shown = body_of(await c.get("/api/config", headers=H))
            assert shown["providers"]["local_p"]["keys"]["mine"]["key"] == "sk-local-mine", \
                f"local key must stay visible to the admin console: {shown['providers']['local_p']}"
            assert shown["providers"]["legacy_p"]["keys"]["old"] == "●●●●●●●●", \
                "hub key must stay masked even when local keys are visible"

            # 2) a vault pull bumps _version; a tab loaded before the pull must get 409,
            #    and the freshly pulled provider must survive
            stale = body_of(await c.get("/api/config", headers=H))
            v_before = stale["_version"]
            r = await c.post("/api/admin/vault/fetch-key", headers=H, json={"provider": "new_p"})
            assert r.status_code == 200, r.text
            assert r.json().get("_version") == v_before + 1, r.text
            assert (await get_config())["_version"] == v_before + 1
            r = await c.post("/api/admin/config", headers=H, json=stale)
            assert r.status_code == 409, f"stale save must 409 after a vault pull: {r.status_code} {r.text}"
            assert "new_p" in (await get_config())["providers"], "stale save must not delete the freshly pulled provider"

            # 3) reset stats returns the fresh payload (dashboard re-renders zeros, no snapshot fallback)
            r = await c.post("/api/admin/stats", headers=H, json={"action": "reset"})
            body = r.json()
            assert body.get("status") == "success" and isinstance(body.get("stats"), dict), body
            assert (body["stats"].get("agent") or {}).get("summary", {}).get("requests") == 0, body["stats"].get("agent")
    finally:
        restore()


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

        print("  -> test_vault_pull_once_rules_only_sync...")
        await test_vault_pull_once_rules_only_sync()
        print("     PASS: test_vault_pull_once_rules_only_sync")

        print("  -> test_vault_add_keys_explicit...")
        await test_vault_add_keys_explicit()
        print("     PASS: test_vault_add_keys_explicit")

        print("  -> test_vault_write_version_and_legacy_key_guard...")
        await test_vault_write_version_and_legacy_key_guard()
        print("     PASS: test_vault_write_version_and_legacy_key_guard")
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
