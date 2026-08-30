"""Shared URL-building helper used by both the proxy and admin routes."""
import re
from urllib.parse import urlparse


def join_upstream(base_url: str, path: str) -> str:
    """Build upstream URL, handling version paths and custom base URLs automatically.

    If base_url already contains path segments (e.g. /v1, /v1beta/openai, /api/v3),
    it appends /{path} directly without prepending an extra /v1.
    If base_url is bare domain (e.g. https://api.openai.com), it defaults to /v1/{path}.
    """
    base = base_url.rstrip("/")
    clean_path = path.lstrip("/")
    try:
        parsed = urlparse(base)
        if parsed.path and parsed.path not in ("", "/"):
            return f"{base}/{clean_path}"
    except Exception:
        pass

    if re.search(r"/v\d+.*$", base):
        return f"{base}/{clean_path}"
    return f"{base}/v1/{clean_path}"
