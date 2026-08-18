"""
Admin API routes: config CRUD, stats, verify-key.
Ported from EdgeOne edge-functions/api/admin/*.js.
"""
import asyncio
import ipaddress
import socket
import time
import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from urllib.parse import urlparse

from .config_store import get_config, save_config
from .upstream import join_upstream
from . import stats
from .auth import verify_admin_auth

router = APIRouter(prefix="/api/admin")


def _check_auth(request: Request) -> bool:
    return verify_admin_auth(request)


def _is_blocked_hostname(hostname: str) -> bool:
    """Check if hostname is an internal/local/metadata address (SSRF protection)."""
    hostname = hostname.lower().strip()

    # Direct string checks for common patterns
    blocked_exact = {"localhost", "::1", "::", "0.0.0.0"}
    if hostname in blocked_exact:
        return True

    blocked_prefixes = ["127.", "10.", "192.168.", "169.254.", "0."]
    for prefix in blocked_prefixes:
        if hostname.startswith(prefix):
            return True

    # Check 172.16-31.x.x range
    if hostname.startswith("172."):
        parts = hostname.split(".")
        if len(parts) >= 2:
            try:
                second = int(parts[1])
                if 16 <= second <= 31:
                    return True
            except ValueError:
                pass

    # IPv6 ULA (fd00::/8) and link-local (fe80::/10)
    if hostname.startswith("fd") and len(hostname) >= 3 and hostname[2] == ":":
        return True
    if hostname.startswith("fe80:"):
        return True

    # DNS resolution check to prevent DNS rebinding attacks
    try:
        resolved = socket.getaddrinfo(hostname, None)
        for info in resolved:
            ip = info[4][0]
            try:
                addr = ipaddress.ip_address(ip)
                if addr.is_private or addr.is_loopback or addr.is_link_local:
                    return True
            except ValueError:
                continue
    except (socket.gaierror, socket.herror):
        pass  # If DNS fails, let the HTTP request fail naturally

    return False


@router.get("/config")
async def get_config_endpoint(request: Request):
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    try:
        config = await get_config()
        return JSONResponse(content=config)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/config")
async def save_config_endpoint(request: Request):
    if not _check_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    # Validate required structure
    if not isinstance(body, dict) or "providers" not in body or "candidates" not in body:
        return JSONResponse(
            status_code=400,
            content={"error": "Invalid configuration: missing providers or candidates"}
        )

    try:
        await save_config(body)
        return JSONResponse(content={"status": "success", "message": "Configuration saved successfully."})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


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

    # Handle stats update from scheduler (for compatibility)
    type_name = body.get("type")
    status_code = body.get("status")
    if not type_name or not status_code:
        return JSONResponse(status_code=400, content={"error": "Missing type or status"})

    stats.record(
        type_name=type_name,
        status_code=int(status_code),
        latency=float(body.get("latency", 0)),
        provider=body.get("provider"),
        key=body.get("key"),
        error_msg=body.get("error_msg"),
    )
    return JSONResponse(content={"status": "success", "stats": stats.get_stats()})


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

    if _is_blocked_hostname(hostname):
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
        return JSONResponse(content={
            "valid": False,
            "error": f"网络连接异常，无法连通上游服务器: {e}"
        })
    except Exception as e:
        return JSONResponse(content={
            "valid": False,
            "error": f"验证请求失败: {e}"
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
                stats.record(cand_type, resp.status_code, 0.0,
                             provider=provider_name, key=key_label)
                return JSONResponse(content={"success": True, "status": resp.status_code, "message": "OK"})

            # Record failed test in stats
            stats.record(cand_type, resp.status_code, 0.0,
                         provider=provider_name, key=key_label,
                         error_msg=f"Manual test failed: HTTP {resp.status_code}")
            return JSONResponse(content={
                "success": False,
                "status": resp.status_code,
                "error": resp.text[:500] if resp.text else "No response body"
            })

    except httpx.ReadTimeout:
        stats.record(cand_type, 500, 0.0,
                     provider=provider_name, key=key_label,
                     error_msg="Manual test timeout (30s)")
        return JSONResponse(content={"success": False, "error": "请求超时 (30s)，上游模型可能响应过慢"})
    except httpx.ConnectError as e:
        stats.record(cand_type, 500, 0.0,
                     provider=provider_name, key=key_label,
                     error_msg=f"Manual test connect error: {e}")
        return JSONResponse(content={"success": False, "error": f"连接失败: {e}"})
    except Exception as e:
        return JSONResponse(content={"success": False, "error": f"测试失败: {e}"})


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

    name = body.get("model")
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
        model = b.get("upstream_model") or entry.get("upstream_model") or name
        url = join_upstream(provider.get("base_url", ""), "chat/completions")
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
                stats.record("chat", resp.status_code, 0.0,
                             provider=b.get("provider"), key=b.get("key"))
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": ok,
                    "status": resp.status_code, "latency_ms": latency_ms,
                    "error": None if ok else resp.text[:200]}
        except httpx.ReadTimeout:
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                    "status": None, "latency_ms": int((time.time() - start) * 1000),
                    "error": "上游超时 (20s)"}
        except httpx.ConnectError as e:
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                    "status": None, "latency_ms": int((time.time() - start) * 1000),
                    "error": f"连接失败: {e}"}
        except Exception as e:
            return {"provider": b.get("provider"), "key": b.get("key"), "ok": False,
                    "status": None, "latency_ms": int((time.time() - start) * 1000),
                    "error": f"异常: {e}"}

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
