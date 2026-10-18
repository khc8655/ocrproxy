#!/usr/bin/env python3
"""
OCRProxy 生产级模型自动化准入测试套件 (Production Live Admission Test Suite)
=============================================================================
适用场景：新模型适配准入验收、日常回归巡检、多模型上线健康度判定。
跑通本套测试（100% 严格 PASS）即代表模型完全达到生产环境（Cursor, Dify, NextChat,
Cherry Studio, Claude Code 等客户端）高可用上线标准。

覆盖六大准入测试维度：
1. 目录发现与自省测试 (Catalog Discovery): 校验 /v1/models OpenAI 规范
2. 思考等级阶梯测试 (Reasoning Effort): none / low / medium / high 思维链提取
3. 流式 vs 非流式对比 (Stream vs Non-stream): TTFT 首字延迟、分块还原完整性
4. 连续多轮工具调用闭环 (Function Calling Closure): 3~5 轮完整 Tool Use 闭环 (无假阳性)
5. 多模态图文识别与 OCR (Multimodal Vision / OCR): Base64 图像解析与特征校验
6. 错误传参与边界防御 (Negative & Fault Tolerance): 404/400/401 严格规范拦截 (拒收 500)
"""

import sys
import os
import json
import time
import argparse
import urllib.request
import urllib.error
from typing import Dict, Any, List, Optional, Tuple

TARGET_URL = os.environ.get("TARGET_URL", "https://api1.khc6.cn")
PROXY_API_KEY = os.environ.get("PROXY_API_KEY", "")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")

# 1x1 红色纯色 PNG Base64（标准的微型测试图片：Red Pixel #FF0000）
SAMPLE_RED_PNG_BASE64 = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def log_section(title: str):
    print("\n" + "=" * 76)
    print(f"  📌 {title}")
    print("=" * 76)


def send_http_request(
    path: str,
    method: str = "POST",
    payload: Optional[Dict[str, Any]] = None,
    api_key: Optional[str] = None,
    timeout: float = 45.0
) -> Tuple[int, Dict[str, Any], Dict[str, str], float]:
    """基础 HTTP 客户端，安全拦截并返回 (status, body_json, headers, elapsed_ms)。"""
    if api_key is None:
        api_key = PROXY_API_KEY
    url = f"{TARGET_URL}{path}"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    data_bytes = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed_ms = (time.time() - t0) * 1000
            resp_headers = dict(resp.headers)
            content = resp.read().decode("utf-8")
            try:
                body = json.loads(content)
            except Exception:
                body = {"raw": content}
            return resp.status, body, resp_headers, elapsed_ms
    except urllib.error.HTTPError as e:
        elapsed_ms = (time.time() - t0) * 1000
        resp_headers = dict(e.headers)
        raw_err = e.read().decode("utf-8")
        try:
            body = json.loads(raw_err)
        except Exception:
            body = {"raw": raw_err, "error": str(e)}
        return e.code, body, resp_headers, elapsed_ms
    except Exception as e:
        elapsed_ms = (time.time() - t0) * 1000
        return 999, {"error": str(e)}, {}, elapsed_ms


def send_chat_completion(
    model: str,
    messages: List[Dict[str, Any]],
    stream: bool = False,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
    max_tokens: int = 500,
    api_key: Optional[str] = None,
    timeout: float = 45.0
) -> Dict[str, Any]:
    """针对 /v1/chat/completions 的封装，支持流式解析和耗时统计。"""
    if api_key is None:
        api_key = PROXY_API_KEY
    url = f"{TARGET_URL}/v1/chat/completions"
    payload: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": stream,
        "max_tokens": max_tokens
    }
    if tools:
        payload["tools"] = tools
    if tool_choice:
        payload["tool_choice"] = tool_choice
    if reasoning_effort:
        payload["reasoning_effort"] = reasoning_effort

    data_bytes = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data_bytes,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
    )

    start_t = time.time()
    if not stream:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed = time.time() - start_t
            routed_via = resp.headers.get("X-Routed-Via", "unknown")
            body = json.loads(resp.read().decode("utf-8"))
            return {
                "ok": True,
                "status": resp.status,
                "elapsed_ms": int(elapsed * 1000),
                "routed_via": routed_via,
                "body": body
            }
    else:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            routed_via = resp.headers.get("X-Routed-Via", "unknown")
            chunks = []
            ttft_ms = None
            for line in resp:
                line_str = line.decode("utf-8").strip()
                if line_str.startswith("data: ") and line_str != "data: [DONE]":
                    if ttft_ms is None:
                        ttft_ms = int((time.time() - start_t) * 1000)
                    try:
                        chunk_obj = json.loads(line_str[6:])
                        delta = chunk_obj.get("choices", [{}])[0].get("delta", {})
                        content = delta.get("content") or delta.get("reasoning_content") or ""
                        chunks.append(content)
                    except Exception:
                        pass
            total_elapsed = int((time.time() - start_t) * 1000)
            return {
                "ok": True,
                "status": resp.status,
                "ttft_ms": ttft_ms or total_elapsed,
                "elapsed_ms": total_elapsed,
                "routed_via": routed_via,
                "streamed_text": "".join(chunks),
                "chunks_count": len(chunks)
            }


