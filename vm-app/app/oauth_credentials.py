"""OAuth 订阅凭据（通用官方设备码/授权码；具体厂商由 preset.auth 声明）。

设计边界（docs/OAUTH_CREDENTIAL_SPEC.md）：
- 只处理厂商官方 OAuth；不集成 magpie/非官方插件；
- 登录产物只存在本 VM 的加密配置里，origin=local，永不下发中枢；
- 调度器只通过 resolve_auth() 取 access token，认证失败按现有 Key 语义处理。
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import secrets
import time
from typing import Any, Dict, Optional
from urllib.parse import urlparse
import ipaddress

import httpx

from . import config_store
from .presets import load_preset

logger = logging.getLogger("ocrproxy")

SESSION_TTL_SEC = 600
REFRESH_LEAD_DEFAULT_SEC = 600


class OAuthError(Exception):
    """OAuth 流程错误；消息可直接给管理端（不得含 token/code）。"""


class OAuthReloginRequired(OAuthError):
    """refresh token 已失效，需要用户重新登录。"""


class OAuthPending(OAuthError):
    def __init__(self, message: str, interval: int = 5):
        super().__init__(message)
        self.interval = interval


_sessions: Dict[str, dict] = {}
_sessions_lock = asyncio.Lock()
_refresh_locks: Dict[str, asyncio.Lock] = {}
_refresh_locks_guard = asyncio.Lock()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _auth_config(provider_id: str, provider: dict) -> dict:
    auth = provider.get("auth") if isinstance(provider.get("auth"), dict) else {}
    if auth:
        return auth
    preset = load_preset(provider.get("preset_id") or provider_id) or {}
    return preset.get("auth") if isinstance(preset.get("auth"), dict) else {}


def _safe_https(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme != "https" or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    if host in ("localhost", "127.0.0.1", "::1") or host.endswith(".local"):
        return False
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return False
    except ValueError:
        pass
    return True


def _mask_secret(value: Any) -> str:
    if not isinstance(value, str) or not value:
        return ""
    return value[:4] + "●" * 8 + value[-4:] if len(value) > 12 else "●" * 8


def _jwt_claims(access: str) -> dict:
    """Read display-only claims from an access JWT (no signature verification)."""
    try:
        parts = access.split(".")
        if len(parts) < 2:
            return {}
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload.encode()))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _expires_at(auth: dict, token: dict, now_ms: int) -> Optional[int]:
    """Parse expires_in / expired_in with the documented MiniMax quirks."""
    for field in ("expires_in", "expired_in"):
        raw = token.get(field)
        if raw is None:
            continue
        try:
            val = float(raw)
        except (TypeError, ValueError):
            continue
        if val <= 0:
            return None
        # epoch seconds / epoch ms / relative seconds / relative ms
        if val > 10_000_000_000:
            return int(val)
        if val > 10_000_000:
            return now_ms + int(val)
        return now_ms + int(val * 1000)
    return None


def _session_public(session: dict) -> dict:
    now = _now_ms()
    return {
        "session": session["id"],
        "user_code": session.get("user_code", ""),
        "verification_url": session.get("verification_url", ""),
        "verification_uri": session.get("verification_uri", ""),
        "expires_in": max(0, int((session["expires_at"] - now) / 1000)),
        "interval": max(1, int(session.get("interval", 5))),
        "label": session.get("label", ""),
    }


async def _post_form(url: str, data: dict) -> dict:
    if not _safe_https(url):
        raise OAuthError("OAuth endpoint 必须是公网 https 地址")
    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=False) as client:
            resp = await client.post(url, data=data, headers={"accept": "application/json"})
    except httpx.HTTPError as exc:
        raise OAuthError(f"OAuth 网络错误: {type(exc).__name__}") from exc
    try:
        body = resp.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    return {"status": resp.status_code, "body": body}


def _token_error(body: dict) -> str:
    return str(body.get("error") or body.get("status") or body.get("error_description") or "").strip()


async def start_device(provider_id: str, provider: dict, label: str = "") -> dict:
    auth = _auth_config(provider_id, provider)
    if auth.get("type") != "oauth_device":
        raise OAuthError("该供应商未配置官方 OAuth 设备码登录")
    endpoint = str(auth.get("device_endpoint") or "")
    client_id = str(auth.get("client_id") or "")
    if not endpoint or not client_id:
        raise OAuthError("OAuth preset 缺少 device_endpoint/client_id")

    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    data = {"client_id": client_id}
    if auth.get("scope"):
        data["scope"] = str(auth["scope"])
    if auth.get("audience"):
        data["audience"] = str(auth["audience"])
    if auth.get("pkce") == "S256":
        data["code_challenge"] = challenge
        data["code_challenge_method"] = "S256"

    result = await _post_form(endpoint, data)
    body = result["body"]
    if result["status"] >= 400 or not (body.get("device_code") or body.get("user_code")):
        msg = body.get("error_description") or body.get("error") or f"HTTP {result['status']}"
        raise OAuthError(f"OAuth 设备码申请失败: {str(msg)[:200]}")

    expires_in = _expires_at(auth, body, _now_ms())
    if expires_in is None:
        expires_in = _now_ms() + SESSION_TTL_SEC * 1000
    interval = body.get("interval", 5)
    try:
        interval = float(interval)
        # MiniMax quirk: interval may be milliseconds
        if interval > 1000:
            interval = interval / 1000.0
    except (TypeError, ValueError):
        interval = 5.0
    interval = max(1, min(60, int(interval)))

    user_code = str(body.get("user_code") or "")
    verification_uri = str(body.get("verification_uri") or body.get("verification_url") or "")
    verification_complete = str(body.get("verification_uri_complete") or "")
    if not verification_complete and verification_uri and user_code:
        from urllib.parse import quote
        sep = "&" if "?" in verification_uri else "?"
        verification_complete = f"{verification_uri}{sep}user_code={quote(user_code)}"

    session_id = secrets.token_urlsafe(24)
    session = {
        "id": session_id,
        "provider_id": provider_id,
        "label": label,
        "client_id": client_id,
        "device_code": str(body.get("device_code") or ""),
        "user_code": user_code,
        "verification_url": verification_complete or verification_uri,
        "verification_uri": verification_uri,
        "code_verifier": verifier if auth.get("pkce") == "S256" else "",
        "token_endpoint": str(auth.get("token_endpoint") or ""),
        "auth": dict(auth),
        "expires_at": expires_in,
        "interval": interval,
    }
    async with _sessions_lock:
        _sessions[session_id] = session
    return _session_public(session)


async def poll_device(session_id: str) -> dict:
    async with _sessions_lock:
        session = _sessions.get(session_id)
    if not session:
        raise OAuthError("登录会话不存在或已过期")
    if _now_ms() >= session["expires_at"]:
        async with _sessions_lock:
            _sessions.pop(session_id, None)
        raise OAuthError("登录会话已过期，请重新发起")
    if not session.get("device_code"):
        raise OAuthError("设备码登录缺少 device_code")

    data = {
        "client_id": session["client_id"],
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        "device_code": session["device_code"],
    }
    if session.get("code_verifier"):
        data["code_verifier"] = session["code_verifier"]
    result = await _post_form(session["token_endpoint"], data)
    body = result["body"]
    err = _token_error(body).lower()
    if result["status"] >= 400 or err:
        if err in ("authorization_pending", "pending") or body.get("status") in ("pending", 1):
            raise OAuthPending("等待用户在浏览器完成授权", int(session.get("interval", 5)))
        if err in ("slow_down", "slowdown"):
            session["interval"] = min(60, int(session.get("interval", 5)) + 5)
            raise OAuthPending("请稍后再轮询", session["interval"])
        if err in ("expired_token", "expired"):
            async with _sessions_lock:
                _sessions.pop(session_id, None)
            raise OAuthError("授权码已过期，请重新登录")
        if err in ("access_denied", "denied"):
            async with _sessions_lock:
                _sessions.pop(session_id, None)
            raise OAuthError("用户拒绝了授权")
        raise OAuthError(f"OAuth token 交换失败: {err[:120] or result['status']}")

    access = str(body.get("access_token") or "")
    refresh = str(body.get("refresh_token") or "")
    if not access:
        raise OAuthError("OAuth token 响应缺少 access_token")
    oauth = _build_oauth(session, body, access, refresh)
    label = session.get("label") or _account_label(oauth)
    await _save_key(session["provider_id"], label, oauth)
    async with _sessions_lock:
        _sessions.pop(session_id, None)
    return {
        "status": "done",
        "label": label,
        "account": oauth.get("subject") or oauth.get("account_id") or label,
        "expires_at": oauth.get("expires_at"),
    }


def _account_label(oauth: dict) -> str:
    return str(oauth.get("subject") or oauth.get("account_id") or "oauth-account")[:80]


def _build_oauth(session: dict, body: dict, access: str, refresh: str) -> dict:
    auth = session.get("auth") or {}
    now = _now_ms()
    claims = _jwt_claims(access)
    claims_map = auth.get("account_claims") if isinstance(auth.get("account_claims"), dict) else {}
    subject = claims.get(claims_map.get("subject", "sub")) if claims_map else claims.get("sub")
    account_id = claims.get(claims_map.get("account_id", "account_id")) if claims_map else claims.get("account_id")
    return {
        "access": access,
        "refresh": refresh,
        "expires_at": _expires_at(auth, body, now),
        "refresh_expires_at": None,
        "subject": str(subject or claims.get("email") or "") or None,
        "account_id": str(account_id or "") or None,
        "status": "active",
        "last_refresh_at": 0,
        "last_error": None,
    }


async def _save_key(provider_id: str, label: str, oauth: dict, *, replace_label: str = "") -> None:
    def mutator(cfg: dict) -> dict:
        providers = cfg.setdefault("providers", {})
        provider = providers.get(provider_id)
        if not isinstance(provider, dict):
            raise OAuthError("供应商不存在")
        keys = provider.setdefault("keys", {})
        if not isinstance(keys, dict):
            keys = provider["keys"] = {}
        target = replace_label or label
        existing = keys.get(target) if isinstance(keys.get(target), dict) else {}
        merged = dict(existing)
        merged.update({
            "kind": "oauth",
            "origin": "local",
            "is_local": True,
            "key": "",
            "oauth": oauth,
        })
        keys[target] = merged
        return cfg

    await config_store.update_config(mutator)


async def _refresh_lock(key_id: str) -> asyncio.Lock:
    async with _refresh_locks_guard:
        lock = _refresh_locks.get(key_id)
        if lock is None:
            lock = _refresh_locks[key_id] = asyncio.Lock()
        return lock


async def refresh_auth(provider_id: str, key_label: str, *, force: bool = False) -> str:
    lock = await _refresh_lock(f"{provider_id}:{key_label}")
    async with lock:
        cfg = await config_store.get_config()
        provider = (cfg.get("providers") or {}).get(provider_id)
        if not isinstance(provider, dict):
            raise OAuthReloginRequired("供应商不存在")
        key_data = (provider.get("keys") or {}).get(key_label)
        if not isinstance(key_data, dict) or key_data.get("kind") != "oauth":
            return ""
        oauth = key_data.get("oauth") if isinstance(key_data.get("oauth"), dict) else {}
        if oauth.get("status") == "needs_relogin":
            raise OAuthReloginRequired("OAuth 账号需要重新登录")
        expires = oauth.get("expires_at")
        auth = _auth_config(provider_id, provider)
        lead = int(auth.get("refresh_lead_sec") or REFRESH_LEAD_DEFAULT_SEC) * 1000
        if not force and isinstance(expires, (int, float)) and expires - _now_ms() > lead and oauth.get("access"):
            return str(oauth.get("access") or "")
        refresh = str(oauth.get("refresh") or "")
        if not refresh:
            await mark_needs_relogin(provider_id, key_label, "缺少 refresh token")
            raise OAuthReloginRequired("OAuth 账号缺少 refresh token，请重新登录")

        refresh_form = {
            "client_id": str(auth.get("client_id") or ""),
            "grant_type": "refresh_token",
            "refresh_token": refresh,
        }
        if auth.get("audience"):
            refresh_form["audience"] = str(auth["audience"])
        result = await _post_form(str(auth.get("token_endpoint") or ""), refresh_form)
        body = result["body"]
        err = _token_error(body).lower()
        signed_out = {str(x).lower() for x in (auth.get("signed_out_errors") or ["invalid_grant"])}
        if result["status"] >= 400 or err:
            if err in signed_out:
                await mark_needs_relogin(provider_id, key_label, f"refresh failed: {err}")
                raise OAuthReloginRequired("OAuth 登录已失效，请重新登录")
            raise OAuthError(f"OAuth 刷新失败: {err[:120] or result['status']}")

        access = str(body.get("access_token") or "")
        if not access:
            raise OAuthError("OAuth 刷新响应缺少 access_token")
        new_oauth = dict(oauth)
        new_oauth.update({
            "access": access,
            "refresh": str(body.get("refresh_token") or refresh),
            "expires_at": _expires_at(auth, body, _now_ms()),
            "status": "active",
            "last_refresh_at": _now_ms(),
            "last_error": None,
        })

        def mutator(current: dict) -> dict:
            p = (current.get("providers") or {}).get(provider_id)
            if isinstance(p, dict) and isinstance(p.get("keys"), dict):
                k = p["keys"].get(key_label)
                if isinstance(k, dict):
                    k["kind"] = "oauth"
                    k["origin"] = "local"
                    k["is_local"] = True
                    k["key"] = ""
                    k["oauth"] = new_oauth
            return current

        await config_store.update_config(mutator)
        return access


async def mark_needs_relogin(provider_id: str, key_label: str, error: str) -> None:
    def mutator(cfg: dict) -> dict:
        p = (cfg.get("providers") or {}).get(provider_id)
        if isinstance(p, dict) and isinstance(p.get("keys"), dict):
            key = p["keys"].get(key_label)
            if isinstance(key, dict) and key.get("kind") == "oauth":
                oauth = key.setdefault("oauth", {})
                oauth["status"] = "needs_relogin"
                oauth["last_error"] = str(error)[:200]
        return cfg

    await config_store.update_config(mutator)


async def resolve_auth(provider_id: str, key_label: str, provider: dict, key_data: Any) -> str:
    """Return the value to place in the auth header. Only OAuth keys are special."""
    if not isinstance(key_data, dict) or key_data.get("kind") != "oauth":
        return str(key_data.get("key") if isinstance(key_data, dict) else key_data or "")
    oauth = key_data.get("oauth") if isinstance(key_data.get("oauth"), dict) else {}
    if oauth.get("status") == "needs_relogin":
        raise OAuthReloginRequired("OAuth 账号需要重新登录")
    access = str(oauth.get("access") or "")
    auth = _auth_config(provider_id, provider)
    expires = oauth.get("expires_at")
    lead = int(auth.get("refresh_lead_sec") or REFRESH_LEAD_DEFAULT_SEC) * 1000
    if not access or (isinstance(expires, (int, float)) and expires - _now_ms() <= lead):
        return await refresh_auth(provider_id, key_label)
    return access


async def status_for(provider_id: str, keys: dict) -> list:
    out = []
    for label, raw in (keys or {}).items():
        if not isinstance(raw, dict) or raw.get("kind") != "oauth":
            continue
        oauth = raw.get("oauth") if isinstance(raw.get("oauth"), dict) else {}
        out.append({
            "provider": provider_id,
            "label": label,
            "kind": "oauth",
            "account": oauth.get("subject") or oauth.get("account_id") or label,
            "status": oauth.get("status") or "active",
            "expires_at": oauth.get("expires_at"),
            "last_error": oauth.get("last_error"),
            "access_masked": _mask_secret(oauth.get("access")),
            "refresh_masked": _mask_secret(oauth.get("refresh")),
        })
    return out


async def keepalive_loop(interval_sec: int = 60) -> None:
    """Background token refresh. The refresh_auth single-flight lock prevents
    duplicate refreshes; VM currently runs one app worker for this task."""
    while True:
        try:
            await asyncio.sleep(max(15, int(interval_sec)))
            cfg = await config_store.get_config()
            for provider_id, provider in (cfg.get("providers") or {}).items():
                if not isinstance(provider, dict):
                    continue
                for label, key in (provider.get("keys") or {}).items():
                    if not isinstance(key, dict) or key.get("kind") != "oauth":
                        continue
                    oauth = key.get("oauth") if isinstance(key.get("oauth"), dict) else {}
                    if oauth.get("status") == "needs_relogin":
                        continue
                    expires = oauth.get("expires_at")
                    auth = _auth_config(provider_id, provider)
                    lead = int(auth.get("refresh_lead_sec") or REFRESH_LEAD_DEFAULT_SEC) * 1000
                    if isinstance(expires, (int, float)) and expires - _now_ms() <= lead:
                        try:
                            await refresh_auth(provider_id, label)
                        except OAuthReloginRequired:
                            await mark_needs_relogin(provider_id, label, "keepalive refresh: relogin required")
                        except Exception:
                            logger.warning("OAuth keepalive refresh failed for %s/%s", provider_id, label)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("OAuth keepalive loop error", exc_info=True)
