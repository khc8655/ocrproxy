#!/usr/bin/env python3
"""
test_strict_mode_isolation.py
Rigorously verify strict physical isolation between:
1. Azure VM (RUN_MODE=agent, https://api1.khc6.cn)
2. Tencent Cloud VM (RUN_MODE=kb, http://124.223.35.23:9090)
"""

import urllib.request
import urllib.error
import json
import time

AZURE_URL = "https://api1.khc6.cn"
TX_URL = "http://124.223.35.23:9090"
ADMIN_PASSWORD = "XA43mdHR7N83t7ULDnrFIjuV"
PROXY_KEY = "3q0xqZ7bes6lDUgltZg8uoj6LwXzMpcpwpIQ9wZh"

ADMIN_HEADERS = {
    "Authorization": f"Bearer {ADMIN_PASSWORD}",
    "Content-Type": "application/json"
}

CLIENT_HEADERS = {
    "Authorization": f"Bearer {PROXY_KEY}",
    "Content-Type": "application/json"
}

def req(method, url, data=None, headers=None, timeout=25.0):
    if headers is None:
        headers = CLIENT_HEADERS
    r = urllib.request.Request(url, method=method, headers=headers)
    if data is not None:
        r.data = json.dumps(data).encode("utf-8") if isinstance(data, (dict, list)) else data.encode("utf-8")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="ignore")
            try:
                j = json.loads(raw)
            except Exception:
                j = None
            return resp.status, j, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="ignore")
        try:
            j = json.loads(raw)
        except Exception:
            j = None
        return e.code, j, raw
    except Exception as e:
        return 0, None, str(e)

