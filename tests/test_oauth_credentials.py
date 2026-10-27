#!/usr/bin/env python3
"""OAuth 凭据层回归：设备码登录、刷新、needs_relogin、origin 强制 local。"""
import asyncio
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "vm-app"))
os.environ.setdefault("CONFIG_DIR", tempfile.mkdtemp(prefix="oauth_test_"))
import base64
os.environ.setdefault("ENCRYPT_KEY", base64.urlsafe_b64encode(b"1" * 32).decode())

from app import config_store, oauth_credentials as oc  # noqa: E402

CFG = {
    "providers": {
        "minimax-code": {
            "name": "MiniMax Code", "origin": "local", "protocol": "anthropic",
            "base_url": "https://agent.minimax.cn/mavis/api/v1/llm/v1", "keys": {},
        }
    },
    "agent_models": {},
    "candidates": {},
}


def _reset_config():
    os.makedirs(os.environ["CONFIG_DIR"], exist_ok=True)
    config_store.save_to_disk(dict(CFG, _version=1))


async def test_device_login_refresh_and_relogin():
    _reset_config()
    provider = CFG["providers"]["minimax-code"]
    calls = []

    async def fake_post(url, data):
        calls.append((url, dict(data)))
        if url.endswith("/device/code"):
            return {"status": 200, "body": {
                "device_code": "dev-1", "user_code": "ABCD-EFGH",
                "verification_uri": "https://example.com/device", "expires_in": 600, "interval": 1}}
        if data.get("grant_type", "").startswith("urn:"):
            return {"status": 200, "body": {
                "access_token": "access-1", "refresh_token": "refresh-1", "expires_in": 3600}}
        if data.get("grant_type") == "refresh_token":
            return {"status": 200, "body": {
                "access_token": "access-2", "refresh_token": "refresh-2", "expires_in": 3600}}
        return {"status": 400, "body": {"error": "invalid_grant"}}

    oc._post_form = fake_post  # type: ignore
    started = await oc.start_device("minimax-code", provider)
    assert started["user_code"] == "ABCD-EFGH"
    done = await oc.poll_device(started["session"])
    assert done["status"] == "done" and done["label"]
    cfg = await config_store.get_config()
    key = cfg["providers"]["minimax-code"]["keys"][done["label"]]
    assert key["kind"] == "oauth" and key["origin"] == "local" and key["is_local"] is True
    assert key["key"] == ""
    assert key["oauth"]["access"] == "access-1"

    access = await oc.resolve_auth("minimax-code", done["label"], provider, key)
    assert access == "access-1"
    refreshed = await oc.refresh_auth("minimax-code", done["label"], force=True)
    assert refreshed == "access-2"
    cfg = await config_store.get_config()
    key2 = cfg["providers"]["minimax-code"]["keys"][done["label"]]
    assert key2["oauth"]["refresh"] == "refresh-2"

    async def invalid_post(url, data):
        return {"status": 400, "body": {"error": "invalid_grant"}}

    oc._post_form = invalid_post  # type: ignore
    try:
        await oc.refresh_auth("minimax-code", done["label"], force=True)
        raise AssertionError("expected relogin")
    except oc.OAuthReloginRequired:
        pass
    cfg = await config_store.get_config()
    assert cfg["providers"]["minimax-code"]["keys"][done["label"]]["oauth"]["status"] == "needs_relogin"
    print("PASS oauth: device login -> refresh -> invalid_grant -> needs_relogin")


if __name__ == "__main__":
    asyncio.run(test_device_login_refresh_and_relogin())
    print("ALL OAUTH CREDENTIAL CHECKS PASSED")
