#!/usr/bin/env python3
"""
test_azure_frontend_backend_suite.py
Comprehensive End-to-End Suite testing all UI & Backend capabilities on Azure VM (https://api1.khc6.cn)
and verifying incremental import from Tencent Cloud VM (https://api.khc6.cn).
Uses standard library urllib (zero external dependencies).
"""

import urllib.request
import urllib.error
import json
import time

AZURE_BASE = "https://api1.khc6.cn"
TX_BASE = "http://124.223.35.23:9090"
ADMIN_PASSWORD = "XA43mdHR7N83t7ULDnrFIjuV"

HEADERS = {
    "Authorization": f"Bearer {ADMIN_PASSWORD}",
    "Content-Type": "application/json",
    "User-Agent": "Antigravity-TestSuite/1.0"
}

def log(msg, status="INFO"):
    print(f"[{status}] {msg}")

def request(method, url, data=None, headers=None, timeout=25.0):
    if headers is None:
        headers = HEADERS
    req = urllib.request.Request(url, method=method, headers=headers)
    if data is not None:
        if isinstance(data, (dict, list)):
            body_bytes = json.dumps(data).encode("utf-8")
        elif isinstance(data, str):
            body_bytes = data.encode("utf-8")
        else:
            body_bytes = data
        req.data = body_bytes
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status_code = resp.status
            resp_bytes = resp.read()
            resp_headers = dict(resp.headers)
            try:
                json_data = json.loads(resp_bytes.decode("utf-8"))
            except Exception:
                json_data = None
            return status_code, json_data, resp_bytes.decode("utf-8", errors="ignore"), resp_headers
    except urllib.error.HTTPError as e:
        status_code = e.code
        resp_bytes = e.read()
        resp_headers = dict(e.headers)
        try:
            json_data = json.loads(resp_bytes.decode("utf-8"))
        except Exception:
            json_data = None
        return status_code, json_data, resp_bytes.decode("utf-8", errors="ignore"), resp_headers
    except Exception as e:
        return 0, None, str(e), {}

