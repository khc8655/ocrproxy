import urllib.request
import json
import time

PROXY_KEY = "3q0xqZ7bes6lDUgltZg8uoj6LwXzMpcpwpIQ9wZh"
BASE_URL = "https://api.khc6.cn"

def banner(title):
    print("\n" + "=" * 65)
    print(f"  {title}")
    print("=" * 65)

def round1_config():
    banner("ROUND 1: Schema v2 & 全局设置读写测试")
    url = f"{BASE_URL}/api/config"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {PROXY_KEY}"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        cfg = data.get("config", {})
        settings = cfg.get("settings", {})
        print("✅ 成功读取 EdgeOne 配置:")
        print(f"   - 来源: {data.get('source')} | KV: {data.get('kv_binding')}")
        print(f"   - settings.request_total_budget_sec: {settings.get('request_total_budget_sec', '未注入 (采用默认25)')}")
        print(f"   - settings.max_attempts_per_provider: {settings.get('max_attempts_per_provider', '未注入 (采用默认2)')}")
        print(f"   - settings.fast_failover_provider_down: {settings.get('fast_failover_provider_down', '未注入 (采用默认True)')}")
        print(f"   - 已配置模型数量: {len(cfg.get('agent_models', {}))}")
        print(f"   - 已配置厂商数量: {len(cfg.get('providers', {}))}")

def round2_models():
    banner("ROUND 2: OpenAI 兼容模型列表探测 (/v1/models)")
    url = f"{BASE_URL}/v1/models"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {PROXY_KEY}"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        models = [m["id"] for m in data.get("data", [])]
        print(f"✅ 模型列表探测成功 ({len(models)} 个可用模型):")
        for m in models:
            print(f"   • {m}")

def round3_chat_completions():
    banner("ROUND 3: 全模型非流式生成与链路追踪头测试")
    test_cases = [
        ("deepseek-v4-flash", "你好，请回答：中国的首都是哪里？"),
        ("step-3.7-flash", "你好，请回答：1+1等于几？"),
        ("agnes-2.5-flash", "你好，请回答：水的化学式是什么？"),
    ]
    for model, prompt in test_cases:
        url = f"{BASE_URL}/v1/chat/completions"
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "max_tokens": 150
        }
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
                attempts = headers.get("x-proxy-attempts", "1")
                print(f"✅ [{model}] (耗时: {elapsed:.2f}s | 状态: {resp.status})")
                print(f"   - 链路轨迹: {route} (尝试次数: {attempts})")
                print(f"   - 问答回复: {content.strip()[:80]}")
                print()
        except Exception as e:
            print(f"❌ [{model}] 异常: {e}\n")

def round4_streaming():
    banner("ROUND 4: 流式打字机 SSE 推流与 TTFB 首包测试")
    url = f"{BASE_URL}/v1/chat/completions"
    payload = {
        "model": "deepseek-v4-flash",
        "messages": [{"role": "user", "content": "请数数：从1数到5"}],
        "stream": True,
        "max_tokens": 100
    }
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {PROXY_KEY}", "Content-Type": "application/json"},
        data=json.dumps(payload).encode("utf-8")
    )
    start = time.time()
    first_token_time = None
    chunks_count = 0
    full_text = ""
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            for line in resp:
                line_str = line.decode("utf-8").strip()
                if line_str.startswith("data: ") and line_str != "data: [DONE]":
                    if first_token_time is None:
                        first_token_time = time.time() - start
                    chunks_count += 1
                    try:
                        chunk = json.loads(line_str[6:])
                        delta = chunk["choices"][0]["delta"]
                        text = delta.get("content") or delta.get("reasoning") or ""
                        full_text += text
                    except Exception:
                        pass
        total_time = time.time() - start
        print(f"✅ 流式 SSE 测试成功!")
        print(f"   - TTFB 首包延迟: {first_token_time:.2f}s")
        print(f"   - 传输总耗时: {total_time:.2f}s (共收到 {chunks_count} 个 SSE 数据包)")
        print(f"   - 流式内容: {full_text.strip()[:100]}")
    except Exception as e:
        print(f"❌ 流式测试异常: {e}")

if __name__ == "__main__":
    time.sleep(3)
    round1_config()
    round2_models()
    round3_chat_completions()
    round4_streaming()
    banner("🎉 全部多轮测试执行完毕")