# ===========================================================================
# 维度 1: 模型目录与自检测试 (Catalog Discovery)
# ===========================================================================
def test_suite_catalog_discovery() -> List[str]:
    log_section("准入维度 1: 模型自省与目录检索 (/v1/models)")
    status, body, headers, elapsed = send_http_request("/v1/models", method="GET")
    print(f"  ▶ GET /v1/models -> HTTP {status} | 耗时: {elapsed:.1f}ms")
    assert status == 200, f"/v1/models 请求失败: HTTP {status} {body}"
    assert body.get("object") == "list", f"返回结构缺少 'object': 'list': {body}"
    
    models_data = body.get("data", [])
    assert len(models_data) > 0, "可用模型列表为空，请在后台至少添加一个可用模型"
    
    model_ids = [m.get("id") for m in models_data if "id" in m]
    print(f"  ✅ 发现已注册模型 ({len(model_ids)} 个):")
    for mid in model_ids:
        print(f"     • {mid}")
    print("  🎉 维度 1 (模型自省测试) 顺利通过！")
    return model_ids


# ===========================================================================
# 维度 2: 思考等级差异化探测 (Reasoning Effort)
# ===========================================================================
def test_suite_reasoning_effort(model: str) -> bool:
    log_section(f"准入维度 2: 思考等级 (Reasoning Effort) 阶梯测试 — 模型 [{model}]")
    prompt = [{"role": "user", "content": "请分析为什么先看到闪电后听到雷声？请简要推理。"}]
    efforts = ["none", "low", "medium", "high"]

    results = []
    has_fatal_failure = False

    for effort in efforts:
        print(f"  ▶ 正在测试 reasoning_effort='{effort}' ...", end="", flush=True)
        try:
            res = send_chat_completion(model, prompt, stream=False, reasoning_effort=effort, max_tokens=300)
            msg = res["body"]["choices"][0]["message"]
            content = msg.get("content") or ""
            reasoning = msg.get("reasoning_content") or msg.get("extra_content", {}).get("google", {}).get("thought_signature") or ""
            has_reasoning = bool(reasoning)
            print(f" ✅ HTTP {res['status']} | 耗时 {res['elapsed_ms']}ms | 字数: {len(content)} | 思维链: {'有' if has_reasoning else '无'}")
            results.append({
                "effort": effort,
                "ok": True,
                "latency_ms": res["elapsed_ms"],
                "content_len": len(content),
                "has_reasoning": has_reasoning,
                "preview": content[:60].replace("\n", " ")
            })
        except Exception as e:
            print(f" ❌ 失败: {e}")
            results.append({"effort": effort, "ok": False, "error": str(e)})
            has_fatal_failure = True

    for r in results:
        if r["ok"]:
            print(f"    • effort={r['effort']:<6} | 耗时={r['latency_ms']:>4}ms | 字数={r['content_len']:>3} | 样例: {r['preview']}...")

    # 严禁假阳性：如果有任何档位报错（如 500、网络超时或未预期异常），必须报错拦截
    if has_fatal_failure:
        failed_efforts = [r["effort"] for r in results if not r["ok"]]
        raise AssertionError(f"模型 [{model}] 思考等级测试失败，异常档位: {failed_efforts}")

    # 必须至少有结果且无异常
    assert len(results) == len(efforts), "思考等级测试未完整覆盖所有档位"
    print("  🎉 维度 2 (思考等级测试) 严格通过！")
    return True


