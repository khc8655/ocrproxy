import urllib.request
import json
import time

PROXY_KEY = "3q0xqZ7bes6lDUgltZg8uoj6LwXzMpcpwpIQ9wZh"
BASE_URL = "https://api.khc6.cn"

def banner(title):
    print("\n" + "=" * 65)
    print(f"  {title}")
    print("=" * 65)

def test_model(model_name, prompt, reasoning_effort=None, tool_choice=None):
    url = f"{BASE_URL}/v1/chat/completions"
    payload = {
        "model": model_name,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "max_tokens": 150
    }
    if reasoning_effort is not None:
        payload["reasoning_effort"] = reasoning_effort
    if tool_choice is not None:
        payload["tool_choice"] = tool_choice
        payload["tools"] = [{
            "type": "function",
            "function": {
                "name": "calculate",
                "description": "计算器函数",
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
        with urllib.request.urlopen(req, timeout=25) as resp:
            elapsed = time.time() - start
            body = json.loads(resp.read().decode("utf-8"))
            headers = dict(resp.headers)
            msg = body.get("choices", [{}])[0].get("message", {})
            content = msg.get("content") or msg.get("reasoning_content") or msg.get("reasoning") or ""
            route = headers.get("x-proxy-route") or headers.get("x-edgeone-route-trace") or "direct"
            print(f"✅ [{model_name}] (耗时: {elapsed:.2f}s | 状态: {resp.status})")
            print(f"   - 链路轨迹: {route}")
            print(f"   - 消息回复: {content.strip()[:100]}")
            if msg.get("tool_calls"):
                print(f"   - 工具调用: {msg['tool_calls']}")
            print()
    except Exception as e:
        print(f"❌ [{model_name}] 异常: {e}\n")

if __name__ == "__main__":
    banner("1. 商汤轻量多模态: sensenova-6.8-flash-lite (带对象工具调用测试)")
    test_model("sensenova-6.8-flash-lite", "请用计算器算一下 123 * 456", tool_choice={"type": "function", "function": {"name": "calculate"}})

    banner("2. 阶跃星辰: step-3.7-flash (测试 reasoning_effort=none 自动降级与格式注入)")
    test_model("step-3.7-flash", "请简述什么是人工智能？", reasoning_effort="none")

    banner("3. Agnes AI: agnes-2.5-flash (测试 reasoning_effort=high 映射为 enable_thinking)")
    test_model("agnes-2.5-flash", "太阳从哪边升起？", reasoning_effort="high")

    banner("4. 商汤旗舰模型: glm-5.2 (1M 长上下文推理)")
    test_model("glm-5.2", "请写一句简短的名人名言。")

    banner("5. 商汤深度思考: deepseek-v4-flash (1M 上下文思考模型)")
    test_model("deepseek-v4-flash", "量子力学的核心原理是什么？简要回答。")