def main():
    print("=" * 70)
    print("🚀 启动生产级严格模式物理隔离回归测试 (Strict Mode Isolation Test)")
    print("=" * 70)

    # -----------------------------------------------------------------------
    # TEST 1: Azure VM (RUN_MODE=agent)
    # -----------------------------------------------------------------------
    print("\n📌 [PART 1] 验证 Azure VM (RUN_MODE=agent) 专属行为:")
    code, cfg, _ = req("GET", f"{AZURE_URL}/api/admin/config", headers=ADMIN_HEADERS)
    assert code == 200, f"Get Azure config failed: {code}"
    run_mode = cfg.get("_run_mode") or cfg.get("run_mode")
    print(f"  • 激活模式: {run_mode} (预期: agent)")
    assert run_mode == "agent", f"Azure run_mode is not agent: {run_mode}"
    print(f"  • Agent 模型数: {len(cfg.get('agent_models', {}))}")
    print(f"  • KB 候选节点数: {sum(len(v) for v in cfg.get('candidates', {}).values())} (预期: 0)")
    assert sum(len(v) for v in cfg.get('candidates', {}).values()) == 0, "Agent mode should have 0 candidates"

    # Models list in Agent mode
    code, models_data, _ = req("GET", f"{AZURE_URL}/v1/models")
    assert code == 200
    model_ids = [m["id"] for m in models_data.get("data", [])]
    print(f"  • /v1/models 返回列表: {model_ids}")
    assert "chat" not in model_ids and "embedding" not in model_ids, "Agent /v1/models should not contain KB virtual models"

    # Agent Chat endpoint with real model -> 200 OK
    code, chat_res, raw = req("POST", f"{AZURE_URL}/v1/chat/completions", data={
        "model": "gemini-3.5-flash-lite",
        "messages": [{"role": "user", "content": "你好"}],
        "max_tokens": 10
    })
    print(f"  • 调用 real model (gemini-3.5-flash-lite) -> 状态码: {code} (预期 200)")
    assert code == 200, f"Chat with real model failed: {code} {raw}"

    # Agent Chat endpoint with virtual model 'chat' -> 404
    code, _, raw = req("POST", f"{AZURE_URL}/v1/chat/completions", data={
        "model": "chat",
        "messages": [{"role": "user", "content": "你好"}],
        "max_tokens": 10
    })
    print(f"  • 调用 virtual model 'chat' -> 状态码: {code} (预期 404 严格拦截)")
    assert code == 404, f"Agent mode should reject model='chat' with 404, got {code}"

    # Calling /v1/embeddings on Agent -> 404
    code, _, raw = req("POST", f"{AZURE_URL}/v1/embeddings", data={"model": "embedding", "input": "test"})
    print(f"  • 调用 /v1/embeddings -> 状态码: {code} (预期 404 严格拦截)")
    assert code == 404, f"Agent mode should reject /v1/embeddings with 404, got {code}"

    # Calling /v1/rerank on Agent -> 404
    code, _, raw = req("POST", f"{AZURE_URL}/v1/rerank", data={"model": "reranker", "query": "q", "documents": ["d1"]})
    print(f"  • 调用 /v1/rerank -> 状态码: {code} (预期 404 严格拦截)")
    assert code == 404, f"Agent mode should reject /v1/rerank with 404, got {code}"

    # Calling /v1/ocr on Agent -> 404
    code, _, raw = req("POST", f"{AZURE_URL}/v1/ocr", data={"image_base64": "test"})
    print(f"  • 调用 /v1/ocr -> 状态码: {code} (预期 404 严格拦截)")
    assert code == 404, f"Agent mode should reject /v1/ocr with 404, got {code}"

    print("  🎉 [PART 1 PASS] Azure VM Agent 模式完全阻断所有 KB 流量，只服务 Agent 模型！")

    # -----------------------------------------------------------------------
    # TEST 2: Tencent Cloud VM (RUN_MODE=kb)
    # -----------------------------------------------------------------------
    print("\n📌 [PART 2] 验证 腾讯云 VM (RUN_MODE=kb) 专属行为:")
    code, tx_cfg, _ = req("GET", f"{TX_URL}/api/admin/config", headers=ADMIN_HEADERS)
    assert code == 200, f"Get TX config failed: {code}"
    tx_run_mode = tx_cfg.get("_run_mode") or tx_cfg.get("run_mode")
    print(f"  • 激活模式: {tx_run_mode} (预期: kb)")
    assert tx_run_mode == "kb", f"TX run_mode is not kb: {tx_run_mode}"
    print(f"  • Agent 模型数: {len(tx_cfg.get('agent_models', {}))} (预期: 0)")
    assert len(tx_cfg.get('agent_models', {})) == 0, "KB mode should have 0 agent_models"
    print(f"  • KB 候选节点数: {sum(len(v) for v in tx_cfg.get('candidates', {}).values())}")

    # Models list in KB mode
    code, tx_models_data, _ = req("GET", f"{TX_URL}/v1/models")
    assert code == 200
    tx_model_ids = [m["id"] for m in tx_models_data.get("data", [])]
    print(f"  • /v1/models 返回列表: {tx_model_ids}")
    assert set(tx_model_ids) == {"chat", "embedding", "reranker", "ocr"}, f"KB /v1/models should only have virtual models, got {tx_model_ids}"

    # KB Chat endpoint with virtual model 'chat' -> 200 OK
    code, tx_chat_res, raw = req("POST", f"{TX_URL}/v1/chat/completions", data={
        "model": "chat",
        "messages": [{"role": "user", "content": "你好"}],
        "max_tokens": 10
    })
    print(f"  • 调用 virtual model 'chat' -> 状态码: {code} (预期 200)")
    assert code == 200, f"KB chat failed: {code} {raw}"

    # KB Chat endpoint with real model (qwen3.8-flash) -> 404
    code, _, raw = req("POST", f"{TX_URL}/v1/chat/completions", data={
        "model": "qwen3.8-flash",
        "messages": [{"role": "user", "content": "你好"}],
        "max_tokens": 10
    })
    print(f"  • 调用 real model (qwen3.8-flash) -> 状态码: {code} (预期 404 严格拦截)")
    assert code == 404, f"KB mode should reject model='qwen3.8-flash' with 404, got {code}"

    # KB Embeddings endpoint -> 200 OK
    code, tx_emb_res, raw = req("POST", f"{TX_URL}/v1/embeddings", data={"model": "embedding", "input": "hello"})
    print(f"  • 调用 /v1/embeddings -> 状态码: {code} (预期 200)")
    assert code == 200, f"KB embeddings failed: {code} {raw}"

    # KB Rerank endpoint -> 200 OK
    code, tx_rerank_res, raw = req("POST", f"{TX_URL}/v1/rerank", data={"model": "reranker", "query": "q", "documents": ["d1", "d2"]})
    print(f"  • 调用 /v1/rerank -> 状态码: {code} (预期 200)")
    assert code == 200, f"KB rerank failed: {code} {raw}"

    print("  🎉 [PART 2 PASS] 腾讯云 VM KB 模式完全阻断所有 Agent 真实模型调用，只服务 4 大知识库模型！")

    # -----------------------------------------------------------------------
    # TEST 3: 跨机导入模式保护测试 (Cross-node Import Protection)
    # -----------------------------------------------------------------------
    print("\n📌 [PART 3] 验证 跨机导入保护 (从腾讯云导入至 Azure):")
    # Export from TX
    code, tx_exported, _ = req("GET", f"{TX_URL}/api/admin/config/export", headers=ADMIN_HEADERS)
    assert code == 200

    # Import into Azure (Merge)
    code, import_res, _ = req("POST", f"{AZURE_URL}/api/admin/config/import", headers=ADMIN_HEADERS, data={
        "mode": "merge",
        "config": tx_exported
    })
    assert code == 200
    print(f"  • 导入响应: {import_res.get('message')}")

    # Check Azure config post-import
    code, post_cfg, _ = req("GET", f"{AZURE_URL}/api/admin/config", headers=ADMIN_HEADERS)
    post_run_mode = post_cfg.get("_run_mode") or post_cfg.get("run_mode")
    print(f"  • 导入后 Azure 激活模式: {post_run_mode} (必须保持 agent，绝不被篡改)")
    assert post_run_mode == "agent", f"Azure run_mode was overwritten to {post_run_mode}!"
    assert sum(len(v) for v in post_cfg.get('candidates', {}).values()) == 0, "Azure should still have 0 candidates after merge"

    # Verify that Azure still blocks embeddings
    code, _, _ = req("POST", f"{AZURE_URL}/v1/embeddings", data={"model": "embedding", "input": "test"})
    assert code == 404, "Azure must still block /v1/embeddings with 404 after import!"
    print("  • 导入后再次测试 /v1/embeddings -> 状态码: 404 (依然被严格拦截)")

    print("  🎉 [PART 3 PASS] 跨机导入保护验证成功！机器 run_mode 与私有资产未受任何污染！")

    print("\n" + "=" * 70)
    print("🏆 ALL STRICT MODE ISOLATION TESTS PASSED 100%!")
    print("=" * 70)

if __name__ == "__main__":
    main()
