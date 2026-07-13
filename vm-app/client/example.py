#!/usr/bin/env python3
"""
OCRProxy 客户端使用示例
========================

本示例演示如何通过 proxy_client 模块连接到代理服务。

前提条件:
  - Python 3.10+ 且 SSL 库支持 TLS 1.3
  - 或使用 proxy_client.py --setup 安装支持 TLS 1.3 的 Python

安装依赖:
  pip install openai

运行:
  python3 example.py
"""
import sys
import os

# 将当前目录加入 path（如果 proxy_client.py 不在标准位置）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from proxy_client import create_client, supports_tls13, get_ssl_info

# ============================================================
# 配置
# ============================================================
BASE_URL = "https://a.jjb0888.cn:8449/v1"
API_KEY = "your-api-key-here"  # 替换为你的 API Key


def main():
    # 检查环境
    info = get_ssl_info()
    print(f"Python: {info['python_version']}, SSL: {info['ssl_version']}")
    if not info["tls13_supported"]:
        print(f"⚠️  当前环境不支持 TLS 1.3: {info['tls13_error']}")
        print("   运行 'python3 proxy_client.py --setup' 安装支持 TLS 1.3 的 Python")
        return

    # 创建客户端
    client = create_client(base_url=BASE_URL, api_key=API_KEY)

    # 1. 列出模型
    print("\n--- 模型列表 ---")
    models = client.models.list()
    for m in models.data:
        print(f"  {m.id} ({m.model_type})")

    # 2. 普通对话
    print("\n--- 普通对话 ---")
    resp = client.chat.completions.create(
        model="chat",
        messages=[{"role": "user", "content": "你好，1+1等于几？"}],
        max_tokens=100,
    )
    print(f"  回答: {resp.choices[0].message.content}")

    # 3. 流式对话
    print("\n--- 流式对话 ---")
    print("  ", end="", flush=True)
    stream = client.chat.completions.create(
        model="chat",
        messages=[{"role": "user", "content": "讲一个笑话"}],
        stream=True,
        max_tokens=200,
    )
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            print(chunk.choices[0].delta.content, end="", flush=True)
    print()

    # 4. 工具调用
    print("\n--- 工具调用 ---")
    resp = client.chat.completions.create(
        model="chat",
        messages=[{"role": "user", "content": "北京今天天气怎么样？"}],
        tools=[{
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "获取指定城市的天气",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "city": {"type": "string", "description": "城市名"},
                    },
                    "required": ["city"],
                },
            },
        }],
        tool_choice="auto",
    )
    msg = resp.choices[0].message
    if msg.tool_calls:
        for tc in msg.tool_calls:
            print(f"  工具: {tc.function.name}({tc.function.arguments})")
    else:
        print(f"  回答: {msg.content}")

    # 5. Embedding
    print("\n--- Embedding ---")
    emb = client.embeddings.create(
        model="embedding",
        input="这是一段测试文本",
    )
    print(f"  维度: {len(emb.data[0].embedding)}")

    print("\n✅ 全部测试通过!")


if __name__ == "__main__":
    main()