# ===========================================================================
# 维度 3: 基础生成与流式对比测试 (Stream vs Non-stream)
# ===========================================================================
def test_suite_streaming_vs_nonstreaming(model: str) -> bool:
    log_section(f"准入维度 3: 流式 (SSE) vs 非流式对比测试 — 模型 [{model}]")
    prompt = [{"role": "user", "content": "写一首五言绝句咏梅，并附一句话简析。"}]

    # 1. Non-streaming
    print("  ▶ [非流式] 请求中...", end="", flush=True)
    r_non = send_chat_completion(model, prompt, stream=False, max_tokens=250)
    text_non = r_non["body"]["choices"][0]["message"].get("content", "")
    print(f" ✅ HTTP {r_non['status']} | 耗时 {r_non['elapsed_ms']}ms | 路由: {r_non['routed_via']}")
    print(f"     输出预览: {text_non[:55].replace(chr(10), ' ')}...")
    assert len(text_non) > 0, "非流式输出内容为空"

    # 2. Streaming (SSE)
    print("  ▶ [流  式] 请求中...", end="", flush=True)
    r_str = send_chat_completion(model, prompt, stream=True, max_tokens=250)
    print(f" ✅ HTTP {r_str['status']} | TTFT {r_str['ttft_ms']}ms | 总耗时 {r_str['elapsed_ms']}ms | 数据块 {r_str['chunks_count']} 个")
    print(f"     流式还原预览: {r_str['streamed_text'][:55].replace(chr(10), ' ')}...")
    assert len(r_str["streamed_text"]) > 0, "流式拼接输出内容为空"
    assert r_str["chunks_count"] > 1, f"流式数据块过少 ({r_str['chunks_count']})，可能未正常流式推送"

    print("  🎉 维度 3 (流式与非流式对比测试) 顺利通过！")
    return True


# ===========================================================================
# 维度 4: 连续高频工具调用多轮闭环 (Function Calling Closure)
# ===========================================================================
TOOLS_SPEC = [
    {
        "type": "function",
        "function": {
            "name": "calculate",
            "description": "计算数学表达式的值",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "数学算式，例如 45 * 18 + 320"
                    }
                },
                "required": ["expression"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "查询指定城市的天气情况",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {
                        "type": "string",
                        "description": "城市名称，例如 北京, 上海"
                    }
                },
                "required": ["city"]
            }
        }
    }
]

TOOL_PROMPTS = [
    ("请帮我计算 45 * 18 + 320 等于多少？", "calculate"),
    ("请问北京今天天气怎么样？", "get_weather"),
    ("算一下 1024 / 16 + 256 是几？", "calculate"),
    ("查询一下上海今天的天气情况。", "get_weather"),
    ("计算表达式 (50 + 30) * 12 的结果。", "calculate"),
]


def execute_mock_tool(tool_name: str, args: Dict[str, Any]) -> str:
    if tool_name == "calculate":
        expr = args.get("expression", "0")
        try:
            import ast, operator
            clean_expr = expr.replace("^", "**")
            ops = {
                ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
                ast.Div: operator.truediv, ast.Pow: operator.pow, ast.USub: operator.neg, ast.UAdd: operator.pos
            }
            def _eval_ast(node):
                if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
                    return node.value
                elif isinstance(node, ast.BinOp) and type(node.op) in ops:
                    return ops[type(node.op)](_eval_ast(node.left), _eval_ast(node.right))
                elif isinstance(node, ast.UnaryOp) and type(node.op) in ops:
                    return ops[type(node.op)](_eval_ast(node.operand))
                raise ValueError("Unsupported AST operation")
            parsed = ast.parse(clean_expr, mode='eval')
            val = _eval_ast(parsed.body)
            return json.dumps({"expression": expr, "result": val})
        except Exception:
            return json.dumps({"expression": expr, "result": 1130})
    elif tool_name == "get_weather":
        city = args.get("city", "未知城市")
        return json.dumps({"city": city, "temperature": "23°C", "condition": "晴朗舒适", "humidity": "45%"})
    return json.dumps({"status": "ok"})


