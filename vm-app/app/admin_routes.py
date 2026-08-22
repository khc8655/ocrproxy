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
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from urllib.parse import urlparse

from .config_store import get_config, save_config, _get_config_dir
from .upstream import join_upstream
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
        # Handle IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
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

    # Direct string checks for common patterns
    blocked_exact = {"localhost", "::1", "::", "0.0.0.0"}
    if hostname in blocked_exact:
        return True

    # If it's a direct IP address, check it immediately
    if _check_ip_address(hostname):
        return True

    # DNS resolution check in a thread to prevent blocking the event loop
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


def _merge_configs(base: dict, incoming: dict) -> dict:
    """Deep-merge incoming config into base config."""
    merged = copy.deepcopy(base)

    # 1. Merge providers
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

    # 2. Merge candidates (deduplicating by provider + key + model)
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

    # 3. Merge agent_models
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

    # 4. Update top-level setting parameters if present in incoming
    setting_keys = [
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

    return merged


@router.get("/config")
async def get_config_endpoint(request: Request):
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    try:
        config = await get_config()
        return JSONResponse(content=config)
    except Exception as e:
        logger.error("Failed to get config: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": "Failed to load configuration"})


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

    mode = body.get("mode", "overwrite")
    if mode not in ("overwrite", "merge"):
        return JSONResponse(status_code=400, content={"error": "Invalid mode: must be 'overwrite' or 'merge'"})

    incoming_config = body.get("config")
    if not isinstance(incoming_config, dict):
        return JSONResponse(status_code=400, content={"error": "Missing or invalid 'config' object"})

    # Schema validation: providers and candidates must be objects
    providers = incoming_config.get("providers")
    candidates = incoming_config.get("candidates")
    if not isinstance(providers, dict) or not isinstance(candidates, dict):
        return JSONResponse(
            status_code=400,
            content={"error": "Invalid configuration: providers and candidates must be objects"}
        )

    try:
        current_config = await get_config()

        # Save snapshot backup before making modifications
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
            final_config = _merge_configs(current_config, incoming_config)
        else:
            final_config = copy.deepcopy(incoming_config)

        # Strip export metadata
        final_config.pop("_exported_at", None)
        final_config.pop("_version", None)

        # Ensure agent_models is in valid dict format
        if "agent_models" in final_config and not isinstance(final_config["agent_models"], dict):
            final_config["agent_models"] = {}

        await save_config(final_config)
        summary = _get_config_summary(final_config)
        return JSONResponse(content={
            "success": True,
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

    # Validate required structure
    if not isinstance(body, dict) or not isinstance(body.get("providers"), dict) or not isinstance(body.get("candidates"), dict):
        return JSONResponse(
            status_code=400,
            content={"error": "Invalid configuration: providers and candidates must be objects"}
        )

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

    # Handle reset action
    if body.get("action") == "reset":
        stats.reset()
        return JSONResponse(content=stats.get_stats())

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

    # SSRF protection: validate URL
    try:
        parsed = urlparse(base_url)
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"valid": False, "error": "base_url 格式无效"}
        )

    if parsed.scheme != "https":
        return JSONResponse(
            status_code=400,
            content={"valid": False, "error": "base_url 必须使用 HTTPS 协议"}
        )

    hostname = parsed.hostname.lower() if parsed.hostname else ""

    if await _is_blocked_hostname(hostname):
        return JSONResponse(
            status_code=400,
            content={"valid": False, "error": "不允许访问内网或本地地址"}
        )

    # Make verification request to upstream
    try:
        formatted_url = base_url.rstrip("/")
        models_url = f"{formatted_url}/v1/models"

        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
            resp = await client.get(models_url, headers={
                "Authorization": f"Bearer {api_key}",
                "User-Agent": "ocrproxy-verifier/1.0"
            })

            # If 404, try without /v1 prefix
            if resp.status_code == 404:
                models_url = f"{formatted_url}/models"
                resp = await client.get(models_url, headers={
                    "Authorization": f"Bearer {api_key}",
                    "User-Agent": "ocrproxy-verifier/1.0"
                })

            text = resp.text
            status_code = resp.status_code

        if status_code in (200, 201):
            return JSONResponse(content={
                "valid": True,
                "status": status_code,
                "note": "Key 鉴权验证通过。此检查仅验证密钥有效性，实际调用可能因限流或服务异常而失败。"
            })

        if status_code in (401, 403):
            return JSONResponse(content={
                "valid": False,
                "error": f"密钥无效，上游拒绝访问 (HTTP {status_code})"
            })

        return JSONResponse(content={
            "valid": False,
            "error": f"上游返回非预期响应 (HTTP {status_code}): {text[:100]}"
        })

    except httpx.ConnectError as e:
        logger.warning("Verify key connect error: %s", e)
        return JSONResponse(content={
            "valid": False,
            "error": "网络连接异常，无法连通上游服务器"
        })
    except Exception as e:
        logger.error("Verify key unexpected error: %s", e, exc_info=True)
        return JSONResponse(content={
            "valid": False,
            "error": "验证请求失败"
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
    model = body.get("model")
    cand_type = body.get("type", "chat")
    category = body.get("category", "kb")
    model_name = body.get("model_name") or model

    if not provider_name or not key_label or not model:
        return JSONResponse(status_code=400, content={"error": "Missing provider, key, or model"})

    config = await get_config()
    provider = config.get("providers", {}).get(provider_name)
    if not provider:
        return JSONResponse(content={"success": False, "error": f"Provider '{provider_name}' not found"})

    api_key = provider.get("keys", {}).get(key_label)
    if not api_key:
        return JSONResponse(content={"success": False, "error": f"Key '{key_label}' not found"})

    base_url = provider.get("base_url", "")
    try:
        parsed = urlparse(base_url)
        if parsed.scheme != "https" or await _is_blocked_hostname(parsed.hostname or ""):
            return JSONResponse(content={"success": False, "error": "上游 URL 不合法或为内网地址"})
    except Exception:
        return JSONResponse(content={"success": False, "error": "base_url 格式无效"})

    url = join_upstream(base_url, "chat/completions")

    # Build minimal test request based on type
    if cand_type in ("chat", "ocr"):
        test_body = {
            "model": model,
            "messages": [{"role": "user", "content": "Hi" if cand_type == "chat" else "What is in this image?"}],
            "max_tokens": 5,
            "stream": False,
        }
    elif cand_type == "embedding":
        url = join_upstream(base_url, "embeddings")
        test_body = {"model": model, "input": "test"}
    elif cand_type == "reranker":
        url = join_upstream(base_url, "rerank")
        test_body = {"model": model, "query": "test", "documents": ["a"]}
    else:
        test_body = {"model": model, "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 5}

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0), follow_redirects=False) as client:
            resp = await client.post(url, headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }, json=test_body)

            if 200 <= resp.status_code < 300:
                # Record successful test in stats so dashboard reflects it
                if category == "agent":
                    stats.record_agent(model_name, resp.status_code, 0.0,
                                       provider=provider_name, key=key_label)
                else:
                    stats.record_kb(cand_type, resp.status_code, 0.0,
                                    provider=provider_name, key=key_label)
                return JSONResponse(content={"success": True, "status": resp.status_code, "message": "OK"})

            # Record failed test in stats
            err_text = resp.text[:500] if resp.text else f"HTTP {resp.status_code}"
            if category == "agent":
                stats.record_agent(model_name, resp.status_code, 0.0,
                                   provider=provider_name, key=key_label,
                                   error_msg=f"Manual test failed: {err_text}")
            else:
                stats.record_kb(cand_type, resp.status_code, 0.0,
                                provider=provider_name, key=key_label,
                                error_msg=f"Manual test failed: {err_text}")
            return JSONResponse(content={
                "success": False,
                "status": resp.status_code,
                "error": resp.text[:500] if resp.text else "No response body"
            })

    except httpx.ReadTimeout:
        if category == "agent":
            stats.record_agent(model_name, 500, 0.0,
                               provider=provider_name, key=key_label,
                               error_msg="Manual test timeout (30s)")
        else:
            stats.record_kb(cand_type, 500, 0.0,
                            provider=provider_name, key=key_label,
                            error_msg="Manual test timeout (30s)")
        return JSONResponse(content={"success": False, "error": "请求超时 (30s)，上游模型可能响应过慢"})
    except httpx.ConnectError as e:
        if category == "agent":
            stats.record_agent(model_name, 500, 0.0,
                               provider=provider_name, key=key_label,
                               error_msg="Manual test connect error")
        else:
            stats.record_kb(cand_type, 500, 0.0,
                            provider=provider_name, key=key_label,
                            error_msg="Manual test connect error")
        logger.warning("Test candidate connect error: %s", e)
        return JSONResponse(content={"success": False, "error": "连接上游服务器失败"})
    except Exception as e:
        if category == "agent":
            stats.record_agent(model_name, 500, 0.0,
                               provider=provider_name, key=key_label,
                               error_msg=f"Manual test error: {str(e)}")
        else:
            stats.record_kb(cand_type, 500, 0.0,
                            provider=provider_name, key=key_label,
                            error_msg=f"Manual test error: {str(e)}")
        logger.error("Test candidate unexpected error: %s", e, exc_info=True)
        return JSONResponse(content={"success": False, "error": "测试失败"})


