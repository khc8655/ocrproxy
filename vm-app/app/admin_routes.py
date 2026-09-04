import os
import copy
import json
import shutil
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

from .config_store import get_config, save_config, _get_config_dir
from .upstream import join_upstream, build_messages_upstream
from . import stats
from .auth import verify_admin_auth

router = APIRouter(prefix="/api/admin")
logger = logging.getLogger("admin_routes")

ALLOWED_STAT_TYPES = {"chat", "embedding", "reranker", "ocr"}


def _check_auth(request: Request) -> bool:
    return verify_admin_auth(request)


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


def _merge_configs(base: dict, incoming: dict, local_run_mode: str = "full") -> dict:
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
            else:
                if p_val.get("base_url"):
                    merged_providers[p_name]["base_url"] = p_val["base_url"]
                merged_keys = merged_providers[p_name].setdefault("keys", {})
                incoming_keys = p_val.get("keys", {})
                if isinstance(incoming_keys, dict):
                    for k_name, k_secret in incoming_keys.items():
                        if k_name and k_secret:
                            merged_keys[k_name] = k_secret

    # 2. Merge candidates (KB mode / Full mode only)
    if local_run_mode in ("kb", "full"):
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
    else:
        # In Agent mode, strip any candidates
        merged["candidates"] = {"chat": [], "embedding": [], "reranker": [], "ocr": []}

    # 3. Merge agent_models (Agent mode / Full mode only)
    if local_run_mode in ("agent", "full"):
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
    else:
        # In KB mode, strip any agent models
        merged["agent_models"] = {}

    # 4. Update top-level setting parameters if present in incoming (EXCLUDING run_mode)
    setting_keys = [
        "proxy_api_key", "proxy_keys",
        "agent_routing_strategy", "kb_routing_strategy", "auto_restart_enabled",
        "request_total_budget_sec", "upstream_timeout_sec", "max_attempts_per_provider",
        "fast_failover_provider_down",
        "upstream_timeout", "upstream_timeout_chat", "upstream_timeout_embedding",
        "upstream_timeout_rerank", "upstream_timeout_ocr", "chat_fast_timeout",
        "schedule_total_budget", "max_concurrency_per_key",
        "cooldown_tpm_sec", "cooldown_quota_sec", "cooldown_5xx_sec",
        "cooldown_429_sec", "cooldown_403_sec", "cooldown_duration",
        "circuit_break_threshold", "circuit_cooldown_sec", "latency_based_routing"
    ]
    for sk in setting_keys:
        if sk in incoming:
            merged[sk] = incoming[sk]

    # 5. Merge Schema v2 settings block if present
    incoming_settings = incoming.get("settings")
    if isinstance(incoming_settings, dict):
        merged_settings = merged.setdefault("settings", {})
        for k, v in incoming_settings.items():
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
        resp_data = dict(config)
        run_mode = os.environ.get("RUN_MODE") or config.get("run_mode") or "full"
        run_mode = run_mode.lower().strip()
        if run_mode not in ("agent", "kb", "full"):
            run_mode = "full"
        resp_data["_run_mode"] = run_mode
        resp_data["run_mode"] = run_mode
        return JSONResponse(content=resp_data)
    except Exception as e:
        logger.error("Failed to get config: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": "Failed to load configuration"})



# ── Preset Hub & Remote Distribution ─────────────────────────────────
_CATALOG_CACHE: dict = {"data": None, "expires_at": 0}
_PRESET_REMOTE_CACHE: dict = {}

_CDN_CATALOG_URLS = [
    "https://cdn.jsdelivr.net/gh/khc8655/ocrproxy@main/shared/presets/catalog.json",
    "https://raw.githubusercontent.com/khc8655/ocrproxy/main/shared/presets/catalog.json",
]

