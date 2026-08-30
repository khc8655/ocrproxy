"""Shared URL-building helper used by both the proxy and admin routes."""
import re
from urllib.parse import urlparse


def join_upstream(base_url: str, path: str) -> str:
    """Build upstream URL, handling version paths and custom base URLs automatically.

    If base_url ends with /chat/completions or path already inside base_url: return base.
    If base_url contains /v1 or /v1beta/openai or ends with /v1: append /{clean_path}.
    Otherwise: append /v1/{clean_path}.
    """
    base = base_url.rstrip("/")
    clean_path = path.lstrip("/")

    if base.endswith(f"/{clean_path}"):
        return base

    # If base already contains /v1, /v1beta/openai, or /v\d+
    if base.endswith("/v1") or "/v1/" in base or base.endswith("/v1beta/openai") or re.search(r"/v\d+(\.[^/]+)?(/.*)?$", base):
        return f"{base}/{clean_path}"

    # Default to injecting /v1/
    return f"{base}/v1/{clean_path}"
