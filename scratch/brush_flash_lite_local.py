#!/usr/bin/env python3
"""
brush_flash_lite_local.py
商汤 SenseNova 6.8 Flash-Lite 本机 2 小时定时积分消耗脚本
双 Key 并发运行，持续 7200 秒（2 小时），到时自动平稳退出。
"""

import asyncio
import json
import time
import datetime
import urllib.request
import urllib.error
import os
import sys

KEYS = [
    {"label": "自己", "key": "sk-p15esxSogPBxZLygS5BREh8n5OTNdgtd"},
    {"label": "自己2", "key": "sk-Qy9fTmxYMLnVhuRHdYRqK8OziPpf8mIL"}
]

UPSTREAM_URL = "https://token.sensenova.cn/v1/chat/completions"
MODEL = "sensenova-6.8-flash-lite"
DURATION_SECONDS = 2 * 3600  # 2 小时

stats = {
    "start_time": time.time(),
    "total_requests": 0,
    "successful_requests": 0,
    "failed_requests": 0,
    "total_prompt_tokens": 0,
    "total_completion_tokens": 0,
    "total_tokens": 0,
    "by_key": {
        "自己": {"requests": 0, "tokens": 0, "429_count": 0, "errors": 0},
        "自己2": {"requests": 0, "tokens": 0, "429_count": 0, "errors": 0},
    }
}

PROMPTS = [
    "请详细撰写一篇关于现代人工智能大模型架构演进的万字综述，深入探讨Transformer注意力机制演进（Multi-Head, FlashAttention, MQA/GQA）、MoE混合专家系统路由算法、长上下文扩展技术（RoPE, YaRN, ALiBi）及多模态跨模态对齐损失函数设计，并给出详细的数学推导与代码逻辑。",
    "请深入分析现代分布式操作系统内核与高并发存储引擎，对比Raft/Paxos共识算法在工业界落地差异、LSM-Tree与B+树在读写放大上的数学建模分析、以及Linux内核eBPF技术在网络可观测性与性能调优中的底层运行原理。",
    "请详尽探讨后量子密码学（PQC）与全同态加密（FHE），从格密码学（LWE/RLWE问题）、基于多变量多项式密码体制、到BGV/CKKS同态加密方案的密文乘法自举（Bootstrapping）原理进行系统级理论阐述与实际应用场景推导。",
    "请系统性设计一套全球分布式微服务链路调度与流量治理平台，详细剖析分布式跟踪（OpenTelemetry/W3C Trace Context）、自适应熔断限流算法（令牌桶/漏桶/滑动窗口BBR算法）、以及跨数据中心多活容灾切换策略。"
]

def make_request_sync(api_key: str, prompt: str):
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "You are an expert computer scientist and technical writer. Provide extremely deep, exhaustive, and detailed analyses."},
            {"role": "user", "content": prompt}
        ],
        "max_tokens": 2048,
        "stream": False
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        UPSTREAM_URL,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            elapsed = time.time() - start
            body = json.loads(resp.read().decode("utf-8"))
            usage = body.get("usage", {})
            return {
                "ok": True,
                "status": resp.status,
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
                "elapsed": elapsed
            }
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="ignore")
        return {"ok": False, "status": e.code, "error": err_body, "elapsed": time.time() - start}
    except Exception as e:
        return {"ok": False, "status": 0, "error": str(e), "elapsed": time.time() - start}

