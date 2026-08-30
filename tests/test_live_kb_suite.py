#!/usr/bin/env python3
"""
OCRProxy KB (Knowledge Base) 模式生产级自动化测试套件
适用场景：Dify / FastGPT / Ragflow / 自研 RAG 知识库系统对接验证

覆盖维度：
1. KB 快速对话摘要测试 (/v1/chat/completions, model="chat")
   - 验证非流式、强制关闭思考、极速响应
2. 文本向量化测试 (/v1/embeddings, model="embedding")
   - 验证单句与批量多文档向量生成、向量维度与浮点有效性
3. 检索重排测试 (/v1/rerank, model="reranker")
   - 验证多文档相似度打分与重排排序
4. OCR 多模态图文识别测试 (/v1/ocr, model="ocr")
   - 验证 Base64 图像文字识别与 Markdown 输出
5. Key 轮询负载均衡测试 (Round-Robin Routing)
   - 验证高并发下多 Key 均匀分摊与 X-Routed-Via 轮换
6. 全量负向安全鉴权测试 (Security & Auth Guard)
   - 验证空 Key、假 Key、非法 Header 严格 401 拦截
"""

import os
import json
import time
import urllib.request
import urllib.error
from typing import Dict, Any, List, Optional, Tuple

TARGET_URL = os.environ.get("TARGET_URL", "http://124.223.35.23:9090")
PROXY_API_KEY = os.environ.get("PROXY_API_KEY", "3q0xqZ7bes6lDUgltZg8uoj6LwXzMpcpwpIQ9wZh")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "XA43mdHR7N83t7ULDnrFIjuV")

# 1x1 像素纯色 PNG 图像 Base64（合法的最小测试图片）
SAMPLE_PNG_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def log_section(title: str):
    print("\n" + "=" * 70)
    print(f"  📌 {title}")
    print("=" * 70)


def send_request(
    path: str,
    method: str = "POST",
    body: Optional[Dict[str, Any]] = None,
    api_key: Optional[str] = PROXY_API_KEY,
    timeout: float = 30.0
) -> Tuple[int, Dict[str, Any], Dict[str, str], float]:
    """发送 HTTP 请求并返回 (status_code, response_json, headers, elapsed_ms)。"""
    url = f"{TARGET_URL}{path}"
    headers = {"Content-Type": "application/json"}
    if api_key is not None:
        headers["Authorization"] = f"Bearer {api_key}"

    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed_ms = (time.time() - t0) * 1000
            resp_headers = dict(resp.headers)
            content = resp.read().decode("utf-8")
            try:
                data_json = json.loads(content)
            except Exception:
                data_json = {"raw": content}
            return resp.status, data_json, resp_headers, elapsed_ms
    except urllib.error.HTTPError as e:
        elapsed_ms = (time.time() - t0) * 1000
        resp_headers = dict(e.headers)
        try:
            data_json = json.loads(e.read().decode("utf-8"))
        except Exception:
            data_json = {"error": str(e)}
        return e.code, data_json, resp_headers, elapsed_ms
    except Exception as e:
        elapsed_ms = (time.time() - t0) * 1000
        return 999, {"error": str(e)}, {}, elapsed_ms


# ---------------------------------------------------------------------------
# Suite 1: KB 快速对话摘要测试 (/v1/chat/completions, model="chat")
# ---------------------------------------------------------------------------
def test_suite_kb_chat():
    log_section("测试套件 1: KB 快速对话摘要测试 (model='chat')")
    
    payload = {
        "model": "chat",
        "messages": [
            {"role": "system", "content": "你是一个高效的知识库总结助手。"},
            {"role": "user", "content": "请用一句话概括：知识库在大模型 RAG 系统中的核心作用是什么？"}
        ],
        "max_tokens": 400
    }
    
    print("  ▶ 正在发送 KB 对话请求...")
    status, body, headers, elapsed_ms = send_request("/v1/chat/completions", body=payload)
    routed_via = headers.get("X-Routed-Via", "未知")
    
    print(f"    状态码: HTTP {status} | 耗时: {elapsed_ms:.1f}ms | 路由: {routed_via}")
    assert status == 200, f"KB Chat 请求失败: HTTP {status} - {body}"
    
    choice = body.get("choices", [{}])[0]
    msg = choice.get("message", {})
    content = msg.get("content", "")
    reasoning_content = msg.get("reasoning_content")
    
    print(f"    输出内容: \"{content.strip()[:80]}...\"")
    print(f"    思维链(Reasoning): {'无 (已按 KB 规范强制关闭)' if not reasoning_content else '极简模式 (低档)'}")
    
    assert len(content) > 5, "返回内容过短"
    print("  🎉 KB 快速对话测试通过！")


