import os
import re
import copy
import json
import shutil
import glob
import logging
import asyncio
import ipaddress
import socket
import time
import httpx
from pathlib import Path
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from urllib.parse import urlparse

from .config_store import get_config, save_config, _get_config_dir, is_masked_secret
from .upstream import join_upstream, build_messages_upstream
from . import stats
from .auth import verify_admin_auth
from .logger_utils import vm_logger, mask_secret

router = APIRouter(prefix="/api/admin")
logger = logging.getLogger("admin_routes")

ALLOWED_STAT_TYPES = {"chat", "embedding", "reranker", "ocr"}


def _check_auth(request: Request) -> bool:
    return verify_admin_auth(request)


_METADATA_HOSTS = {"169.254.169.254", "metadata.google.internal", "metadata", "100.100.100.200", "fd00:ec2::254"}


def _origin_of(url: str):
    try:
        u = urlparse(url or "")
        if not u.hostname:
            return None
        port = u.port or (443 if u.scheme == "https" else 80)
        return (u.scheme.lower(), u.hostname.lower(), port)
    except Exception:
        return None


def _configured_upstream_origins(config: dict) -> set:
    """Origins (scheme, host, port) the admin has explicitly saved as provider endpoints."""
    origins = set()
    for prov in ((config or {}).get("providers") or {}).values():
        if not isinstance(prov, dict):
            continue
        for u in (prov.get("base_url"), prov.get("anthropic_base_url")):
            o = _origin_of(u)
            if o:
                origins.add(o)
        for kv in (prov.get("keys") or {}).values():
            if isinstance(kv, dict):
                o = _origin_of(kv.get("base_url"))
                if o:
                    origins.add(o)
    return origins


def _is_link_local_or_metadata(host: str) -> bool:
    host = (host or "").lower().strip("[]")
    if host in _METADATA_HOSTS:
        return True
    try:
        addr = ipaddress.ip_address(host)
        if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
            addr = addr.ipv4_mapped
        return addr.is_link_local
    except ValueError:
        return False


async def _admin_upstream_block_reason(url: str, config: dict = None):
    """SSRF guard for admin-side probes (verify-key / test / probe-models).

    Runtime routing already calls whatever base_url the admin saved (including
    self-hosted http://10.x / http://127.0.0.1 endpoints such as vLLM/Ollama),
    so admin probes must accept the same endpoints or every "test" button lies.
    Rules:
      * cloud metadata / link-local targets are always blocked;
      * public HTTPS is always allowed;
      * HTTP or private/loopback targets are allowed only when the exact origin
        (scheme+host+port) is a provider endpoint saved in the config.
    Returns None when allowed, otherwise a human-readable reason.
    """
    try:
        parsed = urlparse(url or "")
    except Exception:
        return "上游 URL 格式无效"
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not host:
        return "上游 URL 格式无效"
    if _is_link_local_or_metadata(host):
        return "禁止访问云厂商元数据 / 链路本地地址"
    try:
        resolved = await asyncio.to_thread(socket.getaddrinfo, host, None)
        if any(_is_link_local_or_metadata(info[4][0]) for info in resolved):
            return "禁止访问云厂商元数据 / 链路本地地址"
    except (socket.gaierror, socket.herror, UnicodeError):
        pass
    if parsed.scheme == "https" and not await _is_blocked_hostname(host):
        return None
    if _origin_of(url) in _configured_upstream_origins(config or {}):
        return None
    return "仅允许 HTTPS 公网地址；内网或 HTTP 上游请先在「供应商」中保存该 Base URL 后再测试"


def _check_ip_address(addr_str: str) -> bool:
    """Check if an IP address is private, loopback, link-local, or multicast."""
    try:
        addr = ipaddress.ip_address(addr_str)
        if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
            addr = addr.ipv4_mapped
        return (
            addr.is_private
            or addr.is_loopback
            or addr.is_link_local
            or addr.is_multicast
            or addr.is_reserved
            or addr.is_unspecified
        )
    except ValueError:
        return False


async def _is_blocked_hostname(hostname: str) -> bool:
    """Check if hostname is an internal/local/metadata address (SSRF protection)."""
    if not hostname:
        return True
    hostname = hostname.lower().strip()

    blocked_exact = {"localhost", "::1", "::", "0.0.0.0"}
    if hostname in blocked_exact:
        return True

    if _check_ip_address(hostname):
        return True

    try:
        resolved = await asyncio.to_thread(socket.getaddrinfo, hostname, None)
        for info in resolved:
            ip = info[4][0]
            if _check_ip_address(ip):
                return True
    except (socket.gaierror, socket.herror):
        return False

    return False


def _get_config_summary(config: dict) -> dict:
    """Generate high-level stats for config preview and response summary."""
    providers = config.get("providers", {})
    total_keys = 0
    if isinstance(providers, dict):
        for p in providers.values():
            if isinstance(p, dict) and isinstance(p.get("keys"), dict):
                total_keys += len(p["keys"])
    candidates = config.get("candidates", {})
    cand_counts = {
        cat: len(candidates.get(cat, [])) if isinstance(candidates.get(cat), list) else 0
        for cat in ("chat", "embedding", "reranker", "ocr")
    }
    agent_models = config.get("agent_models", {})
    agent_count = len(agent_models) if isinstance(agent_models, dict) else 0
    return {
        "providers_count": len(providers) if isinstance(providers, dict) else 0,
        "total_keys": total_keys,
        "agent_models_count": agent_count,
        "candidate_counts": cand_counts,
    }


def _merge_configs(base: dict, incoming: dict, local_run_mode: str = "agent") -> dict:
    """Deep-merge incoming config into base config, filtered by active RUN_MODE."""
    merged = copy.deepcopy(base)

    # 1. Merge providers (universal asset across all modes)
    merged_providers = merged.setdefault("providers", {})
    incoming_providers = incoming.get("providers", {})
    if isinstance(incoming_providers, dict):
        for p_name, p_val in incoming_providers.items():
            if not isinstance(p_val, dict):
                continue
            if p_name not in merged_providers:
                merged_providers[p_name] = copy.deepcopy(p_val)
                p_keys = merged_providers[p_name].get("keys")
                if isinstance(p_keys, dict):
                    for k_name, k_secret in list(p_keys.items()):
                        if is_masked_secret(k_secret):
                            p_keys.pop(k_name, None)
            else:
                if p_val.get("base_url"):
                    merged_providers[p_name]["base_url"] = p_val["base_url"]
                merged_providers[p_name]["rpm_per_key"] = p_val.get("rpm_per_key", 0) or 0
                if "protocols" in p_val:
                    merged_providers[p_name]["protocols"] = p_val["protocols"]
                if "adapter_rules" in p_val:
                    merged_providers[p_name]["adapter_rules"] = p_val["adapter_rules"]
                if "anthropic_base_url" in p_val:
                    merged_providers[p_name]["anthropic_base_url"] = p_val["anthropic_base_url"]
                if "anthropic_messages" in p_val:
                    merged_providers[p_name]["anthropic_messages"] = p_val["anthropic_messages"]
                merged_keys = merged_providers[p_name].setdefault("keys", {})
                incoming_keys = p_val.get("keys", {})
                if isinstance(incoming_keys, dict):
                    for k_name, k_secret in incoming_keys.items():
                        if k_name and k_secret:
                            if is_masked_secret(k_secret):
                                continue
                            merged_keys[k_name] = k_secret

    # 2. Merge candidates (Always preserve user candidates across modes)
    merged_candidates = merged.setdefault("candidates", {})
    incoming_candidates = incoming.get("candidates", {})
    if isinstance(incoming_candidates, dict):
        for cat in ("chat", "embedding", "reranker", "ocr"):
            in_list = incoming_candidates.get(cat, [])
            if isinstance(in_list, list):
                existing_list = merged_candidates.setdefault(cat, [])
                existing_keys = {(c.get("provider"), c.get("key"), c.get("model")) for c in existing_list if isinstance(c, dict)}
                for cand in in_list:
                    if isinstance(cand, dict):
                        k = (cand.get("provider"), cand.get("key"), cand.get("model"))
                        if k not in existing_keys and cand.get("provider") and cand.get("key"):
                            existing_list.append(copy.deepcopy(cand))
                            existing_keys.add(k)

    # 3. Merge agent_models (Always preserve user agent models across modes)
    merged_agent_models = merged.setdefault("agent_models", {})
    incoming_agent_models = incoming.get("agent_models", {})
    if isinstance(incoming_agent_models, dict):
        for m_name, m_val in incoming_agent_models.items():
            if not isinstance(m_val, dict):
                continue
            if m_name not in merged_agent_models:
                merged_agent_models[m_name] = copy.deepcopy(m_val)
            else:
                existing_keys = merged_agent_models[m_name].setdefault("keys", [])
                existing_set = {(b.get("provider"), b.get("key")) for b in existing_keys if isinstance(b, dict)}
                for b in m_val.get("keys", []):
                    if isinstance(b, dict):
                        sig = (b.get("provider"), b.get("key"))
                        if sig not in existing_set and b.get("provider") and b.get("key"):
                            existing_keys.append(copy.deepcopy(b))
                            existing_set.add(sig)
                if m_val.get("upstream_model"):
                    merged_agent_models[m_name]["upstream_model"] = m_val["upstream_model"]

    # 4. Update top-level setting parameters if present in incoming (EXCLUDING run_mode)
    setting_keys = [
        "proxy_api_key", "proxy_keys",
        "agent_routing_strategy", "kb_routing_strategy",
        "request_total_budget_sec", "max_retries", "upstream_timeout_sec", "agent_first_byte_timeout_sec", "max_attempts_per_provider",
        "fast_failover_provider_down",
        "upstream_timeout", "upstream_timeout_chat", "upstream_timeout_embedding",
        "upstream_timeout_rerank", "upstream_timeout_ocr", "chat_fast_timeout",
        "max_concurrency_per_key", "kb_max_concurrency_per_key", "agent_max_concurrency_per_key",
        "cooldown_tpm_sec", "cooldown_quota_sec", "cooldown_5xx_sec",
        "cooldown_429_sec", "cooldown_403_sec", "cooldown_duration",
        "circuit_break_threshold", "circuit_cooldown_sec", "latency_based_routing",
        "kb_global_max_concurrency", "stream_idle_timeout_sec", "cooldown_404_sec", "cooldown_410_sec",
        "ocr_max_inflight", "ocr_queue_timeout_sec"
    ]
    for sk in setting_keys:
        if sk in incoming:
            merged[sk] = incoming[sk]

    # Handle incoming legacy schedule_total_budget if present
    legacy_stb = incoming.get("schedule_total_budget")
    if legacy_stb is not None:
        try:
            val = float(legacy_stb)
            if 0 < val <= 10:
                merged.setdefault("max_retries", int(val))
            elif val > 10:
                merged.setdefault("request_total_budget_sec", float(val))
        except (ValueError, TypeError):
            pass

    # 5. Merge Schema v2 settings block if present
    incoming_settings = incoming.get("settings")
    if isinstance(incoming_settings, dict):
        merged_settings = merged.setdefault("settings", {})
        for k, v in incoming_settings.items():
            if k == "schedule_total_budget":
                try:
                    val = float(v)
                    if 0 < val <= 10:
                        merged_settings["max_retries"] = int(val)
                        merged["max_retries"] = int(val)
                    elif val > 10:
                        merged_settings["request_total_budget_sec"] = float(val)
                        merged["request_total_budget_sec"] = float(val)
                except (ValueError, TypeError):
                    pass
                continue
            merged_settings[k] = v
            merged[k] = v

    merged["run_mode"] = local_run_mode
    return merged