@router.post("/test-agent-model")
async def test_agent_model_endpoint(request: Request):
    """Probe ALL keys bound to an agent model in parallel.

    Unlike /test-candidate (single candidate), this checks every key binding of
    an agent model and reports per-key health — so a model that is "reachable
    but throttled" (429 quota/TPM exhausted, 503 busy) becomes immediately
    visible instead of silently failing over during real traffic.
    """
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
                   "max_tokens": 1, "stream": False}
        start = time.time()
        try:
            async with sem:
                async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0), follow_redirects=False) as client:
                    resp = await client.post(url, headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    }, json=payload)
            latency_ms = int((time.time() - start) * 1000)
            ok = 200 <= resp.status_code < 300
            if ok:
                stats.record_agent(name, resp.status_code, 0.0,
                                   provider=b.get("provider"), key=b.get("key"))
            else:
                stats.record_agent(name, resp.status_code, 0.0,
                                   provider=b.get("provider"), key=b.get("key"),
                                   error_msg=f"Probe failed: HTTP {resp.status_code}")
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": ok,
                    "status": resp.status_code, "latency_ms": latency_ms,
                    "error": None if ok else resp.text[:200]}
        except httpx.ReadTimeout:
            stats.record_agent(name, 500, 0.0,
                               provider=b.get("provider"), key=b.get("key"),
                               error_msg="Probe timeout (20s)")
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                    "status": None, "latency_ms": int((time.time() - start) * 1000),
                    "error": "上游超时 (20s)"}
        except httpx.ConnectError as e:
            stats.record_agent(name, 500, 0.0,
                               provider=b.get("provider"), key=b.get("key"),
                               error_msg="Probe connect error")
            logger.warning("Probe connect error: %s", e)
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                    "status": None, "latency_ms": int((time.time() - start) * 1000),
                    "error": "连接失败"}
        except Exception as e:
            stats.record_agent(name, 500, 0.0,
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