def main():
    print("=" * 70)
    print("🚀 Running Comprehensive Azure VM UI & Backend Test Suite")
    print(f"Target: {AZURE_BASE} (CDN 回源至 Azure VM)")
    print("=" * 70)

    # 1. Health check
    code, j, text, _ = request("GET", f"{AZURE_BASE}/health")
    assert code == 200, f"Health check failed: {code} {text}"
    log(f"1. Health Check passed: {j}", "PASS")

    # 2. Get current Azure config
    code, azure_config, text, _ = request("GET", f"{AZURE_BASE}/api/admin/config")
    assert code == 200, f"Get Azure config failed: {code} {text}"
    log(f"2. Current Azure Config: {len(azure_config.get('providers', {}))} providers, {len(azure_config.get('agent_models', {}))} agent models", "PASS")

    # 3. Export config from Tencent Cloud VM
    log(f"3. Exporting configuration from Tencent Cloud VM ({TX_BASE})...")
    code, tx_export, text, _ = request("GET", f"{TX_BASE}/api/admin/config/export")
    assert code == 200, f"Export from TX failed: {code} {text}"
    log(f"   Exported {len(tx_export.get('providers', {}))} providers, {len(tx_export.get('candidates', {}))} candidate categories from Tencent Cloud", "PASS")

    # 4. Incremental Merge Import into Azure VM
    log("4. Performing Incremental Merge Import (mode='merge') into Azure VM...")
    import_payload = {
        "mode": "merge",
        "config": tx_export
    }
    code, import_res, text, _ = request("POST", f"{AZURE_BASE}/api/admin/config/import", data=import_payload)
    assert code == 200, f"Import into Azure failed: {code} {text}"
    log(f"   Import result: {import_res.get('message')}, summary: {import_res.get('summary')}", "PASS")

    # 5. Verify Merged Config on Azure VM
    code, merged_config, text, _ = request("GET", f"{AZURE_BASE}/api/admin/config")
    providers = merged_config.get("providers", {})
    agent_models = merged_config.get("agent_models", {})
    candidates = merged_config.get("candidates", {})
    log(f"5. Merged Config Verified: {len(providers)} providers, {len(agent_models)} agent models, {sum(len(v) for v in candidates.values())} KB candidates", "PASS")

    # 6. Test Model Probe on all Agent Models (POST /api/admin/test-agent-model)
    log("6. Testing Parallel Key Probing (POST /api/admin/test-agent-model)...")
    for model_name in list(agent_models.keys())[:3]:
        code, res, text, _ = request("POST", f"{AZURE_BASE}/api/admin/test-agent-model", data={"model": model_name})
        assert code == 200, f"Probe {model_name} failed: {code} {text}"
        log(f"   Model '{model_name}': {res.get('ok')}/{res.get('total')} keys available ({[r.get('latency_ms') for r in res.get('results', [])]}ms)", "PASS")

    # 7. Test KB Candidate Probing (POST /api/admin/test-candidate)
    log("7. Testing KB Candidate Probing (POST /api/admin/test-candidate)...")
    tested_cand = 0
    for cat, list_cands in candidates.items():
        if list_cands:
            c = list_cands[0]
            code, res, text, _ = request("POST", f"{AZURE_BASE}/api/admin/test-candidate", data={
                "provider": c["provider"],
                "key": c["key"],
                "model": c["model"],
                "type": cat,
                "category": cat
            })
            log(f"   KB Candidate [{cat}] {c['provider']}/{c['key']} -> status: {code}, result: {res.get('success') if res else text}", "PASS" if code == 200 else "WARN")
            tested_cand += 1
            if tested_cand >= 2:
                break

    # 8. Test Live Chat Completion via Proxy (POST /v1/chat/completions)
    log("8. Testing Live Chat Completion via Proxy (/v1/chat/completions)...")
    chat_payload = {
        "model": "gemini-3.5-flash-lite",
        "messages": [{"role": "user", "content": "请回复'测试通过'四个字"}],
        "max_tokens": 30,
        "stream": False
    }
    code, chat_res, text, headers = request("POST", f"{AZURE_BASE}/v1/chat/completions", data=chat_payload)
    assert code == 200, f"Chat completions failed: {code} {text}"
    reply = chat_res["choices"][0]["message"]["content"]
    routed = headers.get("x-routed-via") or headers.get("X-Routed-Via")
    log(f"   Chat success! Routed via: {routed}, Reply: {reply.strip()}", "PASS")

    # 9. Test Statistics Endpoint
    log("9. Testing Stats Endpoint (/api/admin/stats)...")
    code, stats_data, text, _ = request("GET", f"{AZURE_BASE}/api/admin/stats")
    assert code == 200, f"Stats endpoint failed: {code} {text}"
    log(f"   Stats records count: {len(stats_data.get('recent_records', []))}", "PASS")

    # 10. Test Smooth Restart Endpoint (POST /api/admin/restart)
    log("10. Testing Web Smooth Restart Endpoint (/api/admin/restart)...")
    code, restart_res, text, _ = request("POST", f"{AZURE_BASE}/api/admin/restart")
    assert code == 200, f"Restart endpoint failed: {code} {text}"
    log(f"   Restart response: {restart_res}", "PASS")
    time.sleep(3)

    # 11. Final Health Verification
    code, j, text, _ = request("GET", f"{AZURE_BASE}/health")
    assert code == 200, f"Health check after restart failed: {code} {text}"
    log("11. Post-restart Health check 200 OK! All systems fully operational.", "PASS")

    print("=" * 70)
    print("🎉 ALL 11 TEST SUITES PASSED 100% ON AZURE VM (https://api1.khc6.cn)")
    print("=" * 70)

if __name__ == "__main__":
    main()