@router.get("/config")
async def get_config_endpoint(request: Request):
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    action = request.query_params.get("action")
    if action == "test":
        provider_name = request.query_params.get("provider", "")
        key_label = request.query_params.get("key", "")
        target_model = request.query_params.get("model", "")
        try:
            config = await get_config()
            prov = config.get("providers", {}).get(provider_name, {})
            base_url = prov.get("base_url", "")
            api_key = prov.get("keys", {}).get(key_label, "")
            if not base_url or not api_key:
                return JSONResponse(content={"ok": False, "status": 404, "error": "Provider or Key not found", "latency_ms": 0})
            
            t0 = time.monotonic()
            url = join_upstream(base_url, "models")
            async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
                resp = await client.get(url, headers={"Authorization": f"Bearer {api_key}"})
                latency = round((time.monotonic() - t0) * 1000)
                is_ok = resp.status_code in (200, 400, 404)
                return JSONResponse(content={
                    "ok": is_ok,
                    "status": resp.status_code,
                    "latency_ms": latency,
                    "provider": provider_name,
                    "key": key_label,
                    "model": target_model
                })
        except Exception as e:
            return JSONResponse(content={"ok": False, "status": 500, "error": str(e), "latency_ms": 0})

    try:
        config = await get_config()
        resp_data = copy.deepcopy(dict(config))
        # 零明文脱敏：对下发给浏览器的所有 Provider keys 实施脱敏掩码，确保绝不泄露上游密钥密文
        providers = resp_data.get("providers", {})
        if isinstance(providers, dict):
            for p_name, p_data in providers.items():
                if isinstance(p_data, dict) and "keys" in p_data and isinstance(p_data["keys"], dict):
                    masked_keys = {}
                    for k_lbl, k_val in p_data["keys"].items():
                        if k_lbl in ("public", "__public__") or k_val == "public":
                            masked_keys[k_lbl] = "public"
                        elif isinstance(k_val, dict):
                            if k_val.get("type") == "service_account" or "private_key" in k_val:
                                masked_keys[k_lbl] = {"type": "service_account", "project_id": k_val.get("project_id", "masked"), "private_key": "●●●●●●●●"}
                            else:
                                m_dict = dict(k_val)
                                m_dict["key"] = "●●●●●●●●" if k_val.get("key") else ""
                                masked_keys[k_lbl] = m_dict
                        else:
                            masked_keys[k_lbl] = "●●●●●●●●" if k_val else ""
                    p_data["keys"] = masked_keys

        # 脱敏 EdgeOne 金库专钥 (edgeone_vault.token)：
        # 遵循标准留空保持模式，绝不回传黑圆点字符（规避 ASCII Header 编码错误及二次覆盖冲毁），
        # 仅下发 has_token 状态标记供前端呈现已配置占位符
        if isinstance(resp_data.get("edgeone_vault"), dict):
            v_tok = resp_data["edgeone_vault"].get("token")
            resp_data["edgeone_vault"]["has_token"] = bool(v_tok and not is_masked_secret(v_tok))
            resp_data["edgeone_vault"]["token"] = ""

        run_mode = config.get("run_mode") or os.environ.get("RUN_MODE") or "agent"
        run_mode = run_mode.lower().strip()
        if run_mode not in ("agent", "kb"):
            run_mode = "agent"
        resp_data["_run_mode"] = run_mode
        resp_data["run_mode"] = run_mode
        resp_data["_version"] = config.get("_version", 1)
        if not resp_data.get("proxy_api_key"):
            resp_data["proxy_api_key"] = os.environ.get("PROXY_API_KEY", "")
        return JSONResponse(content=resp_data)
    except Exception as e:
        logger.error("Failed to get config: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": "Failed to load configuration"})



# ── Preset Hub & Remote Distribution ─────────────────────────────────
_CATALOG_CACHE: dict = {"data": None, "expires_at": 0}
_PRESET_REMOTE_CACHE: dict = {}

_CDN_CATALOG_URLS = [
    "https://raw.githubusercontent.com/khc8655/ocrproxy/main/shared/presets/catalog.json",
    "https://raw.gitmirror.com/khc8655/ocrproxy/main/shared/presets/catalog.json",
    "https://cdn.jsdelivr.net/gh/khc8655/ocrproxy@main/shared/presets/catalog.json",
]

_CDN_PRESET_BASE_URLS = [
    "https://raw.githubusercontent.com/khc8655/ocrproxy/main/shared/presets",
    "https://raw.gitmirror.com/khc8655/ocrproxy/main/shared/presets",
    "https://cdn.jsdelivr.net/gh/khc8655/ocrproxy@main/shared/presets",
]


async def _fetch_remote_json(urls: list, timeout: float = 2.5):
    """Attempt to fetch JSON from mirrors in order, return parsed dict or None."""
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        for url in urls:
            try:
                resp = await client.get(url)
                if resp.status_code == 200:
                    return resp.json()
            except Exception as e:
                logger.debug("Failed to fetch preset URL %s: %s", url, e)
    return None


def _get_presets_dir() -> Path:
    """Resolve shared/presets directory in both prod (/opt/ocrproxy) and dev repo environments."""
    p = Path(__file__).resolve().parent.parent / "shared" / "presets"
    if p.exists():
        return p
    return Path(__file__).resolve().parent.parent.parent / "shared" / "presets"


