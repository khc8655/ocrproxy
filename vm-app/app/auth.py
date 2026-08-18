"""
Authentication utilities for proxy and admin endpoints.
Replaces EdgeOne middleware.js with FastAPI-native auth.
"""
import os
import hmac
from fastapi import Request


def _extract_token(request: Request) -> str:
    """Extract bearer token or X-Api-Key from request."""
    auth_header = request.headers.get("Authorization")
    x_api_key = request.headers.get("X-Api-Key")

    token = None
    if auth_header:
        if auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()
        else:
            token = auth_header.strip()

    if not token and x_api_key:
        token = x_api_key

    return token


def _safe_compare(a: str, b: str) -> bool:
    """Constant-time string comparison to prevent timing attacks."""
    if a is None or b is None:
        return False
    return hmac.compare_digest(a, b)


def verify_proxy_auth(request: Request) -> bool:
    """
    Verify proxy API key authentication.
    Accepts PROXY_API_KEY or ADMIN_PASSWORD (for admin testing).
    """
    proxy_key = os.environ.get("PROXY_API_KEY")
    admin_pass = os.environ.get("ADMIN_PASSWORD")

    if not proxy_key:
        return False

    token = _extract_token(request)

    # Use constant-time comparison to prevent timing attacks
    if _safe_compare(token, proxy_key):
        return True
    if admin_pass and _safe_compare(token, admin_pass):
        return True

    return False


def verify_admin_auth(request: Request) -> bool:
    """
    Verify admin authentication.
    Strictly accepts ADMIN_PASSWORD only to prevent privilege escalation.
    """
    admin_pass = os.environ.get("ADMIN_PASSWORD")
    if not admin_pass:
        return False

    token = _extract_token(request)
    return _safe_compare(token, admin_pass)