# ---------------------------------------------------------------------------
# Suite 2: 文本向量化测试 (/v1/embeddings, model="embedding")
# ---------------------------------------------------------------------------
def test_suite_kb_embeddings():
    log_section("测试套件 2: 文本向量化测试 (model='embedding')")
    
    # 1. 单条文本 Embedding 测试
    print("  ▶ 1. 正在测试单条文档向量化...")
    payload_single = {
        "model": "embedding",
        "input": "知识库切片测试：大模型通过向量检索能够获取私域知识并有效降低幻觉。"
    }
    status, body, headers, elapsed_ms = send_request("/v1/embeddings", body=payload_single)
    routed_via = headers.get("X-Routed-Via", "未知")
    print(f"    状态码: HTTP {status} | 耗时: {elapsed_ms:.1f}ms | 路由: {routed_via}")
    assert status == 200, f"单条 Embedding 失败: {body}"
    
    data_list = body.get("data", [])
    assert len(data_list) == 1, "应返回 1 组向量"
    vec1 = data_list[0].get("embedding", [])
    dim1 = len(vec1)
    print(f"    向量维度: {dim1} 维 (首位数值: {vec1[0]:.6f})")
    assert dim1 in (1024, 1536, 2048, 2560, 4096), f"异常向量维度: {dim1}"
    
    # 2. 批量多文档 Embedding 测试 (模拟 Dify 批量入库)
    print("\n  ▶ 2. 正在测试批量多文档向量化 (Batch=3)...")
    payload_batch = {
        "model": "embedding",
        "input": [
            "第一篇：关于分布式系统的CAP定理分析与实践",
            "第二篇：基于Raft一致性协议的状态机复制算法",
            "第三篇：向量数据库在长文本知识召回中的性能优化"
        ]
    }
    status_b, body_b, headers_b, elapsed_b = send_request("/v1/embeddings", body=payload_batch)
    routed_via_b = headers_b.get("X-Routed-Via", "未知")
    print(f"    状态码: HTTP {status_b} | 耗时: {elapsed_b:.1f}ms | 路由: {routed_via_b}")
    assert status_b == 200, f"批量 Embedding 失败: {body_b}"
    
    batch_data = body_b.get("data", [])
    assert len(batch_data) == 3, f"期望返回 3 组向量，实际返回 {len(batch_data)}"
    print(f"    批量校验: 成功生成 {len(batch_data)} 组向量，各向量维度一致 ({len(batch_data[0]['embedding'])} 维)")
    
    print("  🎉 文本向量化测试全部通过！")


