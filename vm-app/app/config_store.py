"""
Encrypted local file-based configuration store.
Replaces EdgeOne KV storage with a locally encrypted JSON file.
Uses Fernet symmetric encryption to protect API keys at rest.
"""
import os
import json
import time
import logging
import asyncio
from typing import Optional
from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger("config_store")

_config: Optional[dict] = None
_loaded_at: float = 0.0
_cache_ttl: float = 300.0  # 5 minutes
_lock = asyncio.Lock()


def _get_config_dir() -> str:
    return os.environ.get("CONFIG_DIR", "/opt/ocrproxy/config")


def _get_config_file() -> str:
    return os.path.join(_get_config_dir(), "proxy_config.enc")


def _get_fernet() -> Fernet:
    key = os.environ.get("ENCRYPT_KEY")
    if not key:
        raise RuntimeError("ENCRYPT_KEY is not configured. Run install.sh first.")
    return Fernet(key.encode() if isinstance(key, str) else key)


def load_from_disk() -> dict:
    """Load and decrypt config from disk."""
    config_file = _get_config_file()
    if not os.path.exists(config_file):
        raise RuntimeError(
            f"Config file not found: {config_file}. "
            "Please run install.sh or create config via admin panel."
        )
    fernet = _get_fernet()
    try:
        with open(config_file, "rb") as f:
            encrypted_data = f.read()
        decrypted = fernet.decrypt(encrypted_data)
        return json.loads(decrypted.decode("utf-8"))
    except InvalidToken:
        raise RuntimeError(
            "Failed to decrypt config file. ENCRYPT_KEY may be incorrect or corrupted."
        )
    except json.JSONDecodeError:
        raise RuntimeError("Config file contains invalid JSON after decryption.")


def save_to_disk(config: dict) -> None:
    """Encrypt and save config to disk atomically."""
    config_dir = _get_config_dir()
    config_file = _get_config_file()
    os.makedirs(config_dir, exist_ok=True)

    fernet = _get_fernet()
    data = json.dumps(config, ensure_ascii=False, indent=2).encode("utf-8")
    encrypted = fernet.encrypt(data)

    # Write to temp file first, then rename for atomic write
    tmp_file = config_file + ".tmp"
    with open(tmp_file, "wb") as f:
        f.write(encrypted)
    os.chmod(tmp_file, 0o600)
    os.rename(tmp_file, config_file)
    logger.info("Configuration saved to disk successfully.")


async def get_config() -> dict:
    """Get config from cache or load from disk."""
    global _config, _loaded_at
    now = time.time()

    if _config is not None and (now - _loaded_at < _cache_ttl):
        return _config

    async with _lock:
        # Double-check after acquiring lock
        if _config is not None and (now - _loaded_at < _cache_ttl):
            return _config

        _config = load_from_disk()
        _loaded_at = now
        logger.info("Configuration loaded from disk.")

    return _config


def clear_cache():
    """Force clear configuration cache."""
    global _config, _loaded_at
    _config = None
    _loaded_at = 0.0


async def save_config(config: dict):
    """Save config to disk and update cache."""
    save_to_disk(config)
    global _config, _loaded_at
    _config = config
    _loaded_at = time.time()