def _get_local_catalog() -> dict:
    """Fallback: read shared/presets/catalog.json locally."""
    catalog_file = _get_presets_dir() / "catalog.json"
    if catalog_file.exists():
        try:
            return json.loads(catalog_file.read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning("Failed to read local catalog.json: %s", e)
    return {"version": "1.1.0", "providers": []}


def _get_local_preset(preset_id: str):
    """Fallback: read shared/presets/{preset_id}.json locally."""
    pdir = _get_presets_dir()
    preset_file = pdir / f"{preset_id}.json"
    if not preset_file.exists():
        pid_clean = re.sub(r"[.\-_]", "", preset_id.lower())
        if pid_clean:
            preset_file = pdir / f"{pid_clean}.json"
    if preset_file.exists():
        try:
            return json.loads(preset_file.read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning("Failed to read local preset %s.json: %s", preset_id, e)
    return None


@router.get("/presets/catalog")
async def get_presets_catalog_endpoint(request: Request):
    """Return lightweight catalog of available providers from CDN with fallback."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    now = time.time()
    force = request.query_params.get("force") == "true"
    if not force and _CATALOG_CACHE["data"] and _CATALOG_CACHE["expires_at"] > now:
        return JSONResponse(content={"ok": True, "source": "cache", "catalog": _CATALOG_CACHE["data"]})

    catalog_data = await _fetch_remote_json(_CDN_CATALOG_URLS, timeout=2.0)
    source = "remote"
    if not catalog_data:
        catalog_data = _get_local_catalog()
        source = "local_fallback"

    _CATALOG_CACHE["data"] = catalog_data
    _CATALOG_CACHE["expires_at"] = now + 600.0
    catalog_providers = catalog_data.get("providers", []) if isinstance(catalog_data, dict) else []
    return JSONResponse(content={
        "ok": True,
        "source": source,
        "catalog": catalog_data,
        "providers": catalog_providers,
    })


@router.get("/presets/detail")
async def get_preset_detail_endpoint(request: Request, id: str = ""):
    """Fetch complete preset definition for a single provider on demand."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    pid = id.lower().strip()
    if not pid:
        return JSONResponse(status_code=400, content={"error": "Missing preset id"})

    force = request.query_params.get("force") == "true"
    cached = _PRESET_REMOTE_CACHE.get(pid)
    if not force and cached:
        return JSONResponse(content={"ok": True, "source": "cache", "preset": cached})

    urls = [f"{base}/{pid}.json" for base in _CDN_PRESET_BASE_URLS]
    preset_data = await _fetch_remote_json(urls, timeout=2.0)
    source = "remote"
    if not preset_data:
        preset_data = _get_local_preset(pid)
        source = "local_fallback"

    if not preset_data:
        return JSONResponse(status_code=404, content={"error": f"Preset '{pid}' not found"})

    _PRESET_REMOTE_CACHE[pid] = preset_data
    return JSONResponse(content={"ok": True, "source": source, "preset": preset_data})


@router.post("/presets/check-updates")
async def check_preset_updates_endpoint(request: Request):
    """Compare local provider versions against latest catalog."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    catalog_data = await _fetch_remote_json(_CDN_CATALOG_URLS, timeout=2.0) or _get_local_catalog()
    catalog_map = {p["id"]: p for p in catalog_data.get("providers", []) if "id" in p}

    try:
        body = await request.json()
    except Exception:
        body = {}

    curr_cfg = None
    providers_to_check = body.get("providers")
    if not providers_to_check:
        curr_cfg = await get_config()
        providers_to_check = []
        for pid, pdata in (curr_cfg.get("providers") or {}).items():
            preset_id = pdata.get("preset_id", pid)
            providers_to_check.append({
                "provider_id": pid,
                "preset_id": preset_id,
                "current_version": pdata.get("preset_version") or "1.0.0",
                "rule_hash": pdata.get("rule_hash"),
            })

    updates = []
    up_to_date = []

    for item in providers_to_check:
        prov_id = item.get("provider_id") or item.get("id")
        pres_id = item.get("preset_id") or prov_id
        curr_ver = item.get("current_version") or item.get("version") or "1.0.0"

        remote_preset = catalog_map.get(pres_id)
        if not remote_preset:
            continue

        latest_ver = remote_preset.get("version", "1.0.0")
        latest_hash = remote_preset.get("rule_hash") or ""
        curr_rules = item.get("adapter_rules")
        if curr_rules is None and curr_cfg is not None:
            curr_rules = (curr_cfg.get("providers") or {}).get(prov_id, {}).get("adapter_rules")

        curr_hash = item.get("rule_hash") or ""
        if not curr_hash and curr_rules is not None:
            try:
                curr_hash = hashlib.sha256(json.dumps(curr_rules or {}, sort_keys=True).encode("utf-8")).hexdigest()[:12]
            except Exception:
                curr_hash = ""

        # 核心判据：只要内容 Hash 完全一致，数学证明规则无任何变动，绝对判定无更新！
        if latest_hash and curr_hash and latest_hash == curr_hash:
            has_update = False
        else:
            has_update = (latest_ver != curr_ver) or bool(latest_hash and curr_hash and latest_hash != curr_hash)

        res_item = {
            "provider_id": prov_id,
            "preset_id": pres_id,
            "name": remote_preset.get("name", prov_id),
            "current_version": curr_ver,
            "latest_version": latest_ver,
            "remote_version": latest_ver,
            "updated_at": remote_preset.get("updated_at", ""),
            "update_notes": remote_preset.get("update_notes", ""),
            "has_update": has_update,
        }

        if has_update:
            updates.append(res_item)
        else:
            up_to_date.append(res_item)

    return JSONResponse(content={
        "ok": True,
        "updates": updates,
        "up_to_date": up_to_date,
        "catalog_version": catalog_data.get("version", "1.1.0"),
    })


@router.post("/presets/update-rules")
async def update_preset_rules_endpoint(request: Request):
    """Incremental rule update: Fetch latest adapter_rules and update specified local providers strictly on-demand."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    target_ids = body.get("provider_ids", [])
    if isinstance(target_ids, str):
        target_ids = [target_ids]

    if not target_ids:
        return JSONResponse(status_code=400, content={"error": "No provider_ids specified"})

    curr_cfg = await get_config()
    providers = curr_cfg.get("providers") or {}

    # 物理级按需过滤：只能更新本地配置中已存在的供应商，坚决拦截全量注入与未存厂商拉取！
    valid_target_ids = [pid for pid in target_ids if pid in providers]
    if not valid_target_ids:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": "None of the specified providers exist in local configuration"}
        )

    updated = []
    failed = []

    for pid in valid_target_ids:
        pdata = providers[pid]
        pres_id = pdata.get("preset_id", pid)

        urls = [f"{base}/{pres_id}.json" for base in _CDN_PRESET_BASE_URLS]
        preset_data = await _fetch_remote_json(urls, timeout=2.5) or _get_local_preset(pres_id)

        if not preset_data:
            failed.append({"provider_id": pid, "error": f"Failed to fetch rules for preset '{pres_id}'"})
            continue

        pdata["adapter_rules"] = preset_data.get("adapter_rules", {})
        pdata["preset_version"] = preset_data.get("version", "1.1.0")
        if "updated_at" in preset_data:
            pdata["preset_updated_at"] = preset_data["updated_at"]
        if "update_notes" in preset_data:
            pdata["preset_update_notes"] = preset_data["update_notes"]
        try:
            r_str = json.dumps(pdata["adapter_rules"], sort_keys=True)
            pdata["rule_hash"] = hashlib.sha256(r_str.encode("utf-8")).hexdigest()[:12]
        except Exception:
            pdata["rule_hash"] = ""

        if "recommended_models" in preset_data:
            pdata["recommended_models"] = preset_data["recommended_models"]
        if "features" in preset_data:
            pdata["features"] = preset_data["features"]

        updated.append({
            "provider_id": pid,
            "preset_id": pres_id,
            "new_version": pdata["preset_version"],
            "updated_at": preset_data.get("updated_at", ""),
            "update_notes": preset_data.get("update_notes", ""),
        })

    if updated:
        await save_config(curr_cfg)
        try:
            from .proxy_routes import _PRESET_CACHE
            _PRESET_CACHE.clear()
        except Exception:
            pass

    return JSONResponse(content={
        "ok": True,
        "updated": updated,
        "failed": failed,
        "message": f"Successfully updated rules for {len(updated)} provider(s)."
    })


@router.get("/presets")
async def get_presets_endpoint(request: Request, action: str = "", id: str = ""):
    """Return available provider presets for admin console with action dispatch."""
    if action == "catalog":
        return await get_preset_catalog_endpoint(request)
    if action == "detail":
        return await get_preset_detail_endpoint(request, id=id)

    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    presets_dir = _get_presets_dir()
    presets_list = []
    if presets_dir.exists():
        for p in sorted(presets_dir.glob("*.json")):
            if p.name == "catalog.json":
                continue
            try:
                presets_list.append(json.loads(p.read_text(encoding="utf-8")))
            except Exception as e:
                logger.warning("Failed to load preset %s: %s", p, e)

    preset_map = {p["id"]: p for p in presets_list if "id" in p}
    return JSONResponse(content={"ok": True, "presets": presets_list, "map": preset_map})


@router.post("/presets")
async def post_presets_endpoint(request: Request, action: str = ""):
    """Dispatcher for POST /presets?action=..."""
    if action == "check-updates":
        return await check_preset_updates_endpoint(request)
    if action == "update-rules":
        return await update_preset_rules_endpoint(request)
    return JSONResponse(status_code=400, content={"error": f"Unknown presets action '{action}'"})


@router.get("/config/export")
async def export_config_endpoint(request: Request):
    """Export current configuration as a downloadable JSON file with timestamp."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    try:
        config = await get_config()
        export_data = copy.deepcopy(config)
        now_str = time.strftime("%Y%m%d_%H%M%S")
        export_data["_exported_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        export_data["_version"] = "3.3"
        filename = f"ocrproxy_config_{now_str}.json"

        run_mode = (config.get("run_mode") or os.environ.get("RUN_MODE") or "agent").lower()
        if run_mode == "agent":
            export_data.pop("candidates", None)
        else:
            export_data.pop("agent_models", None)

        json_bytes = json.dumps(export_data, ensure_ascii=False, indent=2).encode("utf-8")
        return Response(
            content=json_bytes,
            media_type="application/json; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Content-Type": "application/json; charset=utf-8",
            },
        )
    except Exception as e:
        logger.error("Failed to export config: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": "Failed to export configuration"})


@router.post("/config/import")
@router.post("/import")
async def import_config_endpoint(request: Request):
    """Import and apply a configuration file with overwrite or merge strategy."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > 2 * 1024 * 1024:
                return JSONResponse(status_code=413, content={"error": "Import payload too large (max 2MB)"})
        except (ValueError, TypeError):
            pass

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON payload"})

    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Invalid payload format"})

    mode = body.get("mode", "merge")
    if mode not in ("overwrite", "merge"):
        return JSONResponse(status_code=400, content={"error": "Invalid mode: must be 'overwrite' or 'merge'"})

    incoming_config = body.get("config")
    if not isinstance(incoming_config, dict):
        return JSONResponse(status_code=400, content={"error": "Missing or invalid 'config' object"})

    providers = incoming_config.get("providers")
    if not isinstance(providers, dict):
        return JSONResponse(
            status_code=400,
            content={"error": "Invalid configuration: providers must be an object"}
        )

    try:
        current_config = await get_config()
        local_run_mode = (current_config.get("run_mode") or os.environ.get("RUN_MODE") or "agent").lower().strip()
        if local_run_mode not in ("agent", "kb"):
            local_run_mode = "agent"

        try:
            config_dir = _get_config_dir()
            current_enc_file = os.path.join(config_dir, "proxy_config.enc")
            if os.path.exists(current_enc_file):
                bak_file = os.path.join(config_dir, f"proxy_config.enc.bak-{time.strftime('%Y%m%d%H%M%S')}")
                shutil.copy2(current_enc_file, bak_file)
                logger.info("Created pre-import config snapshot: %s", bak_file)
        except Exception as bak_err:
            logger.warning("Failed to create snapshot backup: %s", bak_err)

        if mode == "merge":
            final_config = _merge_configs(current_config, incoming_config, local_run_mode=local_run_mode)
        else:
            final_config = copy.deepcopy(incoming_config)
            final_config["run_mode"] = local_run_mode
            if "candidates" not in final_config or not final_config["candidates"]:
                final_config["candidates"] = current_config.get("candidates") or {"chat": [], "embedding": [], "reranker": [], "ocr": []}
            if "agent_models" not in final_config or not final_config["agent_models"]:
                final_config["agent_models"] = current_config.get("agent_models") or {}

        final_config.pop("_exported_at", None)
        final_config.pop("_version", None)
        final_config.pop("_mode", None)
        final_config.pop("_run_mode", None)
        final_config["run_mode"] = local_run_mode

        if "candidates" not in final_config:
            final_config["candidates"] = current_config.get("candidates") or {"chat": [], "embedding": [], "reranker": [], "ocr": []}
        if "agent_models" not in final_config:
            final_config["agent_models"] = current_config.get("agent_models") or {}

        # Monotonic version bump on import
        final_config["_version"] = current_config.get("_version", 1) + 1

        await save_config(final_config)
        summary = _get_config_summary(final_config)
        return JSONResponse(content={
            "success": True,
            "status": "success",
            "mode": mode,
            "message": "配置导入成功",
            "summary": summary,
            "_version": final_config["_version"]
        })
    except Exception as e:
        logger.error("Failed to import config: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": "Failed to import configuration"})


def _sync_env_run_mode(new_mode: str):
    if not new_mode:
        return
    new_mode = str(new_mode).lower().strip()
    if new_mode not in ("agent", "kb"):
        return
    os.environ["RUN_MODE"] = new_mode
    env_paths = [
        Path("/opt/ocrproxy/.env"),
        Path(__file__).resolve().parent.parent / ".env",
        Path(__file__).resolve().parent.parent.parent / ".env"
    ]
    for env_file in env_paths:
        if env_file.exists():
            try:
                content = env_file.read_text(encoding="utf-8")
                lines = []
                found = False
                for line in content.splitlines():
                    if line.startswith("RUN_MODE="):
                        lines.append(f"RUN_MODE={new_mode}")
                        found = True
                    else:
                        lines.append(line)
                if not found:
                    lines.append(f"RUN_MODE={new_mode}")
                env_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
                logger.info("Synced RUN_MODE=%s to %s", new_mode, env_file)
            except Exception as e:
                logger.warning("Could not sync RUN_MODE to %s: %s", env_file, e)


