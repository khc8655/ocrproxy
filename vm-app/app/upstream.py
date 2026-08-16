"""Shared URL-building helper used by both the proxy and admin routes."""
import re


def join_upstream(base_url: str, path: str) -> str:
    """Build upstream URL, handling version paths automatically.

    Detects /v1, /v2, /v3, etc. at the end of base_url and does NOT
    append an extra /v1 in that case.  This supports providers like
    Volcano Engine (huoshan) whose base_url ends with /api/v3.
    """
    base = base_url.rstrip("/")
    if re.search(r"/v\d+$", base):
        return f"{base}/{path.lstrip('/')}"
    return f"{base}/v1/{path.lstrip('/')}"
