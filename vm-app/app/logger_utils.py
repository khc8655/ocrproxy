"""
logger_utils.py — Unified, secure logging module for OCRProxy VM runtime.

Adheres to:
1. Zero Secret Leakage: Automatic masking for API keys, passwords, and tokens.
2. Standardized Tagging: Aligns with EdgeOne platform using [VM:<Tag>] prefixes.
3. Clean journald integration: Structured single-line format for easy grep and alerting.
"""
import logging
from typing import Any, Optional, Dict

logger = logging.getLogger("ocrproxy")

_SENSITIVE_KEYS = {
    "key",
    "apikey",
    "api_key",
    "password",
    "admin_password",
    "token",
    "vault_token",
    "authorization",
    "proxy_api_key",
    "secret",
    "credentials",
}


def mask_secret(val: Optional[Any]) -> str:
    """Safely mask secret strings (API keys, passwords, tokens)."""
    if not val:
        return ""
    s = str(val).strip()
    if len(s) <= 8:
        return "****"
    if s.startswith("sk-"):
        return f"{s[:7]}****{s[-4:]}"
    return f"{s[:4]}****{s[-4:]}"


def sanitize_meta(meta: Dict[str, Any]) -> Dict[str, str]:
    """Sanitize metadata dictionary, masking secrets and truncating long values."""
    clean = {}
    for k, v in meta.items():
        clean_key = str(k).lower().replace("-", "").replace("_", "")
        if clean_key in _SENSITIVE_KEYS:
            clean[k] = "[REDACTED_SECRET]"
        elif isinstance(v, str):
            if v.lower().startswith("bearer "):
                clean[k] = "Bearer [REDACTED_SECRET]"
            elif len(v) > 300:
                clean[k] = f"{v[:300]}...[TRUNCATED]"
            else:
                clean[k] = v
        else:
            clean[k] = str(v)
    return clean


def format_vm_log(tag: str, message: str, meta: Optional[Dict[str, Any]] = None) -> str:
    """Format structured log line: [VM:Tag] message | key=val ..."""
    prefix = f"[VM:{tag}] {message}"
    if not meta:
        return prefix
    sanitized = sanitize_meta(meta)
    meta_str = " ".join(f"{k}={v}" for k, v in sanitized.items())
    return f"{prefix} | {meta_str}"


def clean_upstream_error_text(raw_text: Optional[str], status_code: int = 500) -> str:
    """Clean and sanitize upstream error text, stripping HTML markup and extracting concise descriptions.

    Prevents leaking raw HTML pages (e.g. Nginx 413 / Cloudflare 502) into client OpenAI error payloads
    which would otherwise crash client AI SDKs and toolings (like Cursor / Cline).
    """
    if not raw_text:
        return f"Upstream service returned HTTP {status_code}"

    text = str(raw_text).strip()
    if not text:
        return f"Upstream service returned HTTP {status_code}"

    import re
    import html

    # Check if text contains HTML markup
    is_html = ("<html" in text.lower() or "<body" in text.lower() or "<!doctype" in text.lower() or "<title" in text.lower())
    if is_html:
        # 1. Try to extract <title>...</title>
        title_match = re.search(r"<title[^>]*>(.*?)</title>", text, re.IGNORECASE | re.DOTALL)
        if title_match:
            candidate = title_match.group(1).strip()
            candidate = html.unescape(candidate)
            candidate = re.sub(r"<[^>]+>", " ", candidate).strip()
            if candidate:
                if status_code == 413:
                    return f"Upstream payload limit exceeded: {candidate}. (Request body too large for upstream provider)"
                return f"Upstream gateway error: {candidate} (HTTP {status_code})"

        # 2. Try to extract <h1>...</h1> or <h2>...</h2>
        h_match = re.search(r"<h[1-2][^>]*>(.*?)</h[1-2]>", text, re.IGNORECASE | re.DOTALL)
        if h_match:
            candidate = html.unescape(h_match.group(1).strip())
            candidate = re.sub(r"<[^>]+>", " ", candidate).strip()
            if candidate:
                if status_code == 413:
                    return f"Upstream payload limit exceeded: {candidate}. (Request body too large for upstream provider)"
                return f"Upstream error (HTTP {status_code}): {candidate}"

        # 3. Strip all HTML tags and collapse whitespace
        stripped = re.sub(r"<[^>]+>", " ", text)
        stripped = html.unescape(stripped)
        stripped = re.sub(r"\s+", " ", stripped).strip()
        if stripped:
            if status_code == 413:
                return f"Upstream payload limit exceeded (HTTP 413): {stripped[:150]}"
            return f"Upstream error (HTTP {status_code}): {stripped[:150]}"
        return f"Upstream service returned HTTP {status_code}"

    # Non-HTML text: trim and sanitize
    clean = re.sub(r"\s+", " ", text).strip()
    return clean[:300]


class VMLogger:
    """Unified logger wrapper for VM application."""

    @staticmethod
    def error(tag: str, message: str, **meta: Any) -> None:
        logger.error(format_vm_log(tag, message, meta))

    @staticmethod
    def warning(tag: str, message: str, **meta: Any) -> None:
        logger.warning(format_vm_log(tag, message, meta))

    @staticmethod
    def info(tag: str, message: str, **meta: Any) -> None:
        logger.info(format_vm_log(tag, message, meta))


vm_logger = VMLogger()