@router.post("/config")
async def save_config_endpoint(request: Request):
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    if not isinstance(body, dict) or not isinstance(body.get("providers"), dict):
        return JSONResponse(
            status_code=400,
            content={"error": "Invalid configuration: providers must be an object"}
        )

    try:
        current_config = await get_config()
        curr_ver = current_config.get("_version", 1)
        client_ver = body.get("_version")

        # 1. Optimistic Locking Version Check:
        # If client provides _version and it is strictly lower than current version on disk,
        # reject with 409 Conflict to protect against stale tabs overwriting newly added keys/models.
        if client_ver is not None and isinstance(client_ver, int) and client_ver < curr_ver:
            vm_logger.warning("ConfigError", "Config version conflict (409)", client_version=client_ver, remote_version=curr_ver)
            return JSONResponse(
                status_code=409,
                content={
                    "error": f"配置已被其他会话或标签页更新（当前最新版本为 v{curr_ver}，您的版本为 v{client_ver}）。为防止新添加的模型和 Key 被覆盖冲毁，本次保存已被系统安全拦截。请刷新页面拉取最新配置后重试。",
                    "code": "version_conflict",
                    "current_version": curr_ver,
                    "client_version": client_ver
                }
            )

        # 2. Asset preservation: keep existing candidates/agent_models/edgeone_vault/providers if missing from incoming
        if "providers" not in body or not isinstance(body["providers"], dict):
            body["providers"] = current_config.get("providers") or {}
        if "candidates" not in body or not isinstance(body["candidates"], dict):
            body["candidates"] = current_config.get("candidates") or {"chat": [], "embedding": [], "reranker": [], "ocr": []}
        if "agent_models" not in body or not isinstance(body["agent_models"], dict):
            body["agent_models"] = current_config.get("agent_models") or {}
        if "edgeone_vault" not in body or not isinstance(body["edgeone_vault"], dict):
            if "edgeone_vault" in current_config:
                body["edgeone_vault"] = current_config["edgeone_vault"]
        elif isinstance(body.get("edgeone_vault"), dict):
            v_u = body["edgeone_vault"].get("edgeone_url") or body["edgeone_vault"].get("url") or ""
            if v_u:
                body["edgeone_vault"]["url"] = v_u
                body["edgeone_vault"]["edgeone_url"] = v_u
            in_v_tok = (body["edgeone_vault"].get("token") or "").strip()
            curr_v_tok = (current_config.get("edgeone_vault") or {}).get("token")
            if not in_v_tok or is_masked_secret(in_v_tok):
                if curr_v_tok and not is_masked_secret(curr_v_tok):
                    body["edgeone_vault"]["token"] = curr_v_tok
                else:
                    body["edgeone_vault"].pop("token", None)
            else:
                body["edgeone_vault"]["token"] = in_v_tok

        # 2.5 Secret preservation & fail-safe unmasking guard:
        # Front-end receives masked keys (e.g. "●●●●●●●●" or "*******").
        # When saving, unmask each key by restoring the actual secret from current_config.
        curr_providers = current_config.get("providers") or {}
        incoming_providers = body.get("providers")
        deleted_providers = set()
        deleted_keys_set = set()  # set of (p_name, k_lbl) tuples

        if isinstance(incoming_providers, dict) and isinstance(curr_providers, dict):
            deleted_providers = set(curr_providers.keys()) - set(incoming_providers.keys())

            for p_name, curr_p in curr_providers.items():
                if not isinstance(curr_p, dict):
                    continue
                curr_keys = curr_p.get("keys") or {}
                if not isinstance(curr_keys, dict):
                    curr_keys = {}

                if p_name in incoming_providers:
                    in_p = incoming_providers[p_name]
                    in_keys = in_p.get("keys") if isinstance(in_p, dict) else {}
                    if not isinstance(in_keys, dict):
                        in_keys = {}

                    for k_lbl in curr_keys.keys():
                        if k_lbl not in in_keys:
                            deleted_keys_set.add((p_name, k_lbl))

            for p_name, p_data in incoming_providers.items():
                if not isinstance(p_data, dict):
                    continue
                in_keys = p_data.get("keys")
                if isinstance(in_keys, dict):
                    curr_keys = curr_providers.get(p_name, {}).get("keys", {}) if isinstance(curr_providers.get(p_name), dict) else {}
                    for k_lbl, k_val in list(in_keys.items()):
                        orig_secret = curr_keys.get(k_lbl)
                        is_vault_key = isinstance(orig_secret, dict) and (
                            orig_secret.get("origin") == "vault" or orig_secret.get("is_local") is False
                        )
                        if is_vault_key:
                            # 保持中枢 Key 不可篡改明文，强制恢复中枢母本
                            in_keys[k_lbl] = orig_secret
                            continue
                        if is_masked_secret(k_val):
                            if isinstance(k_val, dict):
                                if orig_secret and not is_masked_secret(orig_secret):
                                    real_sec = orig_secret.get("key") if isinstance(orig_secret, dict) else orig_secret
                                    if is_masked_secret(k_val.get("key")):
                                        k_val["key"] = real_sec
                                    in_pk = k_val.get("private_key")
                                    if isinstance(orig_secret, dict):
                                        orig_pk = orig_secret.get("private_key")
                                        if is_masked_secret(in_pk) and orig_pk and not is_masked_secret(orig_pk):
                                            k_val["private_key"] = orig_pk
                                else:
                                    in_keys.pop(k_lbl, None)
                            else:
                                if orig_secret and not is_masked_secret(orig_secret):
                                    in_keys[k_lbl] = orig_secret.get("key") if isinstance(orig_secret, dict) else orig_secret
                                else:
                                    in_keys.pop(k_lbl, None)

        # 级联清理：删除供应商或 Key 时，必须级联删除已添加的关联模型与 Candidate
        if deleted_providers or deleted_keys_set:
            incoming_models = body.get("agent_models")
            if isinstance(incoming_models, dict):
                for m_name, m_data in list(incoming_models.items()):
                    if isinstance(m_data, dict):
                        m_keys = m_data.get("keys")
                        if isinstance(m_keys, list):
                            m_data["keys"] = [
                                k for k in m_keys
                                if isinstance(k, dict)
                                and k.get("provider") not in deleted_providers
                                and (k.get("provider"), k.get("key")) not in deleted_keys_set
                            ]
                            if not m_data["keys"]:
                                del incoming_models[m_name]

            incoming_candidates = body.get("candidates")
            if isinstance(incoming_candidates, dict):
                for cat, c_list in incoming_candidates.items():
                    if isinstance(c_list, list):
                        incoming_candidates[cat] = [
                            c for c in c_list
                            if isinstance(c, dict)
                            and c.get("provider") not in deleted_providers
                            and (c.get("provider"), c.get("key")) not in deleted_keys_set
                        ]

        # 墓碑标记 (Tombstones)：记录用户在本地主动删除的中枢供应商与 Key，杜绝后续同步死灰复燃
        tombstones = set(current_config.get("tombstones") or [])
        tombstone_keys = set(current_config.get("tombstone_keys") or [])
        for dp in deleted_providers:
            tombstones.add(dp)
        for p_name, k_lbl in deleted_keys_set:
            tombstone_keys.add(f"{p_name}:{k_lbl}")
        if isinstance(incoming_providers, dict):
            for ap in incoming_providers.keys():
                tombstones.discard(ap)
                in_keys = incoming_providers[ap].get("keys") or {}
                if isinstance(in_keys, dict):
                    for k_lbl in in_keys.keys():
                        tombstone_keys.discard(f"{ap}:{k_lbl}")
        body["tombstones"] = sorted(list(tombstones))
        body["tombstone_keys"] = sorted(list(tombstone_keys))

        # 3. Rolling encrypted backups (keep last 20)
        try:
            config_dir = _get_config_dir()
            current_enc_file = os.path.join(config_dir, "proxy_config.enc")
            if os.path.exists(current_enc_file):
                timestamp_str = time.strftime("%Y%m%d%H%M%S")
                bak_file = os.path.join(config_dir, f"proxy_config.enc.bak-{timestamp_str}")
                shutil.copy2(current_enc_file, bak_file)
                bak_files = sorted(glob.glob(os.path.join(config_dir, "proxy_config.enc.bak-*")))
                if len(bak_files) > 20:
                    for old_bak in bak_files[:-20]:
                        try:
                            os.remove(old_bak)
                        except Exception:
                            pass
        except Exception as bak_err:
            logger.warning("Failed to create pre-save rolling backup: %s", bak_err)

        # 4. Bump version monotonically
        next_ver = curr_ver + 1
        body["_version"] = next_ver

        new_run_mode = body.get("run_mode")
        if new_run_mode:
            _sync_env_run_mode(new_run_mode)

        await save_config(body)
        vm_logger.info("ConfigAudit", "Configuration saved to disk successfully", version=next_ver, run_mode=new_run_mode or "unchanged")

        for m_name, m_cfg in (body.get("agent_models") or {}).items():
            if isinstance(m_cfg, dict) and m_cfg.get("active_key"):
                from . import scheduler
                scheduler.set_sticky_agent_active_key(m_name, m_cfg["active_key"])
                stats.set_agent_active_key(m_name, m_cfg["active_key"])

        return JSONResponse(content={
            "status": "success",
            "message": "Configuration saved successfully.",
            "_version": next_ver
        })
    except Exception as e:
        vm_logger.error("DiskError", "Failed to persist configuration to disk", error=str(e))
        logger.error("Failed to save config: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": "Failed to save configuration"})


@router.get("/stats")
async def get_stats_endpoint(request: Request):
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    data = stats.get_stats()
    try:
        from .scheduler import get_active_cooldowns
        active_cds = get_active_cooldowns()
        if active_cds and "candidates_status" in data:
            c_status = data["candidates_status"]
            for cid, info in active_cds.items():
                parts = cid.split(":")
                if len(parts) >= 2:
                    prov, key = parts[0], parts[1]
                    model = parts[2] if len(parts) > 2 else ""
                    for k, entry in c_status.items():
                        if prov in k and key in k and (not model or model in k):
                            if info.get("is_quota"):
                                entry["is_quota"] = True
                            # Agent mode keys should not be marked as 'cooling' unless strictly quota-exhausted
                            is_agent_entry = (entry.get("category") == "agent" or k.startswith("agent:"))
                            if info.get("cooling") and not is_agent_entry:
                                entry["cooling"] = True
    except Exception:
        pass

    return JSONResponse(content=data)


@router.post("/stats")
async def post_stats_endpoint(request: Request):
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    if body.get("action") in ("reset", "clear_stats"):
        stats.reset()
        return JSONResponse(content={"status": "success", "message": "All statistics and error logs have been reset."})

    return JSONResponse(status_code=400, content={"error": "Invalid stats action"})


