#!/usr/bin/env python3
"""管理端探活/校验的 SSRF 守卫：与运行时路由保持一致，同时永远挡住元数据地址。"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vm-app"))
from app.admin_routes import _admin_upstream_block_reason  # noqa: E402

CFG = {"providers": {
    "local-vllm": {"base_url": "http://127.0.0.1:9001/v1", "keys": {"a": "sk"}},
    "lan": {"base_url": "https://10.0.0.8:8443", "keys": {"b": {"key": "sk", "base_url": "http://192.168.1.20:11434/v1"}}},
}}

CASES = [
    ("https://api.openai.com/v1/models", {}, True, "公网 HTTPS 永远允许"),
    ("http://127.0.0.1:9001/v1/models", CFG, True, "已保存的本地 http 供应商允许探活"),
    ("http://127.0.0.1:9002/v1/models", CFG, False, "同主机不同端口 (未保存) 拒绝"),
    ("https://10.0.0.8:8443/v1/models", CFG, True, "已保存的内网 https 供应商允许"),
    ("http://192.168.1.20:11434/v1/chat/completions", CFG, True, "Key 级 base_url 也视为已保存"),
    ("http://127.0.0.1:9001/v1/models", {}, False, "未保存的本地地址拒绝"),
    ("http://169.254.169.254/latest/meta-data", {"providers": {"x": {"base_url": "http://169.254.169.254"}}}, False, "云元数据即使被保存也拒绝"),
    ("http://metadata.google.internal/computeMetadata/v1", {}, False, "GCP 元数据主机名拒绝"),
    ("file:///etc/passwd", {}, False, "非 http(s) 协议拒绝"),
]


async def main():
    fails = 0
    for url, cfg, allowed, name in CASES:
        reason = await _admin_upstream_block_reason(url, cfg)
        ok = (reason is None) == allowed
        fails += 0 if ok else 1
        print(("  PASS  " if ok else "  FAIL  ") + name + ("" if ok else f" -> {reason!r}"))
    print(f"\n{'ALL PASSED' if not fails else f'{fails} FAILED'}")
    return fails


sys.exit(1 if asyncio.run(main()) else 0)