async def worker(key_info: dict, worker_id: int, stop_ts: float):
    label = key_info["label"]
    api_key = key_info["key"]
    p_idx = worker_id

    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] 启动 Worker [{label} #{worker_id}]", flush=True)

    while time.time() < stop_ts:
        try:
            prompt = PROMPTS[p_idx % len(PROMPTS)]
            p_idx += 1

            res = await asyncio.to_thread(make_request_sync, api_key, prompt)
            stats["total_requests"] += 1
            stats["by_key"][label]["requests"] += 1

            if res["ok"]:
                p_tok = res["prompt_tokens"]
                c_tok = res["completion_tokens"]
                t_tok = res["total_tokens"]
                stats["successful_requests"] += 1
                stats["total_prompt_tokens"] += p_tok
                stats["total_completion_tokens"] += c_tok
                stats["total_tokens"] += t_tok
                stats["by_key"][label]["tokens"] += t_tok
                print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] [{label} #{worker_id}] ✅ 成功消耗 {t_tok} Tokens (输入:{p_tok}, 输出:{c_tok}, 耗时:{res['elapsed']:.2f}s) | 累计: {stats['total_tokens']:,}", flush=True)
                await asyncio.sleep(1.0)
            else:
                stats["failed_requests"] += 1
                status = res["status"]
                if status == 429:
                    stats["by_key"][label]["429_count"] += 1
                    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] [{label} #{worker_id}] ⚠️ 触发 429 频控，自动避让休眠 6 秒后重试...", flush=True)
                    await asyncio.sleep(6.0)
                else:
                    stats["by_key"][label]["errors"] += 1
                    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] [{label} #{worker_id}] ❌ 异常 (HTTP {status}): {res.get('error', '')[:60]}，休眠 4 秒...", flush=True)
                    await asyncio.sleep(4.0)
        except Exception as e:
            print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] [{label} #{worker_id}] 异常保护: {e}", flush=True)
            await asyncio.sleep(3.0)

    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Worker [{label} #{worker_id}] 2小时运行完毕，平稳退出。", flush=True)

async def progress_reporter(stop_ts: float, stop_dt: datetime.datetime):
    while time.time() < stop_ts:
        await asyncio.sleep(60)
        now = time.time()
        elapsed_min = (now - stats["start_time"]) / 60
        rem_min = max(0, (stop_ts - now) / 60)
        tps = stats["total_tokens"] / max(1, (now - stats["start_time"]))

        print("\n" + "="*70, flush=True)
        print(f"  📊 Flash-Lite 刷积分实时进度 - {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", flush=True)
        print(f"  已运行: {elapsed_min:.1f} 分钟 | 剩余: {rem_min:.1f} 分钟 (计划结束: {stop_dt.strftime('%H:%M:%S')})")
        print(f"  成功请求: {stats['successful_requests']}/{stats['total_requests']} (失败: {stats['failed_requests']})")
        print(f"  🔥 累计消耗 Tokens (返赠通用积分): {stats['total_tokens']:,} (平均速率: {tps:.1f} Tokens/s)")
        for l, k_stat in stats["by_key"].items():
            print(f"    - [{l}]: 请求 {k_stat['requests']} 次 | 消耗 {k_stat['tokens']:,} Tokens | 429避让 {k_stat['429_count']} 次", flush=True)
        print("="*70 + "\n", flush=True)

async def main():
    start_ts = time.time()
    stop_ts = start_ts + DURATION_SECONDS
    stop_dt = datetime.datetime.fromtimestamp(stop_ts)

    print(f"==================================================================", flush=True)
    print(f"  商汤 6.8 Flash-Lite 本机 2 小时自动刷积分任务已启动", flush=True)
    print(f"  启动时间: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", flush=True)
    print(f"  计划停止时间: {stop_dt.strftime('%Y-%m-%d %H:%M:%S')} (共计 2.00 小时)", flush=True)
    print(f"  并发策略: 双 Key 各分配 2 个弹性 Worker (共 4 协程并发)", flush=True)
    print(f"==================================================================\n", flush=True)

    tasks = []
    for key_info in KEYS:
        for w_id in range(1, 3):
            tasks.append(asyncio.create_task(worker(key_info, w_id, stop_ts)))

    tasks.append(asyncio.create_task(progress_reporter(stop_ts, stop_dt)))

    await asyncio.gather(*tasks)

    print("\n" + "#"*70, flush=True)
    print(f"  🎉 2 小时刷积分任务圆满完成！完成时间: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", flush=True)
    print(f"  总累计消耗 Tokens (返赠通用积分): {stats['total_tokens']:,}", flush=True)
    print("#"*70 + "\n", flush=True)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n收到退出指令，平稳停止。", flush=True)
