#!/usr/bin/env python3
"""
brush_flash_lite_points.py
商汤 SenseNova 6.8 Flash-Lite 专属积分自动消耗与返赠脚本
在 2026-08-31 05:00:00 CST 自动平稳停止。
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

# 截止时间：明天早上 05:00:00
STOP_HOUR = 5
STOP_MINUTE = 0

stats = {
    "start_time": time.time(),
    "total_requests": 0,
    "successful_requests": 0,
    "failed_requests": 0,
    "total_prompt_tokens": 0,
    "total_completion_tokens": 0,
    "total_tokens": 0,
    "by_key": {
        "自己": {"requests": 0, "tokens": 0, "429_count": 0},
        "自己2": {"requests": 0, "tokens": 0, "429_count": 0},
    }
}

PROMPTS = [
    "请详细撰写一篇关于人工智能大模型架构演进的万字综述论文提纲，包含从Transformer、MoE混合专家、长上下文自注意力机制优化、到多模态跨模态对齐的全部技术细节，并给出各模块的数学公式推导与代码伪代码实现。",
    "请对分布式存储系统（如Ceph、HDFS、MinIO）的高可用、CAP定理权衡、一致性协议（Raft/Paxos）、数据分片与纠删码（Erasure Coding）进行极其详细的技术对比分析与实战架构设计说明。",
    "请深入分析现代操作系统内存管理机制，包含虚拟内存映射、分页与分段、页表遍历机制、TLB缓存、缺页异常处理流程、以及Linux内核中伙伴系统（Buddy System）与SLAB/SLUB分配器的核心算法推导。",
    "请详细探讨量子计算与后量子密码学（PQC），涵盖格密码（Lattice-based Cryptography）、基于哈希的签名方案、多变量密码学的数学原理，以及其对现代RSA/ECC加密算法的替代迁移路线。",
    "请设计一套高并发高可用的实时流计算引擎架构（类似Flink/Spark Streaming），详细阐述其端到端精确一次语义（Exactly-Once）、分布式状态快照（Chandy-Lamport）、反压机制（Backpressure）与水位线（Watermark）推进算法。"
]

def get_stop_timestamp():
    now = datetime.datetime.now()
    if now.hour < STOP_HOUR or (now.hour == STOP_HOUR and now.minute < STOP_MINUTE):
        stop_dt = now.replace(hour=STOP_HOUR, minute=STOP_MINUTE, second=0, microsecond=0)
    else:
        tomorrow = now + datetime.timedelta(days=1)
        stop_dt = tomorrow.replace(hour=STOP_HOUR, minute=STOP_MINUTE, second=0, microsecond=0)
    return stop_dt.timestamp(), stop_dt

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
        with urllib.request.urlopen(req, timeout=40) as resp:
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
    p_idx = worker_id % len(PROMPTS)

    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] 启动 Worker [{label} #{worker_id}]", flush=True)

    while time.time() < stop_ts:
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
            print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] [{label} #{worker_id}] ✅ 成功消耗 {t_tok} Tokens (输入:{p_tok}, 输出:{c_tok}, 耗时:{res['elapsed']:.2f}s) | 累计已刷: {stats['total_tokens']:,}", flush=True)
            await asyncio.sleep(1.5)
        else:
            stats["failed_requests"] += 1
            status = res["status"]
            if status == 429:
                stats["by_key"][label]["429_count"] += 1
                print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] [{label} #{worker_id}] ⚠️ 触发 429 频控，自动休眠 8 秒...", flush=True)
                await asyncio.sleep(8.0)
            else:
                print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] [{label} #{worker_id}] ❌ 请求异常 (HTTP {status}): {res.get('error', '')[:80]}，休眠 5 秒...", flush=True)
                await asyncio.sleep(5.0)

    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Worker [{label} #{worker_id}] 已到达 05:00 停止时间，平稳退出。", flush=True)

async def progress_reporter(stop_ts: float, stop_dt: datetime.datetime):
    while time.time() < stop_ts:
        await asyncio.sleep(60)
        now = time.time()
        elapsed_min = (now - stats["start_time"]) / 60
        rem_sec = max(0, stop_ts - now)
        rem_hours = rem_sec / 3600
        tps = stats["total_tokens"] / max(1, (now - stats["start_time"]))

        print("\n" + "="*70, flush=True)
        print(f"  📊 Flash-Lite 刷积分进度汇报 - {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", flush=True)
        print(f"  已运行: {elapsed_min:.1f} 分钟 | 剩余运行时间: {rem_hours:.2f} 小时 (预计停止: {stop_dt.strftime('%H:%M:%S')})", flush=True)
        print(f"  总成功请求: {stats['successful_requests']}/{stats['total_requests']} (失败: {stats['failed_requests']})", flush=True)
        print(f"  🔥 累计已消耗 Tokens (返赠通用积分): {stats['total_tokens']:,} Tokens (平均吞吐: {tps:.1f} Tokens/s)", flush=True)
        for l, k_stat in stats["by_key"].items():
            print(f"    - [{l}]: 成功请求 {k_stat['requests']} 次 | 消耗 {k_stat['tokens']:,} Tokens | 429避让 {k_stat['429_count']} 次", flush=True)
        print("="*70 + "\n", flush=True)

async def main():
    stop_ts, stop_dt = get_stop_timestamp()
    duration_hours = (stop_ts - time.time()) / 3600
    print(f"==================================================================", flush=True)
    print(f"  商汤 6.8 Flash-Lite 夜间积分消耗返赠任务已启动", flush=True)
    print(f"  当前时间: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", flush=True)
    print(f"  计划停止时间: {stop_dt.strftime('%Y-%m-%d %H:%M:%S')} (共运行 {duration_hours:.2f} 小时)", flush=True)
    print(f"  刷取账号: 自己 ({KEYS[0]['key'][:8]}...) + 自己2 ({KEYS[1]['key'][:8]}...) (共4个安全Worker)", flush=True)
    print(f"==================================================================\n", flush=True)

    tasks = []
    for key_info in KEYS:
        for w_id in range(1, 3):
            tasks.append(asyncio.create_task(worker(key_info, w_id, stop_ts)))

    tasks.append(asyncio.create_task(progress_reporter(stop_ts, stop_dt)))

    await asyncio.gather(*tasks)

    print("\n" + "#"*70, flush=True)
    print(f"  🎉 刷积分任务于 {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} 全部圆满完成！", flush=True)
    print(f"  总消耗 Tokens: {stats['total_tokens']:,}", flush=True)
    print(f"  预估返赠通用积分: {stats['total_tokens']:,}", flush=True)
    print("#"*70 + "\n", flush=True)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n收到退出指令，平稳停止。", flush=True)