@router.post("/verify-key")
async def verify_key_endpoint(request: Request):
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    base_url = body.get("base_url")
    api_key = body.get("api_key")
    if not base_url or not api_key:
        return JSONResponse(status_code=400, content={"error": "Missing base_url or api_key"})

    protocols = body.get("protocols") or ["chat"]
    provider = body.get("provider") or ""
    anthropic_base_url = body.get("anthropic_base_url")

    try:
        parsed = urlparse(base_url)
    except Exception:
        return JSONResponse(status_code=400, content={"valid": False, "error": "base_url 格式无效"})

    _cfg_for_guard = await get_config()
    for _u in (base_url, anthropic_base_url):
        if not _u:
            continue
        _reason = await _admin_upstream_block_reason(_u, _cfg_for_guard)
        if _reason:
            return JSONResponse(status_code=400, content={"valid": False, "error": _reason})

    results = {}
    overall_valid = True
    error_msgs = []

    # 1. Chat protocol verification
    if "chat" in protocols:
        try:
            url = join_upstream(base_url, "models")
            t0 = time.monotonic()
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
                resp = await client.get(url, headers={
                    "Authorization": f"Bearer {api_key}",
                    "User-Agent": "ocrproxy-verifier/1.0"
                })
                lat_ms = max(1, int((time.monotonic() - t0) * 1000))
                status_code = resp.status_code
                text = resp.text

            if status_code in (200, 201):
                results["chat"] = {"valid": True, "status": status_code, "latency_ms": lat_ms, "message": "鉴权验证通过"}
            elif status_code in (401, 403):
                overall_valid = False
                err = f"密钥无效，上游拒绝访问 (HTTP {status_code})"
                results["chat"] = {"valid": False, "status": status_code, "latency_ms": lat_ms, "error": err}
                error_msgs.append(f"OpenAI Chat: {err}")
            elif status_code in (404, 405):
                chat_url = join_upstream(base_url, "chat/completions")
                async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
                    resp_chat = await client.post(chat_url, headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                        "User-Agent": "ocrproxy-verifier/1.0"
                    }, json={"model": "test-key-probe", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1})
                    sc_chat = resp_chat.status_code
                    chat_text = (resp_chat.text or "").lower()
                    if sc_chat in (200, 201):
                        results["chat"] = {"valid": True, "status": sc_chat, "latency_ms": lat_ms, "message": "鉴权验证通过"}
                    elif sc_chat in (401, 403):
                        overall_valid = False
                        err = f"密钥无效，上游拒绝访问 (HTTP {sc_chat})"
                        results["chat"] = {"valid": False, "status": sc_chat, "latency_ms": lat_ms, "error": err}
                        error_msgs.append(f"OpenAI Chat: {err}")
                    elif sc_chat in (400, 404):
                        is_model_err = any(x in chat_text for x in ("model_not_found", "model", "does not exist"))
                        is_auth_err = any(x in chat_text for x in ("auth", "key", "token", "unauthorized", "permission"))
                        if is_model_err and not is_auth_err:
                            results["chat"] = {"valid": True, "status": sc_chat, "latency_ms": lat_ms, "message": "端点连通，凭据基本有效（上游模型需单独指定）"}
                        else:
                            overall_valid = False
                            err = f"上游返回 HTTP {sc_chat}: {chat_text[:80] or '参数或密钥校验未通过'}"
                            results["chat"] = {"valid": False, "status": sc_chat, "latency_ms": lat_ms, "error": err}
                            error_msgs.append(f"OpenAI Chat: {err}")
                    else:
                        overall_valid = False
                        err = f"上游返回异常状态 (HTTP {sc_chat})"
                        results["chat"] = {"valid": False, "status": sc_chat, "latency_ms": lat_ms, "error": err}
                        error_msgs.append(f"OpenAI Chat: {err}")
            else:
                overall_valid = False
                err = f"上游返回非预期响应 (HTTP {status_code}): {text[:60]}"
                results["chat"] = {"valid": False, "status": status_code, "latency_ms": lat_ms, "error": err}
                error_msgs.append(f"OpenAI Chat: {err}")
        except httpx.ConnectError:
            overall_valid = False
            results["chat"] = {"valid": False, "status": 0, "error": "网络连接异常，无法连通上游服务器"}
            error_msgs.append("OpenAI Chat: 无法连通服务器")
        except Exception as e:
            overall_valid = False
            results["chat"] = {"valid": False, "status": 0, "error": f"请求异常: {str(e)}"}
            error_msgs.append(f"OpenAI Chat: {str(e)}")

    # 2. Messages protocol verification
    if "messages" in protocols:
        try:
            t0 = time.monotonic()
            msg_url = build_messages_upstream(base_url, anthropic_base_url=anthropic_base_url, provider=provider)
            probe_body = {
                "model": "claude-3-5-sonnet-20241022",
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}]
            }
            p_clean = (provider or "").lower().replace(".", "").replace("-", "").strip()
            if p_clean == "minimax":
                probe_body["model"] = "MiniMax-M3"
            elif p_clean == "bai":
                probe_body["model"] = "qwen3.8-flash"
            elif p_clean == "amd":
                probe_body["model"] = "DeepSeek-V4-Flash"

            headers = {
                "Authorization": f"Bearer {api_key}",
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
                "User-Agent": "ocrproxy-verifier/1.0"
            }
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
                resp = await client.post(msg_url, headers=headers, json=probe_body)
                lat_ms = max(1, int((time.monotonic() - t0) * 1000))
                status_code = resp.status_code
                text = resp.text

            if status_code in (200, 201):
                results["messages"] = {"valid": True, "status": status_code, "latency_ms": lat_ms, "message": "鉴权验证通过"}
            elif status_code in (401, 403):
                overall_valid = False
                err = f"密钥无效，Anthropic 端点拒绝访问 (HTTP {status_code})"
                results["messages"] = {"valid": False, "status": status_code, "latency_ms": lat_ms, "error": err}
                error_msgs.append(f"Anthropic Messages: {err}")
            elif status_code in (400, 404):
                lower_text = text.lower()
                is_model_err = any(x in lower_text for x in ("model_not_found", "model", "not found", "does not exist"))
                is_auth_err = any(x in lower_text for x in ("authentication", "unauthorized", "invalid_api_key", "forbidden", "auth", "key", "token"))
                if is_model_err and not is_auth_err:
                    results["messages"] = {"valid": True, "status": status_code, "latency_ms": lat_ms, "message": "端点连通，凭据基本有效（上游模型需单独指定）"}
                else:
                    overall_valid = False
                    err = f"密钥认证失败或格式错误 (HTTP {status_code})"
                    results["messages"] = {"valid": False, "status": status_code, "latency_ms": lat_ms, "error": err}
                    error_msgs.append(f"Anthropic Messages: {err}")
            else:
                overall_valid = False
                err = f"端点返回非预期响应 (HTTP {status_code}): {text[:60]}"
                results["messages"] = {"valid": False, "status": status_code, "latency_ms": lat_ms, "error": err}
                error_msgs.append(f"Anthropic Messages: {err}")
        except httpx.ConnectError:
            overall_valid = False
            results["messages"] = {"valid": False, "status": 0, "error": "网络连接异常，无法连通 Anthropic 端点"}
            error_msgs.append("Anthropic Messages: 无法连通服务器")
        except Exception as e:
            overall_valid = False
            results["messages"] = {"valid": False, "status": 0, "error": f"请求异常: {str(e)}"}
            error_msgs.append(f"Anthropic Messages: {str(e)}")

    # 3. Responses protocol verification (if requested)
    if "responses" in protocols:
        results["responses"] = {"valid": True, "status": 200, "latency_ms": 1, "message": "协议就绪 (未来支持)"}

    if not overall_valid:
        vm_logger.warning(
            "ProbeWarn",
            "Key online verification failed",
            provider=provider or "unknown",
            base_url=base_url,
            protocols=",".join(protocols),
            error="；".join(error_msgs) if error_msgs else "unknown error",
            key=mask_secret(api_key),
        )

    return JSONResponse(content={
        "valid": overall_valid,
        "protocols": results,
        "error": "；".join(error_msgs) if error_msgs else None
    })