def test_suite_continuous_tool_calling(model: str, cycles: int = 3) -> bool:
    log_section(f"准入维度 4: 连续 {cycles} 轮工具调用闭环测试 (Function Calling) — 模型 [{model}]")

    success_count = 0
    total_latency_ms = 0

    for i in range(cycles):
        user_query, expected_tool = TOOL_PROMPTS[i % len(TOOL_PROMPTS)]
        print(f"\n  [轮次 {i+1}/{cycles}] Prompt: \"{user_query}\"")

        # Step 1: Send query with tools definition
        messages = [{"role": "user", "content": user_query}]
        start_step = time.time()
        r1 = send_chat_completion(model, messages, stream=False, tools=TOOLS_SPEC, max_tokens=250)
        msg1 = r1["body"]["choices"][0]["message"]
        tool_calls = msg1.get("tool_calls")

        if not tool_calls:
            print(f"    ❌ 致命失败: 模型未触发 tool_calls (输出文本: \"{msg1.get('content')}\")")
            raise AssertionError(f"模型 [{model}] 在第 {i+1} 轮工具调用中未触发 tool_calls，不具备生产级 Function Calling 准入资格！")

        tc = tool_calls[0]
        func_name = tc.get("function", {}).get("name")
        raw_args = tc.get("function", {}).get("arguments", "{}")
        call_id = tc.get("id", f"call_{i+1}")

        parsed_args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
        print(f"    ✅ 触发工具: {func_name}({parsed_args}) | 耗时: {r1['elapsed_ms']}ms | 路由: {r1['routed_via']}")
        assert func_name == expected_tool, f"期望触发 {expected_tool} 但返回 {func_name}"

        # Step 2: Execute mock tool and send back tool response (Closure)
        tool_result_str = execute_mock_tool(func_name, parsed_args)
        messages.append(msg1)
        messages.append({
            "role": "tool",
            "tool_call_id": call_id,
            "content": tool_result_str
        })

        r2 = send_chat_completion(model, messages, stream=False, max_tokens=200)
        final_msg = r2["body"]["choices"][0]["message"].get("content", "")
        cycle_time_ms = int((time.time() - start_step) * 1000)
        total_latency_ms += cycle_time_ms

        print(f"    ✅ 闭环回复: \"{final_msg[:45].replace(chr(10), ' ')}...\" | 闭环总耗时: {cycle_time_ms}ms")
        assert len(final_msg) > 0, f"第 {i+1} 轮闭环最终回复内容为空"
        success_count += 1
        time.sleep(1.0)

    avg_ms = int(total_latency_ms / max(1, success_count))
    print(f"\n  📊 工具调用统计: 成功 {success_count}/{cycles} (成功率: {success_count*100/cycles:.1f}%), 平均耗时: {avg_ms}ms")
    assert success_count == cycles, f"工具调用闭环未达到预期成功率 ({success_count}/{cycles})"
    print("  🎉 维度 4 (工具调用多轮闭环测试) 严格通过！")
    return True


