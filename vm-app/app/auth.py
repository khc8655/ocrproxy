"""
Authentication utilities for proxy and admin endpoints in vm-app.
Includes Security-by-Default anti-bruteforce rate limiting and timing attack protection.
"""
import os
import time
import hmac
from collections import defaultdict
from typing import Optional, Union, List, Dict
from fastapi import Request

# Anti-bruteforce rate-limiting for admin authentication:
# Track failed attempts per client IP in a sliding window.
_FAILED_ATTEMPTS = defaultdict(list)  # ip -> [timestamp, timestamp, ...]
_BLOCKED_IPS = {}  # ip -> block_until_timestamp
_MAX_FAILED_ATTEMPTS = 5
_WINDOW_SECONDS = 600  # 10 minutes window
_BLOCK_SECONDS = 600  # 10 minutes block


def _get_client_ip(request: Request) -> str:
    """Extract client IP considering reverse proxies (X-Forwarded-For / X-Real-IP)."""
    xff = request.headers.get("X-Forwarded-For")
    if xff:
        return xff.split(",")[0].strip()
    x_real_ip = request.headers.get("X-Real-IP")
    if x_real_ip:
        return x_real_ip.strip()
    if request.client and request.client.host:
        return request.client.host
    return "127.0.0.1"


def is_ip_blocked(request: Request) -> bool:
    """Check if the requesting client IP is currently blocked due to failed attempts."""
    ip = _get_client_ip(request)
    now = time.time()
    block_until = _BLOCKED_IPS.get(ip, 0)
    if block_until > now:
        return True
    if ip in _BLOCKED_IPS:
        del _BLOCKED_IPS[ip]
    return False


def record_admin_auth_result(request: Request, success: bool) -> None:
    """Record auth outcome. If failed repeatedly, temporarily blocks the IP."""
    ip = _get_client_ip(request)
    now = time.time()

    if success:
        _FAILED_ATTEMPTS.pop(ip, None)
        _BLOCKED_IPS.pop(ip, None)
        return

    # Clean old attempts outside window
    attempts = [t for t in _FAILED_ATTEMPTS[ip] if now - t < _WINDOW_SECONDS]
    attempts.append(now)
    _FAILED_ATTEMPTS[ip] = attempts

    if len(attempts) >= _MAX_FAILED_ATTEMPTS:
        _BLOCKED_IPS[ip] = now + _BLOCK_SECONDS


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
    Enforces anti-bruteforce protection.
    """
    if is_ip_blocked(request):
        return False

    admin_pass = os.environ.get("ADMIN_PASSWORD")
    if not admin_pass:
        return False

    token = _extract_token(request)
    ok = _safe_compare(token, admin_pass)
    record_admin_auth_result(request, ok)
    return ok

