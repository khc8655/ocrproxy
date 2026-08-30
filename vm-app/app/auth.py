"""
Authentication utilities for proxy and admin endpoints in vm-app.
"""
import os
import hmac
from typing import Optional, Union, List, Dict
from fastapi import Request


def _extract_token(request: Request) -> Optional[str]:
    """Extract bearer token or X-Api-Key from request."""
    auth_header = request.headers.get("Authorization")
    x_api_key = request.headers.get("X-Api-Key")

    token = None
    if auth_header:
        if auth_header.lower().startswith("bearer "):
            token = auth_header[7:].strip()
        else:
            token = auth_header.strip()

    if not token and x_api_key:
        token = x_api_key

    return token


def _safe_compare(a: Optional[str], b: Optional[str]) -> bool:
    """Constant-time string comparison to prevent timing attacks."""
    if a is None or b is None:
        return False
    return hmac.compare_digest(str(a), str(b))


def verify_proxy_auth(request: Request, config: Optional[dict] = None) -> bool:
    """
    Verify proxy API key authentication for client calls (/v1/*).
    Checks in priority order:
    1. config['proxy_api_key'] (configured via Admin UI)
    2. config['proxy_keys'] (if list or dict of keys is defined in config)
    3. os.environ['PROXY_API_KEY'] (fallback from server environment)
    4. ADMIN_PASSWORD (admin testing / probing override)
    """
    token = _extract_token(request)
    if not token:
        return False

    # 1. Check config-defined proxy_api_key (Admin UI managed)
    if config and isinstance(config, dict):
        cfg_key = config.get("proxy_api_key")
        if cfg_key and _safe_compare(token, cfg_key):
            return True

        cfg_keys = config.get("proxy_keys")
        if isinstance(cfg_keys, list):
            for k in cfg_keys:
                if k and _safe_compare(token, str(k)):
                    return True
        elif isinstance(cfg_keys, dict):
            for k in cfg_keys.values():
                if k and _safe_compare(token, str(k)):
                    return True

    # 2. Check environment variable fallback
    proxy_key = os.environ.get("PROXY_API_KEY")
    if proxy_key and _safe_compare(token, proxy_key):
        return True

    # 3. Check admin password override (for admin testing / probing)
    admin_pass = os.environ.get("ADMIN_PASSWORD")
    if admin_pass and _safe_compare(token, admin_pass):
        return True

    return False


def verify_admin_auth(request: Request) -> bool:
    """
    Verify admin authentication for web console and /api/admin/* endpoints.
    Strictly accepts ADMIN_PASSWORD to protect management actions.
    """
    admin_pass = os.environ.get("ADMIN_PASSWORD")
    if not admin_pass:
        return False

    token = _extract_token(request)
    return _safe_compare(token, admin_pass)