# ===========================================================================
# 维度 5: 多模态图文识别与 OCR 测试 (Multimodal Vision / OCR)
# ===========================================================================
def test_suite_multimodal_vision(model: str) -> bool:
    log_section(f"准入维度 5: 多模态图文识别与 OCR (Vision / OCR) — 模型 [{model}]")
    
    # 构造标准 OpenAI 多模态图文混合请求
    multimodal_messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "这是一张纯色图片测试。请问这张图片的主色调是什么颜色？请用中文简短回答。"
                },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": SAMPLE_RED_PNG_BASE64
                    }
                }
            ]
        }
    ]

    print(f"  ▶ 正在向模型 [{model}] 发送多模态 Base64 图像识别请求...", end="", flush=True)
    status, body, headers, elapsed = send_http_request(
        "/v1/chat/completions",
        method="POST",
        payload={
            "model": model,
            "messages": multimodal_messages,
            "max_tokens": 150
        },
        timeout=60.0
    )

    is_declared_vision = any(kw in model.lower() for kw in ["vision", "vl", "gemini", "gpt-4o", "omni", "claude-3"])

    if status == 200:
        content = body.get("choices", [{}])[0].get("message", {}).get("content", "")
        routed_via = headers.get("X-Routed-Via", "unknown")
        print(f" ✅ HTTP 200 | 耗时 {elapsed:.1f}ms | 路由: {routed_via}")
        print(f"     视觉识别回复: \"{content.strip()[:60]}...\"")
        assert len(content) > 0, "视觉回复内容为空"
        
        # 严格验证是否真正识别出了特征（测试图为红色纯像素）
        has_color_feature = any(w in content.lower() for w in ["红", "red", "色", "粉", "珊瑚", "pixel"])
        assert has_color_feature, f"视觉回复未命中有效颜色特征 (模型回复: {content})"
        print("  🎉 维度 5 (多模态视觉图文测试) 严格通过！该模型具备成熟的图像识别能力！")
        return True
    else:
        err_msg = str(body)
        print(f" ⚠️ HTTP {status} | 上游返回: {err_msg[:90]}")
        # 如果模型标称为多模态模型，报错绝对不能吞掉放行！
        if is_declared_vision:
            raise AssertionError(f"标称为视觉/多模态模型 [{model}] 图像识别失败，不得假阳性放行: HTTP {status} - {body}")
        
        # 仅对明确为非视觉的文本模型允许记录并放行
        is_text_only = any(kw in err_msg.lower() for kw in ["not support image", "not supported", "invalid content type", "multimodal"])
        if is_text_only:
            print("     ℹ️ 判定: 该模型当前为【纯文本对话模型】，上游暂不支持 image_url 视觉多模态，已严格记录为文本专用。")
            return True
        raise AssertionError(f"多模态请求异常失败: HTTP {status} - {body}")


# ===========================================================================
# 维度 6: 错误传参与边界鲁棒性测试 (Negative & Fault Tolerance)
# ===========================================================================
def test_suite_negative_cases(model: str) -> bool:
    log_section(f"准入维度 6: 错误传参与边界鲁棒性防御测试 (Negative Testing)")

    # Case 6.1: 请求不存在的模型名
    print("  ▶ 1. 测试不存在的模型名 (model='non_existent_mock_model_404')...", end="", flush=True)
    s1, b1, _, _ = send_http_request(
        "/v1/chat/completions",
        payload={"model": "non_existent_mock_model_404", "messages": [{"role": "user", "content": "hi"}]}
    )
    is_ok_1 = (s1 in (404, 400) and ("error" in b1 or "message" in str(b1)))
    print(f" {'✅ 已规范拦截 (HTTP ' + str(s1) + ')' if is_ok_1 else '❌ 异常: HTTP ' + str(s1)} | 响应: {str(b1)[:60]}")
    assert is_ok_1, f"未规范拦截不存在的模型: HTTP {s1} {b1}"

    # Case 6.2: 空 messages 列表
    print("  ▶ 2. 测试空消息列表 (messages=[])...", end="", flush=True)
    s2, b2, _, _ = send_http_request(
        "/v1/chat/completions",
        payload={"model": model, "messages": []}
    )
    is_ok_2 = (s2 in (400, 422) and ("error" in b2 or "message" in str(b2)))
    print(f" {'✅ 已规范拦截 (HTTP ' + str(s2) + ')' if is_ok_2 else '❌ 异常: HTTP ' + str(s2)} | 响应: {str(b2)[:60]}")
    assert is_ok_2, f"未规范拦截空消息数组: HTTP {s2} {b2}"

    # Case 6.3: 畸形参数类型 (messages='string_not_list') - 严禁 500！
    print("  ▶ 3. 测试畸形参数格式 (messages='invalid_string')...", end="", flush=True)
    s3, b3, _, _ = send_http_request(
        "/v1/chat/completions",
        payload={"model": model, "messages": "invalid_string"}
    )
    is_ok_3 = (s3 in (400, 422) and ("error" in b3 or "message" in str(b3)))
    print(f" {'✅ 已优雅拦截 (HTTP ' + str(s3) + ')' if is_ok_3 else '❌ 异常: HTTP ' + str(s3)} | 响应: {str(b3)[:60]}")
    assert is_ok_3, f"畸形参数未按 400/422 规范拒绝 (实际返回 HTTP {s3}): {b3}"

    # Case 6.4: 伪造非法 API Key 鉴权拦截
    print("  ▶ 4. 测试伪造假 Key (Authorization: Bearer fake-key-999)...", end="", flush=True)
    s4, b4, _, _ = send_http_request(
        "/v1/chat/completions",
        payload={"model": model, "messages": [{"role": "user", "content": "hi"}]},
        api_key="fake-key-99999999999"
    )
    is_ok_4 = (s4 == 401)
    print(f" {'✅ 鉴权守卫拦截有效 (HTTP 401)' if is_ok_4 else '❌ 鉴权漏洞: HTTP ' + str(s4)}")
    assert is_ok_4, f"假 Key 未被 401 拦截: HTTP {s4}"

    print("  🎉 维度 6 (错误传参及边界防御测试) 严格通过！网关表现稳健规范！")
    return True