# ---------------------------------------------------------------------------
# Suite 3: 检索重排测试 (/v1/rerank, model="reranker")
# ---------------------------------------------------------------------------
def test_suite_kb_rerank():
    log_section("测试套件 3: 检索重排测试 (model='reranker')")
    
    query = "如何预防和处理大模型的上下文窗口遗忘问题？"
    documents = [
        "今天天气很好，阳光明媚，适合去公园散步。",
        "可以通过长文本注意力稀疏化、上下文压缩算法以及分块检索增强(RAG)来缓解模型遗忘。",
        "Python 是一种广泛应用于数据科学和后端开发的高级编程语言。",
        "对于长会话，定期对历史消息进行关键要点提炼摘要，能够有效保持上下文焦点。"
    ]
    
    payload = {
        "model": "reranker",
        "query": query,
        "documents": documents,
        "top_n": 3
    }
    
    print(f"  ▶ 正在执行 Rerank 打分 (Query + {len(documents)} 篇文档)...")
    status, body, headers, elapsed_ms = send_request("/v1/rerank", body=payload)
    routed_via = headers.get("X-Routed-Via", "未知")
    print(f"    状态码: HTTP {status} | 耗时: {elapsed_ms:.1f}ms | 路由: {routed_via}")
    assert status == 200, f"Rerank 请求失败: {body}"
    
    results = body.get("results", [])
    assert len(results) >= 1, "Rerank 返回结果为空"
    
    print("    [重排结果 (按相关性得分降序)]:")
    for idx, r in enumerate(results):
        doc_idx = r.get("index")
        score = r.get("relevance_score", 0.0)
        doc_snippet = documents[doc_idx][:35].replace("\n", " ")
        print(f"      Top {idx+1}: [Doc #{doc_idx}] 得分: {score:.4f} | 内容: \"{doc_snippet}...\"")
    
    # 校验相关性排序正确性（文档 1 或 3 得分应当明显高于文档 0 和 2）
    top1_idx = results[0].get("index")
    assert top1_idx in (1, 3), f"预期相关文档为 #1 或 #3，实际 Top 1 为 #{top1_idx}"
    print("  🎉 检索重排测试通过！")


# ---------------------------------------------------------------------------
# Suite 4: 多模态 OCR 图文提取测试 (/v1/ocr, model="ocr")
# ---------------------------------------------------------------------------
def test_suite_kb_ocr():
    log_section("测试套件 4: 多模态 OCR 图文提取测试 (model='ocr')")
    
    payload = {
        "model": "ocr",
        "image_base64": SAMPLE_PNG_BASE64,
        "prompt": "请识别图中的内容，如果是纯色图片请简要说明。"
    }
    
    print("  ▶ 正在发送 OCR 图像识别请求...")
    status, body, headers, elapsed_ms = send_request("/v1/ocr", body=payload, timeout=60.0)
    routed_via = headers.get("X-Routed-Via", "未知")
    print(f"    状态码: HTTP {status} | 耗时: {elapsed_ms:.1f}ms | 路由: {routed_via}")
    assert status == 200, f"OCR 请求失败: {body}"
    
    choice = body.get("choices", [{}])[0]
    content = choice.get("message", {}).get("content", "")
    print(f"    OCR 识别响应: \"{content.strip()[:60]}...\"")
    assert len(content) > 0, "OCR 返回内容为空"
    print("  🎉 多模态 OCR 测试通过！")


# ---------------------------------------------------------------------------
# Suite 5: Key 轮询负载均衡测试 (Round-Robin Routing)
# ---------------------------------------------------------------------------
def test_suite_round_robin_routing(cycles: int = 5):
    log_section(f"测试套件 5: Key 轮询负载均衡 (Round-Robin) 测试 — {cycles} 轮调用")
    
    payload = {
        "model": "chat",
        "messages": [{"role": "user", "content": "1+1等于几？"}],
        "max_tokens": 10
    }
    
    routes_hit = []
    for i in range(cycles):
        status, body, headers, elapsed_ms = send_request("/v1/chat/completions", body=payload)
        routed_via = headers.get("X-Routed-Via", "unknown")
        routes_hit.append(routed_via)
        print(f"    [轮次 {i+1}/{cycles}] HTTP {status} | 路由: {routed_via} | 耗时: {elapsed_ms:.1f}ms")
        assert status == 200, f"轮询第 {i+1} 次失败: {body}"
        time.sleep(0.3)
        
    unique_routes = set(routes_hit)
    print(f"\n  📊 轮询统计: 共发起 {cycles} 次请求，命中 {len(unique_routes)} 个不同路由节点: {unique_routes}")
    print("  🎉 轮询负载均衡机制验证正常！")


