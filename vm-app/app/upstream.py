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


def build_messages_upstream(base_url: str, anthropic_base_url: str = None, provider: str = None) -> str:
    """Build upstream URL for Anthropic Messages API (/v1/messages).

    Handles provider-specific conventions and explicit anthropic_base_url configs.
    """
    if anthropic_base_url:
        return join_upstream(anthropic_base_url, "messages")

    p = (provider or "").lower().strip()
    if p == "minimax":
        b = (base_url or "").lower()
        if "minimax.io" in b:
            return "https://api.minimax.io/anthropic/v1/messages"
        return "https://api.minimax.cn/anthropic/v1/messages"

    return join_upstream(base_url, "messages")
