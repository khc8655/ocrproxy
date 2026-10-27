"""
Encrypted local file-based configuration store.
Replaces EdgeOne KV storage with a locally encrypted JSON file.
Uses Fernet symmetric encryption to protect API keys at rest.
"""
import os
import json
import time
import copy
import hashlib
import logging
import asyncio
from typing import Optional
from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger("config_store")

_config: Optional[dict] = None
_loaded_at: float = 0.0
_cache_ttl: float = 300.0  # 5 minutes
_lock: Optional[asyncio.Lock] = None


def _get_lock() -> asyncio.Lock:
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock

# Config versioning: bumped whenever a config that DIFFERS from the previous
# one is loaded from disk or saved via the admin panel.  Other modules (e.g.
# the scheduler) use it to prune state belonging to removed keys/providers.
_config_hash: Optional[str] = None
_config_version: int = 0


def get_config_version() -> int:
    """Monotonic version of the loaded config; changes only on real content changes."""
    return _config_version


def _compute_hash(config: dict) -> str:
    return hashlib.sha256(
        json.dumps(config, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    ).hexdigest()


def _bump_version_if_changed(config: dict):
    global _config_hash, _config_version
    new_hash = _compute_hash(config)
    if new_hash != _config_hash:
        _config_hash = new_hash
        _config_version += 1
        logger.info("Configuration content changed (version %d).", _config_version)


def get_run_mode(config: Optional[dict] = None) -> str:
    """Active run mode ('agent' | 'kb'), normalised in one place.

    Previously admin_routes and proxy_routes each re-implemented this
    "run_mode -> env RUN_MODE -> agent" fallback chain.
    """
    cfg = config if isinstance(config, dict) else (_config or {})
    mode = (cfg.get("run_mode") or os.environ.get("RUN_MODE") or "agent").lower().strip()
    return mode if mode in ("agent", "kb") else "agent"


def vault_url_and_token(config: Optional[dict], body: Optional[dict] = None) -> tuple[str, str]:
    """Resolve EdgeOne vault URL/token from request body, config and env (single place).

    Accepts both legacy/config spellings (`url` / `edgeone_url`); masked tokens are
    treated as absent so a read-back masked value can never be persisted as a secret.
    """
    body = body or {}
    v_cfg = (config or {}).get("edgeone_vault") or {}
    saved_url = (
        v_cfg.get("edgeone_url")
        or v_cfg.get("url")
        or os.environ.get("EDGEONE_VAULT_URL")
        or ""
    ).strip().rstrip("/")
    body_url = (body.get("edgeone_url") or body.get("url") or "").strip().rstrip("/")
    url = body_url or saved_url
    body_token = (body.get("token") or "").strip()
    if is_masked_secret(body_token):
        body_token = ""
    if body_url and body_url != saved_url:
        # The saved token is bound to the saved hub URL. A request that names another
        # URL must bring its own token; otherwise a stolen admin session could aim any
        # vault endpoint at an attacker server and harvest the Bearer token.
        return url, body_token
    token = (
        body_token
        or v_cfg.get("token")
        or os.environ.get("EDGEONE_VAULT_TOKEN")
        or os.environ.get("VAULT_ACCESS_TOKEN")
        or ""
    ).strip()
    if is_masked_secret(token):
        token = ""
    return url, token


def secret_origin(secret) -> Optional[str]:
    """Normalised credential provenance: 'vault' | 'local' | None.

    `origin` and the legacy boolean `is_local` described the same fact; read through
    this helper so the two spellings can never disagree. Writers should use
    `stamp_secret_origin` (keeps both fields in sync for older consoles).
    """
    if not isinstance(secret, dict):
        return None
    origin = secret.get("origin")
    if origin in ("vault", "local"):
        return origin
    if secret.get("is_local") is True:
        return "local"
    if secret.get("is_local") is False:
        return "vault"
    return None


def stamp_secret_origin(secret: dict, origin: str) -> dict:
    """Write provenance atomically to both `origin` and legacy `is_local`."""
    secret["origin"] = "local" if origin == "local" else "vault"
    secret["is_local"] = (secret["origin"] == "local")
    return secret


def is_masked_secret(val) -> bool:
    """Check if a secret value is a masked placeholder (e.g. ●●●●●●●● or ********)."""
    if val is None:
        return False
    if isinstance(val, str):
        s = val.strip()
        return "●" in s or s == "********" or s.startswith("***")
    if isinstance(val, dict):
        k = val.get("key")
        if isinstance(k, str):
            s = k.strip()
            if "●" in s or s == "********" or s.startswith("***"):
                return True
        pk = val.get("private_key")
        if isinstance(pk, str):
            s = pk.strip()
            if "●" in s or s == "********" or s.startswith("***"):
                return True
        oauth = val.get("oauth")
        if isinstance(oauth, dict):
            for field in ("access", "refresh"):
                v = oauth.get(field)
                if isinstance(v, str) and ("●" in v or v == "********" or v.startswith("***")):
                    return True
    return False


def _get_config_dir() -> str:
    return os.environ.get("CONFIG_DIR", "/opt/ocrproxy/config")


def _get_config_file() -> str:
    return os.path.join(_get_config_dir(), "proxy_config.enc")


def _get_fernet() -> Fernet:
    key = os.environ.get("ENCRYPT_KEY")
    if not key:
        raise RuntimeError("ENCRYPT_KEY is not configured. Run install.sh first.")
    return Fernet(key.encode() if isinstance(key, str) else key)


def _migrate_agent_models(config: dict) -> bool:
    """v3.2 -> v3.3 schema migration: agent_models becomes model-centric.

    Old (flat, key-centric list — one row per key binding):
        [{"provider": "sensenova", "key": "小号", "model": "deepseek-v4-flash"}, ...]
    New (dict keyed by public model name; keys are an ordered list inside):
        {"deepseek-v4-flash": {"keys": [{"provider": "sensenova", "key": "小号"},
                                         ...],
                               "upstream_model": "optional-id-override"}}

    Returns True when the config was modified."""
    am = config.get("agent_models")
    if not isinstance(am, list):
        return False
    grouped: dict = {}
    for entry in am:
        if not isinstance(entry, dict):
            continue
        name = entry.get("model")
        if not name or not entry.get("provider") or not entry.get("key"):
            continue
        binding = {"provider": entry["provider"], "key": entry["key"]}
        upstream = entry.get("upstream_model")
        if upstream and upstream != name:
            binding["upstream_model"] = upstream
        grouped.setdefault(name, {"keys": []})["keys"].append(binding)
    config["agent_models"] = grouped
    return True


def _migrate_string_secrets(config: dict) -> bool:
    """Normalize legacy plain-string provider keys into the canonical object shape.

    Historically a provider could store `"KeyA": "sk-xxx"`. That string carries no
    provenance, so every consumer had to special-case it (and Edge's vault export had
    to guess). Normalize once at load into {key, origin, is_local}:
      * providers with origin == 'vault'  -> vault key (read-only, deletable)
      * everything else (incl. legacy providers without origin) -> local key (editable)
    """
    changed = False
    providers = config.get("providers")
    if not isinstance(providers, dict):
        return False
    for prov in providers.values():
        if not isinstance(prov, dict):
            continue
        keys = prov.get("keys")
        if not isinstance(keys, dict):
            continue
        # VM 判定与前端 resolveKeySource()、保存守卫一致：只有供应商明确 origin=vault
        # 时，未标记的旧 Key 才算中枢资产；没有 origin 的老供应商是用户在本机录入的。
        prov_origin = "vault" if prov.get("origin") == "vault" else "local"
        for label, val in list(keys.items()):
            if isinstance(val, str) and val.strip():
                origin = prov_origin
                keys[label] = {"key": val, "origin": origin, "is_local": origin == "local"}
                changed = True
            elif isinstance(val, dict) and val.get("kind") == "oauth":
                # OAuth 凭据只能属于本机；即使上游误标 origin=vault 也强制纠正。
                if val.get("origin") != "local" or val.get("is_local") is not True or val.get("key"):
                    val["origin"] = "local"
                    val["is_local"] = True
                    val["key"] = ""
                    changed = True
                if not isinstance(val.get("oauth"), dict):
                    val["oauth"] = {}
                    changed = True
    return changed


# 参数精简（v2）：把仍停在旧默认值的参数换成新默认值；用户改过的值不动。
# 每项：key -> (旧默认, 新默认)
_PARAMS_V2_DEFAULTS = {
    "agent_first_byte_timeout_sec": (120, 90),
    "kb_max_concurrency_per_key": (16, 4),
    "upstream_timeout_sec": (15, 20),
    "circuit_cooldown_sec": (300, 600),
    "cooldown_quota_sec": (1800, 86400),
}
# 已删除 / 并入其他参数的旧字段（含旧别名）
_PARAMS_V2_OBSOLETE = (
    "schedule_total_budget", "max_retries", "request_total_budget_sec", "max_attempts_per_provider",
    "cooldown_403_sec", "circuit_escalation_sec", "fast_failover_provider_down",
    "upstream_timeout_chat", "chat_fast_timeout", "upstream_timeout_embedding", "upstream_timeout_rerank",
    "cooldown_tpm_sec", "cooldown_duration",
)
PARAMS_REV = 2


def _migrate_params_v2(config: dict) -> bool:
    try:
        rev = int(config.get("_params_rev") or 0)
    except (ValueError, TypeError):
        rev = 0
    if rev >= PARAMS_REV:
        return False
    blocks = [config]
    if isinstance(config.get("settings"), dict):
        blocks.append(config["settings"])
    for blk in blocks:
        for key, (old, new) in _PARAMS_V2_DEFAULTS.items():
            if key in blk:
                try:
                    if float(blk[key]) == float(old):
                        blk[key] = new
                except (ValueError, TypeError):
                    pass
        for key in _PARAMS_V2_OBSOLETE:
            blk.pop(key, None)
    config["_params_rev"] = PARAMS_REV
    return True


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
        config = json.loads(decrypted.decode("utf-8"))
    except InvalidToken:
        raise RuntimeError(
            "Failed to decrypt config file. ENCRYPT_KEY may be incorrect or corrupted."
        )
    except json.JSONDecodeError:
        raise RuntimeError("Config file contains invalid JSON after decryption.")

    # One-way schema migration; persist immediately so the encrypted file
    # converges to the current schema after the first read.
    migrated = _migrate_agent_models(config)
    if _migrate_params_v2(config):
        migrated = True
    if _migrate_string_secrets(config):
        migrated = True
    if migrated:
        try:
            save_to_disk(config)
            logger.info("Config migrated to latest schema and persisted.")
        except Exception as e:  # non-fatal: in-memory shape is already correct
            logger.warning("Config migration could not be persisted: %s", e)
    return config


def save_to_disk(config: dict) -> None:
    """Encrypt and save config to disk atomically."""
    config_dir = _get_config_dir()
    config_file = _get_config_file()
    os.makedirs(config_dir, exist_ok=True)

    fernet = _get_fernet()

    # Kernel Guard: Ensure no masked secrets are ever written to disk.
    # If incoming config contains masked keys (● or ***), recover original secrets from existing disk file.
    providers = config.get("providers")
    if isinstance(providers, dict):
        has_masked_keys = False
        for p_data in providers.values():
            if isinstance(p_data, dict) and isinstance(p_data.get("keys"), dict):
                for k_v in p_data["keys"].values():
                    if is_masked_secret(k_v):
                        has_masked_keys = True
                        break
            if has_masked_keys:
                break

        if has_masked_keys and os.path.exists(config_file):
            try:
                with open(config_file, "rb") as f:
                    disk_decrypted = fernet.decrypt(f.read())
                disk_cfg = json.loads(disk_decrypted.decode("utf-8"))
                disk_providers = disk_cfg.get("providers") or {}
                for p_name, p_data in providers.items():
                    if isinstance(p_data, dict) and isinstance(p_data.get("keys"), dict):
                        disk_keys = disk_providers.get(p_name, {}).get("keys", {}) if isinstance(disk_providers.get(p_name), dict) else {}
                        for k_lbl, k_val in list(p_data["keys"].items()):
                            if is_masked_secret(k_val):
                                orig = disk_keys.get(k_lbl)
                                if isinstance(k_val, dict):
                                    if orig and not is_masked_secret(orig):
                                        orig_secret = orig.get("key") if isinstance(orig, dict) else orig
                                        if is_masked_secret(k_val.get("key")):
                                            k_val["key"] = orig_secret
                                            logger.info("Kernel Guard: Restored structured key secret %s/%s from disk.", p_name, k_lbl)
                                        if is_masked_secret(k_val.get("private_key")) and isinstance(orig, dict) and orig.get("private_key"):
                                            k_val["private_key"] = orig["private_key"]
                                            logger.info("Kernel Guard: Restored masked service account private_key for %s/%s from disk.", p_name, k_lbl)
                                        # OAuth access/refresh 也是密钥：不能把 GET 的掩码写回磁盘。
                                        if isinstance(orig, dict) and orig.get("kind") == "oauth":
                                            src_oauth = orig.get("oauth") if isinstance(orig.get("oauth"), dict) else {}
                                            dst_oauth = k_val.get("oauth") if isinstance(k_val.get("oauth"), dict) else {}
                                            for f in ("access", "refresh"):
                                                if is_masked_secret(dst_oauth.get(f)) and src_oauth.get(f):
                                                    dst_oauth[f] = src_oauth[f]
                                            k_val["oauth"] = dst_oauth
                                            k_val["kind"] = "oauth"
                                            k_val["origin"] = "local"
                                            k_val["is_local"] = True
                                            k_val["key"] = ""
                                            logger.info("Kernel Guard: Restored masked OAuth tokens for %s/%s from disk.", p_name, k_lbl)
                                    else:
                                        logger.warning("Kernel Guard: Removed masked key %s/%s with no disk counterpart.", p_name, k_lbl)
                                        p_data["keys"].pop(k_lbl, None)
                                else:
                                    if orig and not is_masked_secret(orig):
                                        p_data["keys"][k_lbl] = orig.get("key") if isinstance(orig, dict) else orig
                                        logger.info("Kernel Guard: Restored masked key %s/%s from disk.", p_name, k_lbl)
                                    else:
                                        logger.warning("Kernel Guard: Removed masked key %s/%s with no disk counterpart.", p_name, k_lbl)
                                        p_data["keys"].pop(k_lbl, None)
            except Exception as e:
                logger.error("Kernel Guard: Failed to unmask keys from disk: %s", e)

    data = json.dumps(config, ensure_ascii=False, indent=2).encode("utf-8")
    encrypted = fernet.encrypt(data)

    # Write to temp file first, then rename for atomic write.  fsync both the
    # file and the directory so the rename survives a power loss.
    tmp_file = config_file + ".tmp"
    with open(tmp_file, "wb") as f:
        f.write(encrypted)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp_file, 0o600)
    os.rename(tmp_file, config_file)
    dir_fd = os.open(config_dir, os.O_DIRECTORY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    logger.info("Configuration saved to disk successfully.")


async def get_config() -> dict:
    """Get config from cache or load from disk."""
    global _config, _loaded_at

    if _config is not None and (time.time() - _loaded_at < _cache_ttl):
        return _config

    async with _get_lock():
        # Double-check after acquiring the lock, with a FRESH timestamp —
        # the outer check may have run before a long wait on the lock.
        if _config is not None and (time.time() - _loaded_at < _cache_ttl):
            return _config

        _config = await asyncio.to_thread(load_from_disk)
        _loaded_at = time.time()
        _bump_version_if_changed(_config)
        logger.info("Configuration loaded from disk.")

    return _config


def clear_cache():
    """Force clear configuration cache."""
    global _config, _loaded_at
    _config = None
    _loaded_at = 0.0


async def save_config(config: dict):
    """Save config to disk and update cache with write-lock (no CAS; callers own consistency)."""
    global _config, _loaded_at
    async with _get_lock():
        await asyncio.to_thread(save_to_disk, config)
        _config = config
        _loaded_at = time.time()
        _bump_version_if_changed(config)


class ConfigVersionConflict(RuntimeError):
    """Raised when an optimistic-lock writer based its update on a stale version."""

    def __init__(self, expected, current):
        self.expected = expected
        self.current = current
        super().__init__(f"config version conflict: expected {expected}, current {current}")


async def replace_config(config: dict, expected_version: Optional[int] = None) -> dict:
    """Atomically replace the whole config, optionally CAS-checking `_version`.

    The check happens INSIDE the write lock against the freshly loaded file, so a save
    cannot silently overwrite a write that landed between the caller's read and this
    call (the bug that made background mode switches lose admin changes / bump versions
    backwards).
    """
    global _config, _loaded_at
    async with _get_lock():
        current = await asyncio.to_thread(load_from_disk)
        cur_ver = int((current or {}).get("_version", 1) or 1)
        if expected_version is not None and int(expected_version) != cur_ver:
            raise ConfigVersionConflict(int(expected_version), cur_ver)
        await asyncio.to_thread(save_to_disk, config)
        _config = config
        _loaded_at = time.time()
        _bump_version_if_changed(config)
        return config


async def update_config(mutator, expected_version: Optional[int] = None) -> dict:
    """Atomic read-modify-write under the config lock.

    `mutator` receives a fresh copy loaded from disk (never a caller-held snapshot) and
    returns the new config. Use this for background writers such as the mode scheduler:
    anything they do not touch (keys, tokens, providers, settings) is preserved.
    """
    global _config, _loaded_at
    async with _get_lock():
        current = await asyncio.to_thread(load_from_disk)
        cur_ver = int((current or {}).get("_version", 1) or 1)
        if expected_version is not None and int(expected_version) != cur_ver:
            raise ConfigVersionConflict(int(expected_version), cur_ver)
        fresh = copy.deepcopy(current)
        updated = mutator(fresh)
        if updated is None:
            updated = fresh
        await asyncio.to_thread(save_to_disk, updated)
        _config = updated
        _loaded_at = time.time()
        _bump_version_if_changed(updated)
        return updated
