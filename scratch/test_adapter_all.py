import urllib.request
import json
import time

PROXY_KEY = "3q0xqZ7bes6lDUgltZg8uoj6LwXzMpcpwpIQ9wZh"
BASE_URL = "https://api.khc6.cn"

def banner(title):
    print("\n" + "=" * 65)
    print(f"  {title}")
    print("=" * 65)

def test_model(model_name, prompt, reasoning_effort=None, tool_choice=None, stream=False):
    url = f"{BASE_URL}/v1/chat/completions"
    payload = {
        "model": model_name,
        "messages": [{"role": "user", "content": prompt}],
        "stream": stream,
        "max_tokens": 120
    }
    if reasoning_effort is not None:
        payload["reasoning_effort"] = reasoning_effort
    if tool_choice is not None:
        payload["tool_choice"] = tool_choice
        payload["tools"] = [{
            "type": "function",
            "function": {
                "name": "calculate",
                "description": "计算器",
                "parameters": {
                    "type": "object",
                    "$schema": "http://json-schema.org/draft-07/schema#",
                    "properties": {"expr": {"type": "string"}},
                    "required": ["expr"]
                }
            }
        }]

    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {PROXY_KEY}", "Content-Type": "application/json"},
        data=json.dumps(payload).encode("utf-8")
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            elapsed = time.time() - start
            headers = dict(resp.headers)
            route = headers.get("x-proxy-route") or "direct"
            if stream:
                first_chunk = time.time() - start
                chunks = sum(1 for _ in resp)
                print(f"✅ [{model_name} 流式] (耗时: {elapsed:.2f}s | TTFB: {first_chunk:.2f}s | Chunks: {chunks})")
            else:
                body = json.loads(resp.read().decode("utf-8"))
                msg = body.get("choices", [{}])[0].get("message", {})
                content = msg.get("content") or msg.get("reasoning_content") or msg.get("reasoning") or ""
                print(f"✅ [{model_name}] (耗时: {elapsed:.2f}s | 状态: {resp.status})")
                print(f"   - 链路轨迹: {route}")
                print(f"   - 消息回复: {content.strip()[:100]}")
                if msg.get("tool_calls"):
                    print(f"   - 工具调用: {msg['tool_calls']}")
    except Exception as e:
        print(f"❌ [{model_name}] 异常 ({time.time()-start:.2f}s): {e}")

if __name__ == "__main__":
    banner("1. 阶跃星辰: step-3.7-flash (reasoning_effort=none 自动降级与 deepseek-style 注入)")
    test_model("step-3.7-flash", "请用一句话介绍阶跃星辰。", reasoning_effort="none")

    banner("2. Agnes AI: agnes-2.5-flash (reasoning_effort=high 映射为 enable_thinking)")
    test_model("agnes-2.5-flash", "请用一句话介绍人工智能。", reasoning_effort="high")

    banner("3. 商汤智谱: glm-5.2 (1M 上下文旗舰推理)")
    test_model("glm-5.2", "请输出一句简短的名人名言。")

    banner("4. 商汤深度思考: deepseek-v4-flash (1M 上下文深度推理)")
    test_model("deepseek-v4-flash", "量子纠缠是什么？用一句话通俗解释。")

    banner("5. TokenRhythm: deepseek-v4-flash-0731 (对象 tool_choice 转为字符串 auto)")
    test_model("deepseek-v4-flash-0731", "请帮我计算 1+1", tool_choice={"type": "function", "function": {"name": "calculate"}})

    banner("6. 流式 SSE 验证: step-3.7-flash (流式打字机输出)")
    test_model("step-3.7-flash", "讲一个50字以内的小笑话", stream=True)