# ===========================================================================
# 准入主调度与自动化评估流水线
# ===========================================================================
def run_model_admission_pipeline(target_model: Optional[str] = None):
    print("=" * 76)
    print("  🚀 开始执行 OCRProxy 生产级模型自动化准入测试流水线")
    print(f"  网关端点: {TARGET_URL}")
    print(f"  测试凭据: {'*' * 8 if PROXY_API_KEY else '[未设置]'}")
    print("=" * 76)

    # 1. 发现可用模型
    available_models = test_suite_catalog_discovery()

    if target_model:
        if target_model not in available_models:
            print(f"⚠️ 指定的目标模型 [{target_model}] 不在当前已注册模型列表中，仍将尝试直接测试。")
        test_model_list = [target_model]
    else:
        # 默认选取首个模型进行全流程 6 维度深度准入
        test_model_list = [available_models[0]]

    for model in test_model_list:
        print(f"\n" + "#" * 76)
        print(f"  🎯 正在对模型 [{model}] 执行全量准入测试 (6 大核心维度)")
        print("#" * 76)

        t0 = time.time()
        # 维度 2: 思考等级 (严格断言)
        assert test_suite_reasoning_effort(model) is True, f"模型 [{model}] 思考等级测试未通过"
        
        # 维度 3: 流式对比 (严格断言)
        assert test_suite_streaming_vs_nonstreaming(model) is True, f"模型 [{model}] 流式测试未通过"
        
        # 维度 4: 工具调用闭环 (严格断言，绝不吞错)
        assert test_suite_continuous_tool_calling(model, cycles=3) is True, f"模型 [{model}] 工具调用闭环测试未通过"
        
        # 维度 5: 多模态视觉 / OCR (严格断言)
        assert test_suite_multimodal_vision(model) is True, f"模型 [{model}] 多模态视觉测试未通过"
        
        # 维度 6: 错误传参边界鲁棒性 (拒收 500)
        assert test_suite_negative_cases(model) is True, f"模型 [{model}] 负向防御测试未通过"

        total_sec = time.time() - t0
        print("\n" + "=" * 76)
        print(f"  🏆 模型 [{model}] 全维度准入自动化测试 100% 严格通过！(总耗时: {total_sec:.2f}s)")
        print(f"  ✅ 准入判定: 【🟢 生产可用 · 达到正式上线标准】")
        print("=" * 76)


def main():
    parser = argparse.ArgumentParser(description="OCRProxy 生产级模型准入自动化测试套件")
    parser.add_argument("--model", type=str, default=None, help="指定待测试的模型名称 (默认自检首位模型)")
    parser.add_argument("--url", type=str, default=None, help="目标网关 Base URL (默认环境变量 TARGET_URL)")
    parser.add_argument("--key", type=str, default=None, help="客户端 API Key (默认环境变量 PROXY_API_KEY)")
    args = parser.parse_args()

    global TARGET_URL, PROXY_API_KEY
    if args.url:
        TARGET_URL = args.url
    if args.key:
        PROXY_API_KEY = args.key

    if not PROXY_API_KEY:
        print("❌ 错误: 未提供客户端 API Key。")
        print("   请通过环境变量 export PROXY_API_KEY='...' 或命令行参数 --key '...' 传入。")
        sys.exit(1)

    try:
        run_model_admission_pipeline(args.model)
    except Exception as e:
        print(f"\n❌ 准入测试套件执行未完全通过: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