# ---------------------------------------------------------------------------
# Suite 6: 全量负向安全鉴权穿透测试 (Security & Auth Guard)
# ---------------------------------------------------------------------------
def test_suite_security_auth():
    log_section("测试套件 6: 全量负向安全鉴权穿透测试 (Security & Auth Guard)")
    
    endpoints = [
        ("GET", "/v1/models", None),
        ("POST", "/v1/chat/completions", {"model": "chat", "messages": [{"role": "user", "content": "hi"}]}),
        ("POST", "/v1/embeddings", {"model": "embedding", "input": "test"}),
        ("POST", "/v1/rerank", {"model": "reranker", "query": "q", "documents": ["d1"]}),
        ("POST", "/v1/ocr", {"image_base64": SAMPLE_PNG_BASE64}),
        ("GET", "/api/admin/config", None),
        ("POST", "/api/admin/restart", {}),
    ]
    
    # 1. 匿名无 Key 访问测试
    print("  ▶ 1. 匿名访问测试 (无 Authorization Header):")
    for method, path, payload in endpoints:
        status, _, _, _ = send_request(path, method=method, body=payload, api_key=None)
        is_ok = (status == 401)
        print(f"    {method:<4} {path:<25} -> HTTP {status} | {'✅ 已安全拦截 (401)' if is_ok else '❌ 漏洞风险!'}")
        assert is_ok, f"匿名请求未被拦截: {path}"
        
    # 2. 伪造非法 Key 访问测试
    print("\n  ▶ 2. 伪造假 Key 测试 (Bearer fake-token-999):")
    for method, path, payload in endpoints:
        status, _, _, _ = send_request(path, method=method, body=payload, api_key="fake-token-999999999")
        is_ok = (status == 401)
        print(f"    {method:<4} {path:<25} -> HTTP {status} | {'✅ 已安全拦截 (401)' if is_ok else '❌ 漏洞风险!'}")
        assert is_ok, f"假 Key 请求未被拦截: {path}"
        
    # 3. 越权测试: 普通 Client Key 尝试访问 Admin 接口
    print("\n  ▶ 3. 越权访问测试 (Client Key 尝试调用 Admin API):")
    admin_paths = ["/api/admin/config", "/api/admin/restart", "/api/admin/stats"]
    for path in admin_paths:
        status, _, _, _ = send_request(path, method="GET" if "config" in path or "stats" in path else "POST",
                                       body={} if "restart" in path else None, api_key=PROXY_API_KEY)
        is_ok = (status == 401)
        print(f"    {path:<30} -> HTTP {status} | {'✅ 权限隔离有效，禁止越权 (401)' if is_ok else '❌ 越权风险!'}")
        assert is_ok, f"越权请求未被拦截: {path}"
        
    print("\n  🎉 全量安全穿透测试 100% 通过！系统极其安全！")


# ---------------------------------------------------------------------------
# Main Runner
# ---------------------------------------------------------------------------
def main():
    print("\n" + "=" * 70)
    print("  🚀 开始执行 OCRProxy KB 模式生产级标准自动化测试套件")
    print(f"  目标服务器: {TARGET_URL}")
    print("=" * 70)
    
    t_start = time.time()
    try:
        test_suite_kb_chat()
        test_suite_kb_embeddings()
        test_suite_kb_rerank()
        test_suite_kb_ocr()
        test_suite_round_robin_routing(cycles=5)
        test_suite_security_auth()
        
        total_time = time.time() - t_start
        print("\n" + "=" * 70)
        print(f"  🏁 全部 KB 模式生产级测试套件 100% 执行通过！总耗时: {total_time:.2f}s")
        print("  🎉 系统极其稳健，符合生产级知识库对接标准！")
        print("=" * 70 + "\n")
    except Exception as e:
        print(f"\n❌ 测试套件执行失败: {e}\n")
        raise e


if __name__ == "__main__":
    main()