@router.post("/test-candidate")
async def test_candidate_endpoint(request: Request):
    """Test a specific candidate route by sending a minimal request."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    provider_name = body.get("provider")
    key_label = body.get("key")
    cand_type = body.get("type", "chat")
    model = body.get("model")
    category = body.get("category", "kb")
    model_name = body.get("model_name") or model

    # HOST.buildTestBody (shared admin UI) sends `model_name`; older callers send `model`.
    model = model or model_name
    # Stats key for agent tests: the agent model name (UI reads agent:<agent_model>:<provider>:<key>).
    # `model_name` is the upstream model in HOST.buildTestBody, so prefer the explicit `agent_model`.
    if category == "agent" and body.get("agent_model"):
        model_name = str(body.get("agent_model"))
    if not provider_name or not key_label or not model:
        return JSONResponse(status_code=400, content={"error": "Missing provider, key, or model"})

    config = await get_config()
    provider = config.get("providers", {}).get(provider_name)
    if not provider:
        return JSONResponse(status_code=400, content={"error": f"Provider '{provider_name}' not found"})

    api_key_raw = provider.get("keys", {}).get(key_label)
    if not api_key_raw:
        return JSONResponse(status_code=400, content={"error": f"Key '{key_label}' not found for provider '{provider_name}'"})

    if isinstance(api_key_raw, dict):
        api_key = str(api_key_raw.get("key", ""))
        base_url = api_key_raw.get("base_url") or provider.get("base_url", "")
    else:
        api_key = str(api_key_raw)
        base_url = provider.get("base_url", "")
    try:
        _reason = await _admin_upstream_block_reason(base_url, config)
        if _reason:
            return JSONResponse(status_code=400, content={"valid": False, "success": False, "error": _reason})
    except Exception:
        return JSONResponse(status_code=400, content={"valid": False, "error": "Invalid upstream URL"})

    if cand_type == "embedding":
        url = join_upstream(base_url, "embeddings")
        test_body = {"model": model, "input": "test"}
    elif cand_type == "reranker":
        url = join_upstream(base_url, "rerank")
        test_body = {"model": model, "query": "test", "documents": ["a"]}
    else:
        url = join_upstream(base_url, "chat/completions")
        test_body = {"model": model, "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 16}
        from .proxy_routes import _normalise_for_provider
        _normalise_for_provider(test_body, provider_name)

    start_t = time.time()
    try:
        req_headers = {
            "Content-Type": "application/json",
        }
        if provider_name.lower() == "vertex" or "aiplatform.googleapis.com" in base_url.lower():
            req_headers["x-goog-api-key"] = str(api_key)
        else:
            req_headers["Authorization"] = f"Bearer {api_key}"

        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0), follow_redirects=False) as client:
            resp = await client.post(url, headers=req_headers, json=test_body)
            lat_sec = time.time() - start_t
            lat_ms = int(round(lat_sec * 1000))

            if 200 <= resp.status_code < 300:
                if category == "agent":
                    stats.record_agent(model_name, resp.status_code, lat_sec, provider=provider_name, key=key_label, is_probe=True, set_active=False)
                else:
                    stats.record_kb(cand_type, resp.status_code, lat_sec, provider=provider_name, key=key_label, model=model, is_probe=True)
                return JSONResponse(content={"success": True, "status": resp.status_code, "latency_ms": lat_ms, "message": "OK"})

            err_text = resp.text[:500] if resp.text else f"HTTP {resp.status_code}"
            vm_logger.warning("ProbeWarn", "Manual test candidate rejected", provider=provider_name, key=key_label, model=model, status=resp.status_code, error=err_text[:100])
            if category == "agent":
                stats.record_agent(model_name, resp.status_code, lat_sec, provider=provider_name, key=key_label, error_msg=f"Manual test failed: {err_text}", is_probe=True, set_active=False)
            else:
                stats.record_kb(cand_type, resp.status_code, lat_sec, provider=provider_name, key=key_label, model=model, error_msg=f"Manual test failed: {err_text}", is_probe=True)
            return JSONResponse(content={
                "success": False,
                "status": resp.status_code,
                "latency_ms": lat_ms,
                "error": resp.text[:500] if resp.text else "No response body"
            })
    except httpx.ReadTimeout:
        lat_sec = time.time() - start_t
        vm_logger.warning("ProbeWarn", "Manual test candidate timed out (30s)", provider=provider_name, key=key_label, model=model)
        stats.record(cand_type, 500, lat_sec, provider=provider_name, key=key_label, category=category, request_model=model_name, cand_model=model, error_msg="Manual test timeout (30s)", is_probe=True, set_active=False)
        return JSONResponse(content={"success": False, "error": "请求超时 (30s)，上游模型可能响应过慢"})
    except httpx.ConnectError as e:
        lat_sec = time.time() - start_t
        vm_logger.warning("ProbeWarn", "Manual test candidate connect failed", provider=provider_name, key=key_label, model=model, error=str(e))
        stats.record(cand_type, 500, lat_sec, provider=provider_name, key=key_label, category=category, request_model=model_name, cand_model=model, error_msg="Manual test connect error", is_probe=True, set_active=False)
        logger.warning("Test candidate connect error: %s", e)
        return JSONResponse(content={"success": False, "error": "连接上游服务器失败"})
    except Exception as e:
        lat_sec = time.time() - start_t
        vm_logger.error("ProbeWarn", "Manual test candidate unexpected error", provider=provider_name, key=key_label, model=model, error=str(e))
        stats.record(cand_type, 500, lat_sec, provider=provider_name, key=key_label, category=category, request_model=model_name, cand_model=model, error_msg=f"Manual test error: {str(e)}", is_probe=True, set_active=False)
        logger.error("Test candidate unexpected error: %s", e, exc_info=True)
        return JSONResponse(content={"success": False, "error": "测试失败"})


@router.post("/test-agent-model")
async def test_agent_model_endpoint(request: Request):
    """Probe ALL keys bound to an agent model in parallel."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    name = body.get("model") or body.get("name")
    if not name:
        return JSONResponse(status_code=400, content={"error": "Missing model name"})

    config = await get_config()
    entry = config.get("agent_models", {}).get(name)
    if not entry:
        return JSONResponse(status_code=404, content={"error": f"Agent model '{name}' not found"})

    bindings = entry.get("keys") or []
    providers = config.get("providers", {})
    sem = asyncio.Semaphore(5)

    async def probe(b):
        provider = providers.get(b.get("provider"))
        if not provider:
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                    "status": None, "latency_ms": None, "error": "Provider not found"}
        api_key_raw = provider.get("keys", {}).get(b.get("key"))
        if not api_key_raw:
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                    "status": None, "latency_ms": None, "error": "Key not found"}
        if isinstance(api_key_raw, dict):
            api_key = str(api_key_raw.get("key", ""))
            base_url = api_key_raw.get("base_url") or provider.get("base_url", "")
        else:
            api_key = str(api_key_raw)
            base_url = provider.get("base_url", "")
        try:
            _reason = await _admin_upstream_block_reason(base_url, config)
            if _reason:
                return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                        "status": None, "latency_ms": None, "error": _reason}
        except Exception:
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                    "status": None, "latency_ms": None, "error": "Invalid upstream URL"}

        model = b.get("upstream_model") or entry.get("upstream_model") or name
        url = join_upstream(base_url, "chat/completions")
        payload = {"model": model, "messages": [{"role": "user", "content": "Hi"}],
                   "max_tokens": 16, "stream": False}
        from .proxy_routes import _normalise_for_provider
        _normalise_for_provider(payload, b.get("provider"))
        start = time.time()
        try:
            req_headers = {
                "Content-Type": "application/json",
            }
            if str(b.get("provider", "")).lower() == "vertex" or "aiplatform.googleapis.com" in url.lower():
                req_headers["x-goog-api-key"] = str(api_key)
            else:
                req_headers["Authorization"] = f"Bearer {api_key}"

            async with sem:
                async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0), follow_redirects=False) as client:
                    resp = await client.post(url, headers=req_headers, json=payload)
            lat_sec = time.time() - start
            latency_ms = int(lat_sec * 1000)
            ok = 200 <= resp.status_code < 300
            if ok:
                stats.record_agent(name, resp.status_code, lat_sec,
                                   provider=b.get("provider"), key=b.get("key"),
                                   is_probe=True, set_active=False)
            else:
                stats.record_agent(name, resp.status_code, lat_sec,
                                   provider=b.get("provider"), key=b.get("key"),
                                   error_msg=f"Probe failed: HTTP {resp.status_code}",
                                   is_probe=True, set_active=False)
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": ok,
                    "status": resp.status_code, "latency_ms": latency_ms,
                    "error": None if ok else resp.text[:200]}
        except httpx.ReadTimeout:
            lat_sec = time.time() - start
            stats.record_agent(name, 500, lat_sec,
                               provider=b.get("provider"), key=b.get("key"),
                               error_msg="Probe timeout (20s)",
                               is_probe=True, set_active=False)
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                    "status": None, "latency_ms": int((time.time() - start) * 1000),
                    "error": "上游超时 (20s)"}
        except httpx.ConnectError as e:
            lat_sec = time.time() - start
            stats.record_agent(name, 500, lat_sec,
                               provider=b.get("provider"), key=b.get("key"),
                               error_msg="Probe connect error",
                               is_probe=True, set_active=False)
            logger.warning("Probe connect error: %s", e)
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                    "status": None, "latency_ms": int((time.time() - start) * 1000),
                    "error": "连接失败"}
        except Exception as e:
            lat_sec = time.time() - start
            stats.record_agent(name, 500, lat_sec,
                               provider=b.get("provider"), key=b.get("key"),
                               error_msg=f"Probe error: {str(e)}",
                               is_probe=True, set_active=False)
            logger.error("Probe unexpected error: %s", e, exc_info=True)
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                    "status": None, "latency_ms": int((time.time() - start) * 1000),
                    "error": "探测异常"}

    results = await asyncio.gather(*[probe(b) for b in bindings]) if bindings else []
    ok_count = sum(1 for r in results if r.get("ok"))
    return JSONResponse(content={
        "success": ok_count > 0,
        "model": name,
        "total": len(results),
        "ok": ok_count,
        "results": results,
        "checked_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    })


@router.post("/restart")
async def restart_service_endpoint(request: Request):
    """Gracefully restart the OCRProxy systemd service."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    logger.warning("Admin requested OCRProxy service restart via web interface")

    async def _do_restart():
        await asyncio.sleep(0.5)
        try:
            proc = await asyncio.create_subprocess_exec("sudo", "systemctl", "restart", "ocrproxy")
            await proc.wait()
        except Exception as e:
            logger.error(f"Failed to restart service via systemctl: {e}")

    asyncio.create_task(_do_restart())
    return JSONResponse(content={
        "success": True,
        "message": "服务正在平滑重启中，约 2-3 秒后恢复"
    })


def _parse_version_tuple(v_str: str) -> tuple:
    """Parse vYYYY.MM.DD[-NN] or semver into comparable tuple."""
    if not v_str:
        return (0, 0, 0, 0)
    s = v_str.strip().lstrip("v")
    # Check for date version like 2026.10.04-01 or 2026.10.04
    m = re.match(r"^(\d{4})\.(\d{2})\.(\d{2})(?:-(\d+))?$", s)
    if m:
        year, month, day, patch = m.groups()
        return (int(year), int(month), int(day), int(patch or 0))
    # Fallback to standard semver numbers
    parts = []
    for x in re.split(r"[\.-]", s):
        if x.isdigit():
            parts.append(int(x))
    while len(parts) < 4:
        parts.append(0)
    return tuple(parts[:4])


def _load_local_version_info() -> dict:
    """Read local version.json from project root or /opt/ocrproxy, picking the latest version."""
    search_paths = [
        Path(__file__).resolve().parent.parent / "version.json",
        Path(__file__).resolve().parent.parent.parent / "version.json",
        Path("/opt/ocrproxy/version.json"),
    ]
    candidates = []
    for p in search_paths:
        if p.is_file():
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict) and "version" in data:
                        candidates.append(data)
            except Exception:
                pass
    if candidates:
        # Sort by version tuple descending to always reflect the highest/latest installed version
        candidates.sort(key=lambda d: _parse_version_tuple(d.get("version")), reverse=True)
        return candidates[0]
    return {
        "version": "v2026.10.07-01",
        "release_date": "2026-10-06",
        "title": "OCRProxy VM Gateway",
        "changelog": []
    }


@router.get("/system/version")
async def get_system_version_endpoint(request: Request):
    """Return local application version information."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    info = _load_local_version_info()
    return JSONResponse(content={
        "ok": True,
        "current_version": info.get("version", "v2026.10.07-01"),
        "release_date": info.get("release_date", ""),
        "commit": info.get("commit", ""),
        "title": info.get("title", ""),
        "changelog": info.get("changelog", [])
    })


@router.get("/system/check-update")
async def check_system_update_endpoint(request: Request):
    """Check for new OCRProxy releases from GitHub or CN mirror fallbacks."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    local_info = _load_local_version_info()
    curr_v = local_info.get("version", "v2026.10.07-01")

    # 多源检测链：官方 GitHub -> 国内镜像 (ghfast) -> CDN (jsDelivr)
    remote_urls = [
        "https://raw.githubusercontent.com/khc8655/ocrproxy/main/version.json",
        "https://ghfast.top/https://raw.githubusercontent.com/khc8655/ocrproxy/main/version.json",
        "https://cdn.jsdelivr.net/gh/khc8655/ocrproxy@main/version.json",
    ]
    remote_data = None
    fetch_error = None
    async with httpx.AsyncClient(timeout=3.5, follow_redirects=True) as client:
        for url in remote_urls:
            try:
                resp = await client.get(url)
                if resp.status_code == 200:
                    remote_data = resp.json()
                    if isinstance(remote_data, dict) and "version" in remote_data:
                        break
            except Exception as e:
                fetch_error = str(e)
                logger.warning(f"Failed to fetch remote version from {url}: {e}")

    if not remote_data or not isinstance(remote_data, dict) or "version" not in remote_data:
        return JSONResponse(content={
            "ok": False,
            "network_error": True,
            "has_update": False,
            "current_version": curr_v,
            "latest_version": curr_v,
            "release_date": local_info.get("release_date", ""),
            "title": local_info.get("title", ""),
            "changelog": local_info.get("changelog", []),
            "checked_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "notice": f"未能连接到 GitHub 或国内镜像更新源: {fetch_error or '网络超时'}"
        })

    latest_v = remote_data.get("version", curr_v)
    curr_tuple = _parse_version_tuple(curr_v)
    latest_tuple = _parse_version_tuple(latest_v)
    has_update = latest_tuple > curr_tuple

    return JSONResponse(content={
        "ok": True,
        "network_error": False,
        "has_update": has_update,
        "current_version": curr_v,
        "latest_version": latest_v,
        "release_date": remote_data.get("release_date", ""),
        "title": remote_data.get("title", ""),
        "changelog": remote_data.get("changelog", []),
        "checked_at": time.strftime("%Y-%m-%d %H:%M:%S")
    })


@router.post("/system/upgrade")
async def upgrade_system_endpoint(request: Request):
    """Trigger background smooth upgrade for OCRProxy."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    logger.warning("Admin requested OCRProxy system OTA upgrade via web interface")

    async def _do_upgrade():
        await asyncio.sleep(0.5)
        success = False
        # 1. 尝试调用 systemd-run 逃逸当前沙箱独立执行升级，若不可用则回退本地执行
        for cmd in [
            ["sudo", "-n", "/usr/bin/systemd-run", "--unit=ocrproxy-ota-upgrade", "--collect", "--setenv=OCRPROXY_RUNNING_IN_OTA_UNIT=1", "/usr/local/bin/ocrproxy", "upgrade"],
            ["sudo", "-n", "systemd-run", "--unit=ocrproxy-ota-upgrade", "--collect", "--setenv=OCRPROXY_RUNNING_IN_OTA_UNIT=1", "/usr/local/bin/ocrproxy", "upgrade"],
            ["sudo", "-n", "bash", "-c", "curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/khc8655/ocrproxy/main/install.sh | bash -s -- --upgrade"],
            ["sudo", "-n", "/usr/local/bin/ocrproxy", "upgrade"],
            ["/usr/local/bin/ocrproxy", "upgrade"],
            ["bash", "-c", "curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/khc8655/ocrproxy/main/install.sh | bash -s -- --upgrade"],
            ["sudo", "-n", "bash", "-c", "curl -fsSL https://raw.githubusercontent.com/khc8655/ocrproxy/main/install.sh | bash -s -- --upgrade"],
            ["bash", "-c", "curl -fsSL https://raw.githubusercontent.com/khc8655/ocrproxy/main/install.sh | bash -s -- --upgrade"],
        ]:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, stderr = await proc.communicate()
                if proc.returncode == 0:
                    logger.info(f"OCRProxy system upgrade succeeded via: {' '.join(cmd)}")
                    success = True
                    break
                else:
                    logger.warning(f"Upgrade attempt with {' '.join(cmd)} exited with {proc.returncode}: {stderr.decode(errors='ignore')[:300]}")
            except Exception as e:
                logger.warning(f"Upgrade attempt with {' '.join(cmd)} raised: {e}")

        if not success:
            logger.error("All system upgrade command variants failed")

    asyncio.create_task(_do_upgrade())
    return JSONResponse(content={
        "ok": True,
        "message": "程序升级任务已成功派发至后台执行"
    })


@router.post("/probe-models")
async def probe_models_endpoint(request: Request):
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    provider = (body.get("provider") or "").strip()
    base_url = (body.get("base_url") or "").strip()
    api_key = (body.get("api_key") or "").strip()
    key_label = (body.get("key_label") or "").strip()
    key_labels = body.get("key_labels") or []
    if isinstance(key_labels, str):
        key_labels = [key_labels] if key_labels.strip() else []
    if key_label and key_label not in key_labels:
        key_labels.insert(0, key_label)

    # 1. 整理待测试的 key 候选池: list of (label, key_secret)
    candidate_keys = []
    if api_key:
        candidate_keys.append(("自定义Key", api_key))

    cfg = await get_config()
    _probe_cfg = cfg
    p_local = cfg.get("providers", {}).get(provider, {})
    if not base_url:
        base_url = p_local.get("base_url", "")

    local_keys = p_local.get("keys", {})
    # 如果指定了 key_labels，优先拉取匹配的
    for kl in key_labels:
        if kl in local_keys and local_keys[kl]:
            candidate_keys.append((kl, local_keys[kl]))
    # 如果没指定或未匹配到，且是已知本地 provider，则添加本地全部 key
    if not candidate_keys and local_keys:
        for kl, ksec in local_keys.items():
            if ksec:
                candidate_keys.append((kl, ksec))

    # 2. 若本地无 key 或无 base_url，尝试从中枢 EdgeOne 获取
    edgeone_url, token = await _get_vault_credentials()
    headers_vault = {"Accept": "application/json"}
    if token:
        headers_vault["Authorization"] = f"Bearer {token}"

    if provider and (not base_url or not candidate_keys):
        try:
            async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
                # 检查 manifest
                target_vault_keys = list(key_labels)
                mf_res = await client.get(f"{edgeone_url}/api/vault/manifest", headers=headers_vault)
                if mf_res.is_success:
                    manifest = mf_res.json()
                    v_providers = manifest.get("providers") or {}
                    v_p = v_providers.get(provider)
                    if not v_p:
                        # 尝试大小写不敏感匹配
                        for vk, vv in v_providers.items():
                            if vk.lower() == provider.lower():
                                v_p = vv
                                provider = vk
                                break
                    v_p = v_p or {}

                    if not base_url:
                        base_url = v_p.get("base_url") or ""
                    if not target_vault_keys:
                        raw_vk = v_p.get("keys") or []
                        for k in raw_vk:
                            if isinstance(k, str) and k.strip():
                                target_vault_keys.append(k.strip())
                            elif isinstance(k, dict) and k.get("label"):
                                target_vault_keys.append(k.get("label").strip())

                # 逐个从中枢拉取 key
                for kl in target_vault_keys:
                    if any(c[0] == kl for c in candidate_keys):
                        continue
                    try:
                        fk_res = await client.post(
                            f"{edgeone_url}/api/vault/fetch",
                            headers={**headers_vault, "Content-Type": "application/json"},
                            json={"provider": provider, "key_label": kl}
                        )
                        if fk_res.is_success:
                            fk_data = fk_res.json()
                            if fk_data.get("ok"):
                                r_keys = (fk_data.get("provider_config") or {}).get("keys") or {}
                                ksec = r_keys.get(kl) or (next(iter(r_keys.values())) if r_keys else "")
                                if ksec:
                                    candidate_keys.append((kl, ksec))
                    except Exception as fe:
                        logger.warning("Vault fetch key %s for %s failed: %s", kl, provider, fe)
        except Exception as e:
            logger.warning("Failed to query vault for provider %s: %s", provider, e)

    if not candidate_keys:
        return JSONResponse(status_code=400, content={"error": f"未找到供应商 [{provider}] 的可用 API Key（请先配置或勾选有效凭据）"})

    # 3. 针对 Google 或通用 OpenAI 进行探测并执行 Fallback 轮询
    is_google = provider.lower() == "google" or "generativelanguage.googleapis.com" in base_url.lower()

    probe_errors = []
    for label, sec_key in candidate_keys:
        cand_base_url = base_url
        cand_api_key = sec_key
        if isinstance(sec_key, dict):
            cand_api_key = str(sec_key.get("key", ""))
            cand_base_url = sec_key.get("base_url") or base_url

        probe_targets = []
        if is_google:
            # Google 原生 query key 端点与兼容端点
            probe_targets.append({
                "url": f"https://generativelanguage.googleapis.com/v1beta/openai/models",
                "headers": {"Accept": "application/json", "Authorization": f"Bearer {cand_api_key}", "User-Agent": "ocrproxy-prober/1.0"}
            })
            probe_targets.append({
                "url": f"https://generativelanguage.googleapis.com/v1beta/models?key={cand_api_key}",
                "headers": {"Accept": "application/json", "User-Agent": "ocrproxy-prober/1.0"}
            })
        else:
            cand_u = join_upstream(cand_base_url, "models")
            probe_targets.append({
                "url": cand_u,
                "headers": {"Accept": "application/json", "Authorization": f"Bearer {cand_api_key}", "User-Agent": "ocrproxy-prober/1.0"}
            })

        # 尝试当前 key 的各个探针端点
        for pt in probe_targets:
            u = pt["url"]
            hdrs = pt["headers"]
            try:
                _reason = await _admin_upstream_block_reason(u, _probe_cfg)
                if _reason:
                    probe_errors.append(f"[{label}] {u} -> {_reason}")
                    continue
            except Exception as pe:
                probe_errors.append(f"[{label}] {u} -> 探针 URL 无效: {pe}")
                continue

            try:
                async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
                    res = await client.get(u, headers=hdrs)
                    if not res.is_success:
                        err_detail = ""
                        try:
                            err_json = res.json()
                            if isinstance(err_json, dict):
                                if "error" in err_json:
                                    e_val = err_json["error"]
                                    if isinstance(e_val, dict) and "message" in e_val:
                                        err_detail = e_val["message"]
                                    elif isinstance(e_val, str):
                                        err_detail = e_val
                                elif "message" in err_json:
                                    err_detail = err_json["message"]
                        except Exception:
                            pass
                        if not err_detail:
                            err_detail = res.reason_phrase
                        probe_errors.append(f"[{label}] {u} -> HTTP {res.status_code}: {err_detail}")
                        continue
                    data = res.json()
                    raw_list = []
                    if isinstance(data, dict):
                        if isinstance(data.get("data"), list):
                            raw_list = data["data"]
                        elif isinstance(data.get("models"), list):
                            raw_list = data["models"]
                    elif isinstance(data, list):
                        raw_list = data

                    models = []
                    for m in raw_list:
                        m_str = m if isinstance(m, str) else (m.get("id") or m.get("name") or "")
                        if m_str:
                            # 针对 Google 规范化模型名 models/gemini-pro -> gemini-pro
                            if m_str.startswith("models/"):
                                m_str = m_str[7:]
                            models.append(m_str)

                    models = sorted(list(set(models)))
                    if models:
                        return JSONResponse(content={
                            "ok": True,
                            "models": models,
                            "count": len(models),
                            "endpoint": u,
                            "used_key_label": label
                        })
            except Exception as e:
                probe_errors.append(f"[{label}] {u} -> {str(e)}")

    err_summary = "; ".join(probe_errors[-3:]) if probe_errors else "探测失败，上游未返回有效模型"
    return JSONResponse(content={"ok": False, "models": [], "count": 0, "error": err_summary})


async def _get_vault_credentials(body: dict = None) -> tuple[str, str]:
    body = body or {}
    cfg = await get_config()
    v_cfg = cfg.get("edgeone_vault") or {}

    edgeone_url = (
        body.get("edgeone_url")
        or body.get("url")
        or v_cfg.get("edgeone_url")
        or v_cfg.get("url")
        or os.environ.get("EDGEONE_VAULT_URL")
        or ""
    ).strip().rstrip("/")

    in_tok = (body.get("token") or "").strip()
    if is_masked_secret(in_tok):
        in_tok = ""

    token = (
        in_tok
        or v_cfg.get("token")
        or os.environ.get("EDGEONE_VAULT_TOKEN")
        or os.environ.get("VAULT_ACCESS_TOKEN")
        or ""
    ).strip()
    if is_masked_secret(token):
        token = ""

    return edgeone_url, token


@router.post("/vault/manifest")
async def vault_manifest_endpoint(request: Request):
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    edgeone_url, token = await _get_vault_credentials(body)
    if not edgeone_url:
        return JSONResponse(status_code=400, content={"ok": False, "error": "未配置 EdgeOne 凭据中枢地址，请在「系统设置」中配置中枢 URL"})

    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            res = await client.get(f"{edgeone_url}/api/vault/manifest", headers=headers)
            if res.status_code == 401:
                return JSONResponse(status_code=401, content={
                    "ok": False,
                    "error": "EdgeOne 中枢鉴权失败 (HTTP 401)。请核对中枢访问 Token 是否与 EdgeOne 环境变量 VAULT_ACCESS_TOKEN 完全一致。"
                })
            if not res.is_success:
                return JSONResponse(status_code=res.status_code, content={
                    "ok": False,
                    "error": f"EdgeOne 中枢返回 HTTP {res.status_code}: {res.text[:150]}"
                })
            return JSONResponse(content=res.json())
    except httpx.ConnectError as ce:
        logger.error("Failed to connect to EdgeOne Vault manifest: %s", ce)
        return JSONResponse(status_code=502, content={"ok": False, "error": f"无法连接到 EdgeOne 中枢 ({edgeone_url})，网络连接异常"})
    except httpx.TimeoutException:
        return JSONResponse(status_code=504, content={"ok": False, "error": f"连接 EdgeOne 中枢超时 (>10s): {edgeone_url}"})
    except Exception as e:
        logger.error("Failed to connect to EdgeOne Vault manifest: %s", e)
        return JSONResponse(status_code=502, content={"ok": False, "error": f"连接 EdgeOne 中枢异常: {str(e)}"})


@router.post("/vault/fetch-key")
async def vault_fetch_key_endpoint(request: Request):
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    provider = body.get("provider")
    key_label = body.get("key_label")
    if not provider or not key_label:
        return JSONResponse(status_code=400, content={"error": "Missing provider or key_label"})

    # 1. 免密公共凭据兜底：直接本地持久化就绪，免打扰中枢
    if key_label in ("public", "__public__"):
        cfg = await get_config()
        providers = cfg.setdefault("providers", {})
        local_p = providers.setdefault(provider, {})
        local_p["name"] = local_p.get("name") or provider
        local_p["origin"] = "vault"
        local_keys = local_p.setdefault("keys", {})
        local_keys[key_label] = "public"
        await save_config(cfg)
        return JSONResponse(content={"ok": True, "provider": provider, "key_label": key_label, "imported": True})

    edgeone_url, token = await _get_vault_credentials(body)
    if not edgeone_url:
        return JSONResponse(status_code=400, content={"ok": False, "error": "未配置 EdgeOne 凭据中枢地址，请在「系统设置」中配置中枢 URL"})
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            res = await client.post(
                f"{edgeone_url}/api/vault/fetch",
                headers=headers,
                json={"provider": provider, "key_label": key_label}
            )
            if res.status_code == 401:
                return JSONResponse(status_code=401, content={
                    "ok": False,
                    "error": "EdgeOne 中枢凭据鉴权失败 (HTTP 401)。请核对中枢访问 Token 是否与 EdgeOne 环境变量 VAULT_ACCESS_TOKEN 完全一致。"
                })
            if not res.is_success:
                return JSONResponse(status_code=res.status_code, content={
                    "ok": False,
                    "error": f"EdgeOne 中枢返回 HTTP {res.status_code}: {res.text[:150]}"
                })
            data = res.json()
            if not data.get("ok"):
                return JSONResponse(status_code=400, content=data)

            # Auto-import into local config_store: Cloud is authoritative and overwrites provider config
            prov_cfg = data.get("provider_config") or {}
            cfg = await get_config()
            providers = cfg.setdefault("providers", {})
            local_p = providers.setdefault(provider, {})
            local_p["origin"] = "vault"

            # 1. Overwrite identity & protocols strictly from cloud
            local_p["name"] = prov_cfg.get("name") or provider
            protocol = prov_cfg.get("protocol") or "openai"
            local_p["protocol"] = protocol

            raw_protos = prov_cfg.get("protocols")
            if not raw_protos or not isinstance(raw_protos, list):
                raw_protos = ["messages"] if protocol == "messages" else ["chat"]
            local_p["protocols"] = raw_protos
            local_p["anthropic_messages"] = bool(prov_cfg.get("anthropic_messages") or ("messages" in raw_protos))

            # 2. Overwrite URLs strictly from cloud
            if prov_cfg.get("base_url"):
                local_p["base_url"] = prov_cfg["base_url"]
            if prov_cfg.get("anthropic_base_url"):
                local_p["anthropic_base_url"] = prov_cfg["anthropic_base_url"]
            elif "anthropic_base_url" in local_p and not local_p["anthropic_messages"]:
                del local_p["anthropic_base_url"]

            # 3. Overwrite adapter rules & cached models & rpm limit
            if prov_cfg.get("adapter_rules") is not None:
                local_p["adapter_rules"] = prov_cfg["adapter_rules"]
            if prov_cfg.get("cached_models") is not None:
                local_p["cached_models"] = prov_cfg["cached_models"]
            if prov_cfg.get("rpm_per_key") is not None:
                local_p["rpm_per_key"] = prov_cfg["rpm_per_key"]

            # 4. Merge keys: Cloud keys overwrite, local-only keys are preserved
            local_keys = local_p.setdefault("keys", {})
            remote_keys = prov_cfg.get("keys") or {}
            for k_lbl, k_val in remote_keys.items():
                if k_lbl and k_val:
                    local_keys[k_lbl] = k_val

            await save_config(cfg)
            return JSONResponse(content={"ok": True, "provider": provider, "key_label": key_label, "imported": True})
    except httpx.ConnectError as ce:
        logger.error("Failed to fetch key from EdgeOne Vault: %s", ce)
        return JSONResponse(status_code=502, content={"ok": False, "error": f"拉取密钥失败: 无法连接至 {edgeone_url}"})
    except httpx.TimeoutException:
        return JSONResponse(status_code=504, content={"ok": False, "error": f"拉取密钥超时 (>10s): {edgeone_url}"})
    except Exception as e:
        logger.error("Failed to fetch key from EdgeOne Vault: %s", e)
        return JSONResponse(status_code=502, content={"ok": False, "error": f"拉取密钥失败: {str(e)}"})


@router.post("/vault/sync")
async def vault_sync_endpoint(request: Request):
    """Manually sync rules and metadata for active providers from EdgeOne Hub."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    edgeone_url, token = await _get_vault_credentials(body)
    if not edgeone_url:
        return JSONResponse(status_code=400, content={"ok": False, "error": "未配置 EdgeOne 凭据中枢地址，请在「系统设置」中配置中枢 URL"})
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            res = await client.get(f"{edgeone_url}/api/vault/manifest", headers=headers)
            if res.status_code == 401:
                return JSONResponse(status_code=401, content={
                    "ok": False,
                    "error": "EdgeOne 中枢凭据鉴权失败 (HTTP 401)。请在系统设置中核对中枢 Token"
                })
            if not res.is_success:
                return JSONResponse(status_code=res.status_code, content={
                    "ok": False,
                    "error": f"EdgeOne 中枢返回 HTTP {res.status_code}: {res.text[:150]}"
                })
            manifest = res.json()
            remote_providers = manifest.get("providers") or {}

            cfg = await get_config()
            local_providers = cfg.setdefault("providers", {})
            updated = 0
            created = 0

            # 严格精准增量同步：仅同步当前本地已配置的提供商，绝不强塞未配置的中枢提供商
            # 严格遵守本地删除墓碑 (tombstones)，已被用户删除的提供商与 Key 绝不复活
            tombstones = set(cfg.get("tombstones") or [])
            tombstone_keys = set(cfg.get("tombstone_keys") or [])
            active_pids = set(local_providers.keys())

            target_pids = [
                p_id for p_id in remote_providers.keys()
                if (p_id in active_pids or p_id.lower() in [x.lower() for x in active_pids])
                and p_id not in tombstones
                and p_id.lower() not in [x.lower() for x in tombstones]
            ]

            if not target_pids:
                return JSONResponse(content={
                    "ok": True,
                    "updated": 0,
                    "created": 0,
                    "message": "当前本地尚未添加任何对应中枢提供商，无需同步。如需使用中枢供应商，请前往「供应商」页面添加。"
                })

            for p_id in target_pids:
                r_p = remote_providers[p_id]
                if not isinstance(r_p, dict):
                    continue
                is_new = p_id not in local_providers
                p_cfg = local_providers.setdefault(p_id, {})
                p_cfg["origin"] = "vault"

                # 1. 基础元数据落库（云端权威覆盖）
                p_cfg["name"] = r_p.get("name") or p_id
                if r_p.get("base_url"):
                    p_cfg["base_url"] = r_p["base_url"]
                
                proto = r_p.get("protocol") or p_cfg.get("protocol") or "openai"
                p_cfg["protocol"] = proto

                raw_protos = r_p.get("protocols")
                if not raw_protos or not isinstance(raw_protos, list):
                    raw_protos = ["messages"] if proto == "messages" else ["chat"]
                p_cfg["protocols"] = raw_protos
                p_cfg["anthropic_messages"] = bool(r_p.get("anthropic_messages") or ("messages" in raw_protos))

                if r_p.get("anthropic_base_url"):
                    p_cfg["anthropic_base_url"] = r_p["anthropic_base_url"]
                elif "anthropic_base_url" in p_cfg and not p_cfg["anthropic_messages"]:
                    del p_cfg["anthropic_base_url"]

                if r_p.get("adapter_rules") is not None:
                    p_cfg["adapter_rules"] = r_p["adapter_rules"]
                if r_p.get("models"):
                    p_cfg["cached_models"] = r_p["models"]
                if r_p.get("rpm_per_key"):
                    p_cfg["rpm_per_key"] = r_p["rpm_per_key"]

                # 2. 自动拉取中枢该提供商的密钥（严格保留已有本地自建 Key，且过滤本地删除墓碑）
                remote_key_labels = r_p.get("keys") or []
                local_keys = p_cfg.setdefault("keys", {})
                missing_labels = [
                    kl for kl in remote_key_labels
                    if isinstance(kl, str)
                    and f"{p_id}:{kl}" not in tombstone_keys
                    and (
                        kl not in local_keys or
                        not local_keys[kl] or
                        (isinstance(local_keys[kl], dict) and not local_keys[kl].get("is_local"))
                    )
                ]

                for kl in missing_labels:
                    # 如果本地同名 Key 已经被标记为本地自建 (is_local=True)，绝对不被中枢覆盖
                    existing_key_obj = local_keys.get(kl)
                    if isinstance(existing_key_obj, dict) and existing_key_obj.get("is_local"):
                        continue

                    try:
                        fk_res = await client.post(
                            f"{edgeone_url}/api/vault/fetch",
                            headers=headers,
                            json={"provider": p_id, "key_label": kl}
                        )
                        if fk_res.is_success:
                            fk_data = fk_res.json()
                            if fk_data.get("ok"):
                                r_keys = (fk_data.get("provider_config") or {}).get("keys") or {}
                                if kl in r_keys and r_keys[kl]:
                                    local_keys[kl] = r_keys[kl]
                    except Exception as fe:
                        logger.warning(f"Failed to fetch key {kl} for provider {p_id} during sync: {fe}")

                if is_new:
                    created += 1
                else:
                    updated += 1

            if updated > 0 or created > 0:
                await save_config(cfg)

            msg = f"中枢同步完成：已精准增量更新 {updated} 个已配置供应商的最新中枢端点与密钥"
            return JSONResponse(content={
                "ok": True,
                "message": msg,
                "created_count": created,
                "updated_count": updated
            })
    except httpx.ConnectError as ce:
        logger.error("Failed to sync from EdgeOne Vault: %s", ce)
        return JSONResponse(status_code=502, content={"ok": False, "error": f"同步失败: 无法连接至 {edgeone_url}"})
    except httpx.TimeoutException:
        return JSONResponse(status_code=504, content={"ok": False, "error": f"同步中枢超时 (>10s): {edgeone_url}"})
    except Exception as e:
        logger.error("Failed to sync from EdgeOne Vault: %s", e)
        return JSONResponse(status_code=502, content={"ok": False, "error": f"同步失败: {str(e)}"})


@router.post("/vault/test")
async def vault_test_endpoint(request: Request):
    """Diagnose EdgeOne Vault connectivity, authentication, and provider inventory."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    edgeone_url, token = await _get_vault_credentials(body)
    if not edgeone_url:
        return JSONResponse(status_code=400, content={"ok": False, "error": "请先在上方输入 EdgeOne 凭据中枢服务地址"})
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    import time
    t0 = time.time()
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            res = await client.get(f"{edgeone_url}/api/vault/manifest", headers=headers)
            elapsed_ms = int((time.time() - t0) * 1000)
            if res.status_code == 401:
                return JSONResponse(status_code=401, content={
                    "ok": False,
                    "status_code": 401,
                    "edgeone_url": edgeone_url,
                    "error": "EdgeOne 中枢鉴权失败 (HTTP 401)。请核对 Token 是否与 EdgeOne 环境变量 VAULT_ACCESS_TOKEN 完全一致。"
                })
            if not res.is_success:
                return JSONResponse(status_code=res.status_code, content={
                    "ok": False,
                    "status_code": res.status_code,
                    "edgeone_url": edgeone_url,
                    "error": f"EdgeOne 中枢响应异常 HTTP {res.status_code}: {res.text[:150]}"
                })
            data = res.json()
            providers = data.get("providers") or {}
            google_info = providers.get("google") or {}
            google_keys = google_info.get("keys") or []
            return JSONResponse(content={
                "ok": True,
                "status_code": 200,
                "latency_ms": elapsed_ms,
                "edgeone_url": edgeone_url,
                "providers_count": len(providers),
                "provider_ids": sorted(list(providers.keys())),
                "google_keys_count": len(google_keys),
                "google_keys": google_keys
            })
    except httpx.ConnectError as ce:
        return JSONResponse(status_code=502, content={
            "ok": False,
            "error": f"无法连接到 EdgeOne 中枢 ({edgeone_url})，网络连接异常: {str(ce)}"
        })
    except httpx.TimeoutException:
        return JSONResponse(status_code=504, content={
            "ok": False,
            "error": f"连接 EdgeOne 中枢超时 (>8s): {edgeone_url}"
        })
    except Exception as e:
        return JSONResponse(status_code=500, content={
            "ok": False,
            "error": f"探测 EdgeOne 凭据中枢未知异常: {str(e)}"
        })


@router.post("/vault/config")
async def vault_config_endpoint(request: Request):
    """Persist EdgeOne Vault connection settings directly into proxy_config.enc without touching .env."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    body = {}
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    edgeone_url = (body.get("edgeone_url") or body.get("url") or "").strip().rstrip("/")
    token = (body.get("token") or "").strip()

    cfg = await get_config()
    v_cfg = cfg.setdefault("edgeone_vault", {})
    if edgeone_url:
        v_cfg["url"] = edgeone_url
        v_cfg["edgeone_url"] = edgeone_url
    if token and not is_masked_secret(token):
        v_cfg["token"] = token
    await save_config(cfg)

    saved_token = v_cfg.get("token", "")
    masked = (saved_token[:4] + "****" + saved_token[-4:]) if len(saved_token) > 8 else "***"
    return JSONResponse(content={
        "ok": True,
        "edgeone_vault": {
            "url": v_cfg.get("url") or "",
            "edgeone_url": v_cfg.get("edgeone_url") or "",
            "token_masked": masked
        },
        "message": "EdgeOne 凭据中枢配置已成功持久化保存至本地加密文件"
    })