_CDN_PRESET_BASE_URLS = [
    "https://cdn.jsdelivr.net/gh/khc8655/ocrproxy@main/shared/presets",
    "https://raw.githubusercontent.com/khc8655/ocrproxy/main/shared/presets",
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
    preset_file = _get_presets_dir() / f"{preset_id}.json"
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
    if _CATALOG_CACHE["data"] and _CATALOG_CACHE["expires_at"] > now:
        return JSONResponse(content={"ok": True, "source": "cache", "catalog": _CATALOG_CACHE["data"]})

    catalog_data = await _fetch_remote_json(_CDN_CATALOG_URLS, timeout=2.0)
    source = "remote"
    if not catalog_data:
        catalog_data = _get_local_catalog()
        source = "local_fallback"

    _CATALOG_CACHE["data"] = catalog_data
    _CATALOG_CACHE["expires_at"] = now + 600

    return JSONResponse(content={"ok": True, "source": source, "catalog": catalog_data})


@router.get("/presets/detail")
async def get_preset_detail_endpoint(request: Request, id: str = ""):
    """Fetch complete preset definition for a single provider on demand."""
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    pid = id.lower().strip()
    if not pid:
        return JSONResponse(status_code=400, content={"error": "Missing preset id"})

    if pid in _PRESET_REMOTE_CACHE:
        return JSONResponse(content={"ok": True, "source": "cache", "preset": _PRESET_REMOTE_CACHE[pid]})

    urls = [f"{base}/{pid}.json" for base in _CDN_PRESET_BASE_URLS]
    preset_data = await _fetch_remote_json(urls, timeout=2.5)
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
        latest_hash = remote_preset.get("rule_hash")
        curr_hash = item.get("rule_hash")

        has_update = (latest_ver != curr_ver) or (bool(latest_hash and curr_hash and latest_hash != curr_hash))

        res_item = {
            "provider_id": prov_id,
            "preset_id": pres_id,
            "name": remote_preset.get("name", prov_id),
            "current_version": curr_ver,
            "latest_version": latest_ver,
            "remote_version": latest_ver,
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
    """Incremental rule update: Fetch latest adapter_rules and update specified local providers."""
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
    updated = []
    failed = []

    for pid in target_ids:
        if pid not in providers:
            failed.append({"provider_id": pid, "error": "Provider not found in current config"})
            continue

        pdata = providers[pid]
        pres_id = pdata.get("preset_id", pid)

        urls = [f"{base}/{pres_id}.json" for base in _CDN_PRESET_BASE_URLS]
        preset_data = await _fetch_remote_json(urls, timeout=2.5) or _get_local_preset(pres_id)

        if not preset_data:
            failed.append({"provider_id": pid, "error": f"Failed to fetch rules for preset '{pres_id}'"})
            continue

        pdata["adapter_rules"] = preset_data.get("adapter_rules", {})
        pdata["preset_version"] = preset_data.get("version", "1.1.0")
        if "recommended_models" in preset_data:
            pdata["recommended_models"] = preset_data["recommended_models"]
        if "features" in preset_data:
            pdata["features"] = preset_data["features"]

        updated.append({
            "provider_id": pid,
            "preset_id": pres_id,
            "new_version": pdata["preset_version"],
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

        run_mode = (os.environ.get("RUN_MODE") or config.get("run_mode") or "full").lower()
        if run_mode == "agent":
            export_data.pop("candidates", None)
        elif run_mode == "kb":
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
        local_run_mode = (os.environ.get("RUN_MODE") or current_config.get("run_mode") or "full").lower().strip()
        if local_run_mode not in ("agent", "kb", "full"):
            local_run_mode = "full"

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
            if local_run_mode == "agent":
                final_config["candidates"] = {"chat": [], "embedding": [], "reranker": [], "ocr": []}
            elif local_run_mode == "kb":
                final_config["agent_models"] = {}

        final_config.pop("_exported_at", None)
        final_config.pop("_version", None)
        final_config.pop("_mode", None)
        final_config.pop("_run_mode", None)
        final_config["run_mode"] = local_run_mode

        if "candidates" not in final_config:
            final_config["candidates"] = {"chat": [], "embedding": [], "reranker": [], "ocr": []}
        if "agent_models" not in final_config:
            final_config["agent_models"] = {}

        await save_config(final_config)
        summary = _get_config_summary(final_config)
        return JSONResponse(content={
            "success": True,
            "status": "success",
            "mode": mode,
            "message": "配置导入成功",
            "summary": summary,
        })
    except Exception as e:
        logger.error("Failed to import config: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": "Failed to import configuration"})


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

    if "candidates" not in body or not isinstance(body["candidates"], dict):
        body["candidates"] = {"chat": [], "embedding": [], "reranker": [], "ocr": []}
    if "agent_models" not in body or not isinstance(body["agent_models"], dict):
        body["agent_models"] = {}

    try:
        await save_config(body)
        return JSONResponse(content={"status": "success", "message": "Configuration saved successfully."})
    except Exception as e:
        logger.error("Failed to save config: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": "Failed to save configuration"})


@router.get("/stats")
async def get_stats_endpoint(request: Request):
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    return JSONResponse(content=stats.get_stats())


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

    if parsed.scheme != "https":
        return JSONResponse(status_code=400, content={"valid": False, "error": "base_url 必须使用 HTTPS 协议"})

    hostname = parsed.hostname.lower() if parsed.hostname else ""
    if await _is_blocked_hostname(hostname):
        return JSONResponse(status_code=400, content={"valid": False, "error": "不允许访问内网或本地地址"})

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
                    lat_ms = max(1, int((time.monotonic() - t0) * 1000))
                    sc_chat = resp_chat.status_code
                    if sc_chat in (200, 201, 400, 404):
                        results["chat"] = {"valid": True, "status": sc_chat, "latency_ms": lat_ms, "message": "鉴权验证通过"}
                    elif sc_chat in (401, 403):
                        overall_valid = False
                        err = f"密钥无效，上游拒绝访问 (HTTP {sc_chat})"
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
                if any(x in lower_text for x in ("authentication", "unauthorized", "invalid_api_key", "forbidden")):
                    overall_valid = False
                    err = f"密钥认证失败 (HTTP {status_code})"
                    results["messages"] = {"valid": False, "status": status_code, "latency_ms": lat_ms, "error": err}
                    error_msgs.append(f"Anthropic Messages: {err}")
                else:
                    results["messages"] = {"valid": True, "status": status_code, "latency_ms": lat_ms, "message": "端点鉴权通过"}
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

    if not provider_name or not key_label or not model:
        return JSONResponse(status_code=400, content={"error": "Missing provider, key, or model"})

    config = await get_config()
    provider = config.get("providers", {}).get(provider_name)
    if not provider:
        return JSONResponse(status_code=400, content={"error": f"Provider '{provider_name}' not found"})

    api_key = provider.get("keys", {}).get(key_label)
    if not api_key:
        return JSONResponse(status_code=400, content={"error": f"Key '{key_label}' not found for provider '{provider_name}'"})

    base_url = provider.get("base_url", "")
    try:
        parsed = urlparse(base_url)
        if parsed.scheme != "https" or await _is_blocked_hostname(parsed.hostname or ""):
            return JSONResponse(status_code=400, content={"valid": False, "error": "Blocked or invalid upstream URL"})
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
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0), follow_redirects=False) as client:
            resp = await client.post(url, headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }, json=test_body)
            lat_sec = time.time() - start_t
            lat_ms = int(round(lat_sec * 1000))

            if 200 <= resp.status_code < 300:
                if category == "agent":
                    stats.record_agent(model_name, resp.status_code, lat_sec, provider=provider_name, key=key_label)
                else:
                    stats.record_kb(cand_type, resp.status_code, lat_sec, provider=provider_name, key=key_label)
                return JSONResponse(content={"success": True, "status": resp.status_code, "latency_ms": lat_ms, "message": "OK"})

            err_text = resp.text[:500] if resp.text else f"HTTP {resp.status_code}"
            if category == "agent":
                stats.record_agent(model_name, resp.status_code, lat_sec, provider=provider_name, key=key_label, error_msg=f"Manual test failed: {err_text}")
            else:
                stats.record_kb(cand_type, resp.status_code, lat_sec, provider=provider_name, key=key_label, error_msg=f"Manual test failed: {err_text}")
            return JSONResponse(content={
                "success": False,
                "status": resp.status_code,
                "latency_ms": lat_ms,
                "error": resp.text[:500] if resp.text else "No response body"
            })
    except httpx.ReadTimeout:
        lat_sec = time.time() - start_t
        stats.record(cand_type, 500, lat_sec, provider=provider_name, key=key_label, category=category, request_model=model_name, error_msg="Manual test timeout (30s)")
        return JSONResponse(content={"success": False, "error": "请求超时 (30s)，上游模型可能响应过慢"})
    except httpx.ConnectError as e:
        lat_sec = time.time() - start_t
        stats.record(cand_type, 500, lat_sec, provider=provider_name, key=key_label, category=category, request_model=model_name, error_msg="Manual test connect error")
        logger.warning("Test candidate connect error: %s", e)
        return JSONResponse(content={"success": False, "error": "连接上游服务器失败"})
    except Exception as e:
        lat_sec = time.time() - start_t
        stats.record(cand_type, 500, lat_sec, provider=provider_name, key=key_label, category=category, request_model=model_name, error_msg=f"Manual test error: {str(e)}")
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
        api_key = provider.get("keys", {}).get(b.get("key"))
        if not api_key:
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                    "status": None, "latency_ms": None, "error": "Key not found"}
        base_url = provider.get("base_url", "")
        try:
            parsed = urlparse(base_url)
            if parsed.scheme != "https" or await _is_blocked_hostname(parsed.hostname or ""):
                return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                        "status": None, "latency_ms": None, "error": "Blocked or invalid upstream URL"}
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
            async with sem:
                async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0), follow_redirects=False) as client:
                    resp = await client.post(url, headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    }, json=payload)
            lat_sec = time.time() - start
            latency_ms = int(lat_sec * 1000)
            ok = 200 <= resp.status_code < 300
            if ok:
                stats.record_agent(name, resp.status_code, lat_sec,
                                   provider=b.get("provider"), key=b.get("key"))
            else:
                stats.record_agent(name, resp.status_code, lat_sec,
                                   provider=b.get("provider"), key=b.get("key"),
                                   error_msg=f"Probe failed: HTTP {resp.status_code}")
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": ok,
                    "status": resp.status_code, "latency_ms": latency_ms,
                    "error": None if ok else resp.text[:200]}
        except httpx.ReadTimeout:
            lat_sec = time.time() - start
            stats.record_agent(name, 500, lat_sec,
                               provider=b.get("provider"), key=b.get("key"),
                               error_msg="Probe timeout (20s)")
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                    "status": None, "latency_ms": int((time.time() - start) * 1000),
                    "error": "上游超时 (20s)"}
        except httpx.ConnectError as e:
            lat_sec = time.time() - start
            stats.record_agent(name, 500, lat_sec,
                               provider=b.get("provider"), key=b.get("key"),
                               error_msg="Probe connect error")
            logger.warning("Probe connect error: %s", e)
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                    "status": None, "latency_ms": int((time.time() - start) * 1000),
                    "error": "连接失败"}
        except Exception as e:
            lat_sec = time.time() - start
            stats.record_agent(name, 500, lat_sec,
                               provider=b.get("provider"), key=b.get("key"),
                               error_msg=f"Probe error: {str(e)}")
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
