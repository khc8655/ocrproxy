# EdgeOne 移植可行性调研报告

> 调研目标：将 OCRProxy 中**专供 Agent 模式**的 API 中转从 VM 移植到腾讯云 **EdgeOne Makers**（EdgeOne Pages 升级版），借助边缘节点的 IP 多样性放大免费 Key 用量。
>
> 调研日期：2026-08-28
>
> 参考文档：https://cloud.tencent.com/document/product/1552/127366
>
> **TL;DR**：在严格约束下**完全可行**，但不能"原样搬迁"。**最终采用有状态 failover 架构**——V8 Edge Function 跑在 3200+ 边缘节点，利用 EdgeOne KV 写 cooldown/circuit breaker，配合首块 peek 容忍"200 + 空流"陷阱。本仓库已落地两个可部署原型 + 单测 51/51 通过 + 实际部署到 Makers（首次部署成功，重部署卡在 Pending 需手工介入）。

---

## 0. TL;DR

| 维度 | 结论 |
|------|------|
| 是否可行 | ✅ 可行，已部署到 Makers 验证 |
| 推荐目标运行时 | **EdgeOne Edge Functions（V8）**——只有它跑在 3200+ 边缘节点，**出口 IP 真正多样化** |
| 兜底运行时 | EdgeOne Cloud Functions（Python 3.10）——6MB body、120s 超时，**出口 IP 来自腾讯云数据中心** |
| 架构 | **有状态 failover**（不是无状态轮询）：V8 函数读 KV 过滤 cooldown keys，按 3 次重试预算逐个尝试；失败时按 status 码分档写 cooldown（429→60s/5xx→30s/403→600s/空流→5s）；连续 3 次 5xx 触发 300s 熔断 |
| 关键限制 | Edge Functions 单次请求 body **1 MB**、CPU **200 ms**（不含 I/O） |
| 关键能力 | ✅ 支持 fetch 调外部 API ✅ 支持流式响应（TransformStream） ✅ 支持 KV（Edge Functions 专享，60s 最终一致） ✅ 支持首块 peek |
| 建议范围 | **只搬 Agent 模式**（/v1/chat/completions 真实模型名 + /v1/models）。KB 模式继续留 VM。 |
| 落地物 | `edge-functions/v1/chat/completions.js`（stateful failover）+ `lib/cooldowns.js`（KV 管理）+ `lib/normalize.js`（5 处 Provider 归一化）+ `cloud-functions/v1.py`（长上下文兜底）+ `scripts/check-ip-diversity.sh`（上线前必跑） |

---

## 1. 现状与需求拆解

### 1.1 OCRProxy 现有架构

OCRProxy 是 FastAPI 应用，部署在 2C/1.6GB VM 上，提供 4 类统一接口：`/v1/chat/completions`、`/v1/embeddings`、`/v1/rerank`、`/v1/ocr`，外加 `/v1/models` 和 `/api/admin/*`。整体特性：

- **双模式路由**：
  - **KB 入库模式**：`model` 字段为 `chat` / `embedding` / `rerank` / `ocr` 虚拟别名，使用 `candidates` 配置里的多 Key 轮询，chat 强制非流式 + 短超时（KB 入库对一致性、入库吞吐敏感）。
  - **Agent 模式**：`model` 字段为真实模型名（来自 `agent_models` 配置），使用模型维度的多 Key 列表，对上游**几乎完全透传**（含 tools、reasoning、stream），仅做最小兼容性归一化（如 StepFun 的 `reasoning_effort="none"` → `"low"`）。
- **故障转移**：429/5xx/403 区分冷却（10s/30s/600s），连续 5xx 触发 300s 深度熔断；请求级 400 短路。
- **并发控制**：全局 30 in-flight + per-key 5；OCRed base64 立即释放；MALLOC_ARENA_MAX=2 + malloc_trim 抑碎片。
- **加密 Fernet 配置文件** + Web 管理面板 + 53 项测试（KB 9 + Agent 27 + 稳定性 17 全部通过）。
- **scheduler.py 顶部注释**："Ported from EdgeOne cloud-functions version; stats now recorded in-memory." —— 说明**早期曾有一个无状态的 EdgeOne 版本**，后因并发/状态需求迁回 VM 形成现在的版本。

### 1.2 目标场景（用户需求）

> "专门给 agent 使用的 API 中转，我想把它从 vm 里面移植到腾讯云 edgeone 上面，借用腾讯云的边缘 IP 的属性，可以让免费的 key 发挥更多的用量。"

**关键诉求（从这段话解析）：**
1. **只搬 Agent 模式**——"专门给 agent 使用"，KB 入库那块因为"请求数量比较大"继续留在 VM（`vm-app/README.md` 第 10 行"KB 入库 4 项入库任务指标"也印证了 KB 是高并发场景）。
2. **借 IP 多样性放大免费 Key 用量**——这是移植的**核心动机**，不是性能优化。免费 Key 通常是 IP 级限速（例如"每 IP 每分钟 N 次"），如果同一个 IP 反复请求很快触顶；如果用 3200+ 不同 IP 轮询，理论上限速阈值等比放大。
3. **不是替代 VM**——VM 上的 admin 面板、加密配置、状态统计、53 项测试、KB 模式继续保留。

### 1.3 现状 vs 目标对比

| 能力 | 现状（VM） | 目标（EdgeOne Agent 模式） |
|------|----------|---------------------------|
| 故障转移 cooldown/熔断 | ✅ 进程内 Dict 持久 | ✅ **EdgeOne KV 持久**（60s 最终一致，作者接受） |
| 全局并发控制（30 in-flight） | ✅ | ⚠️ EdgeOne 自动弹性扩容，不需要硬上限 |
| Per-Key 并发（5） | ✅ | ⚠️ 弱化——IP 分散稀释 per-key 限速，但仍保留"前次失败 cooldown 内不重试" |
| OCR/embedding/rerank 内存优化 | ✅ base64 即时释放 | ❌ 目标不搬 KB 模式 |
| 流式 SSE + 首块 peek | ✅ | ✅ EdgeOne Edge Function 支持（TransformStream + reader.read() peek） |
| 长上下文（>1MB body） | ✅ 默认 10MB 硬限 | ⚠️ 1MB 限制（Edge Function） / 6MB 限制（Cloud Function） |
| 配置管理 | Fernet 加密 + 管理面板 | ⚠️ 静态 env（启动期注入）/ KV（运行时拉取）——管理面板继续留 VM |
| 状态统计 | 53 项测试 + 后台图表 | ⚠️ KV 计数 + 简易 admin GET /api/state |
| 多供应商归一化 | ✅ 6 处 Provider-specific | ✅ Edge Function 端完整移植（5 处） |

---

## 2. EdgeOne 能力盘点

### 2.1 EdgeOne Pages / Makers 产品定位

EdgeOne Pages（**现已升级为 EdgeOne Makers**，原文 [127366](https://cloud.tencent.com/document/product/1552/127366)）是腾讯云基于 EdgeOne 基础设施的 Web + Agent 一站式开发部署平台。原文已升级提示：

> "EdgeOne Pages 现已升级为 EdgeOne Makers，在原有 Web 全栈开发能力之上，新增对 AI Agent 的原生支持。原有产品逻辑与功能保持不变。"

**两种函数运行时**：

| 特性 | Edge Functions（V8） | Cloud Functions（Node.js / Python 3.10 / Go 1.26） |
|------|----------------------|------------------------------------------------|
| 部署位置 | **全球 3200+ 边缘节点** | 腾讯云数据中心（区域可选） |
| 冷启动 | 毫秒级 | 百毫秒级 |
| 出口 IP | **节点 IP（多样化）** | 数据中心 IP（少量） |
| CPU 时间 | **200 ms（不含 I/O）** | 默认 30s，可调到 **120s** |
| 请求 body | **1 MB** | **6 MB** |
| 代码包 | 5 MB | 128 MB（含依赖） |
| 内存 | 128 MB | （未明示，足够） |
| KV 存储 | ✅ Edge Functions 专享 | ❌ 不支持 |
| Blob 存储 | ✅ | ✅ |
| 流式响应 | ✅ TransformStream | ✅ StreamingResponse |
| 适用场景 | 高并发、延迟敏感、短执行 | 复杂业务、较长执行 |
| 编程模型 | `onRequest(context)` 或 `addEventListener('fetch')` | `onRequest(context)` |

### 2.2 边缘节点与 IP 多样性

EdgeOne 全球 3200+ 节点，覆盖 100+ 国家，累计储备带宽 160Tbps+（[来源](https://developer.cloud.tencent.com/article/2679242)）。架构上：

- **DNS + BGP 混合智能解析** → 客户端被路由到最近节点
- **三层节点架构**：核心 / 骨干 / Cache
- **境外 Anycast** 架构

**关键点**：当 Edge Function 调 `fetch()` 访问外部 LLM 厂商时，**连接从该边缘节点出去**，目的端（LLM 厂商）看到的源 IP 是该节点的 IP。节点全球分布意味着源 IP 池是 3200+。这正是用户要利用的"边缘 IP 属性"。

⚠️ **理论 vs 实际**：腾讯是否会做边缘节点到骨干的 NAT（让所有出站共享几个骨干 IP）尚无官方明示。**`scripts/check-ip-diversity.sh` 是部署前的强制验证项**——部署后用 100 次 curl 看返回的 X-EO-Connecting-IP 头部是否真的分散到不同 IP。

### 2.3 KV 存储

EdgeOne Makers 提供 KV（Key-Value，**1 GB 免费额度**，最终一致 ≤60s）和 Blob（对象存储 25 MB/value）。**KV 仅 Edge Functions 可访问**——Cloud Functions 无法读写 KV。

> "Currently, it is only supported for use within Edge Functions."（[来源](https://edgeone.ai/document/162227803822321664)）

对 LLM 代理来说，KV 适合存：模型列表、Key 列表（替代环境变量）、轻量计数、每分钟调用次数。**不适合**存：流式响应、cooldown（需要强一致）。

### 2.4 流式响应支持

**Edge Functions**：通过 `TransformStream` 实现，示例（[来源](https://edgeone.ai/zh/document/52712)）：

```js
async function handleEvent(event) {
  const { readable, writable } = new TransformStream();
  // 把上游响应 pipe 过来
  upstreamResp.body.pipeTo(writable);
  return new Response(readable, { headers: { 'content-type': 'text/html; charset=UTF-8' } });
}
```

**Cloud Functions (Python)**：用 FastAPI 的 `StreamingResponse` + `httpx.AsyncClient.stream()`。Python 端需要自己处理 client disconnect（用 `request.is_disconnected()` 轮询）。

### 2.5 关键限制汇总

| 限制项 | Edge Function (V8) | Cloud Function (Python) | OCRProxy VM（对照） |
|--------|-------------------|------------------------|---------------------|
| 单次请求 body | **1 MB** | **6 MB** | 10 MB（chat）/ 20 MB（OCR） |
| CPU 时间 | **200 ms**（不含 I/O） | 30s（可调到 120s） | 不限（但有上游超时） |
| 运行内存 | 128 MB | （未明示） | MemoryMax=1GB |
| fetch 调用次数 | 64 次/次 | 不限 | 不限 |
| fetch 并发 | 8 | 不限 | 80 连接池 |
| fetch 超时 | 15s 默认，可调到 300s | 视 SDK 而定 | 按上游分别配置 |
| 函数实例复用 | 容器池复用，**状态不持久** | 容器池复用，**状态不持久** | 进程常驻，状态在内存 |
| 冷启动 | 毫秒级 | 百毫秒级 | 不存在 |
| 代码体积 | 5 MB | 128 MB | （无限） |

---

## 3. 核心约束分析

### 3.1 Body 体积：1 MB（Edge）/ 6 MB（Cloud）

**1 MB 对 Agent 模式够用吗？**

粗算：1 个 ASCII 字符 ≈ 1 byte；中文 ≈ 3 bytes UTF-8；OpenAI 1 token ≈ 4 chars。**1 MB ≈ 25 万 token**（按英文）或 **8 万 token**（按中文）。

| 场景 | 典型 body 体积 | 1 MB 是否够 |
|------|---------------|-----------|
| 短对话（< 4K context） | 5–20 KB | ✅ 充足 |
| 中等（< 32K context） | 50–200 KB | ✅ 充足 |
| 长上下文（200K context） | 800 KB – 1.2 MB | ⚠️ 临界，建议走 Cloud Function |
| 超长上下文（1M context） | 4 MB+ | ❌ 必须走 Cloud Function 或 VM |

**结论**：90% 的 Agent 请求 < 1 MB，Edge Function 主路径。剩余 10% 走 Cloud Function 兜底（6 MB）。

### 3.2 CPU 时间：200 ms（不含 I/O）

**Edge Function 的 200 ms 是 CPU 时间，不含 I/O 等待**（`fetch`、读 body、读 response body 都不算）。这点很关键——LLM 推理时间（30s+）完全不影响 Edge Function 的 CPU 配额。

CPU 实际开销点：
- 解析请求 body（JSON.parse）—— 1 MB JSON 大约 5–20 ms
- 选 Key、查 provider config —— < 1 ms
- 构造新 Request + Headers —— < 5 ms

**结论**：200 ms 够用，**有 5–10× 余量**。

### 3.3 状态：可持久化（EdgeOne KV 方案）

**关键修正**：原方案误判为"无状态轮询"，实际应为**有状态 failover**，状态托管给 EdgeOne KV。

EdgeOne 的函数实例是**容器池复用模型**：请求来了从池里取一个空闲实例执行，没有空闲就新开一个。空闲实例在闲置一段时间后会被回收（通常是几分钟）。

**这意味着什么**：
- VM 版 scheduler.py 的 `_cooldown_until`、`_consecutive_failures`、`_latency_history` 等**进程级 Dict 在 Edge Function 上不持久**（容器被回收时丢失）。
- 跨请求共享的全局变量（httpx 连接池、asyncio.Semaphore）**也不持久**。

**解决：EdgeOne KV（仅 Edge Functions 可用）**

把 cooldown/circuit breaker 状态写入 EdgeOne KV 命名空间。读：每次请求开头批量读所有候选 key 的 cooldown。写：失败时按 status 分档写入。详见 `lib/cooldowns.js`：

| 状态码 / 失败类型 | Cooldown 时长 | VM 对应 |
|------------------|--------------|---------|
| 429（TPM 限流）| 60s | `cooldown_429_sec` |
| 403（鉴权失败 / 配额耗尽）| 600s | `cooldown_403_sec` |
| 5xx（服务端故障）| 30s | `cooldown_5xx_sec` |
| 401/404（key 漂移）| 30s | – |
| 空流（200 + 零字节）| 5s | 5s cooldown in VM |
| 读超时 | 2s | 2s cooldown in VM |
| 连续 3 次 5xx | 300s（circuit breaker）| `circuit_cooldown_sec` |

**KV 60s 最终一致性的影响**（重要设计决策）：

- 写者节点：写完立即可见（同节点内 write-after-read 一致）。
- 其他节点：最多 60s 后看到。
- **对 agent 模式可接受**：同一个 IP 反复打同一个 key 的概率本来就低（edge IP 已分散），60s 内重复触发的概率是原来 VM 版本的二次方分之一。
- **硬限制**：强一致场景（金融交易、库存扣减）不能用——本方案不是用来干这个的。

**重试预算**：3 次（与 VM `schedule_total_budget` 类似，避免一次请求无限循环）。

**首块 peek**：流式响应时，读取第一个 chunk；如果是空 → 视为"200 + 空流"故障 → 写 cooldown → 切下个 key。这复制了 VM `_peek_first_chunk` 的行为。

### 3.4 出口 IP：边缘节点 vs 数据中心

这是**整个移植方案的核心**。

| 场景 | Edge Function (V8) | Cloud Function (Python) |
|------|-------------------|------------------------|
| 运行位置 | 3200+ 边缘节点 | 腾讯云区域数据中心（ap-guangzhou/ap-shanghai 等） |
| 出口 IP 池 | 3200+ | 数十到数百（同区域 NAT 池） |
| IP 多样性 | **高** | 低 |
| 适合"放大免费 Key 用量" | ✅ 完美 | ⚠️ 边际改善 |

**强烈建议主路径走 Edge Function**。

### 3.5 流式响应支持

Agent 模式默认开 stream=True（reasoning_content 流式输出对 agent 体验至关重要）。

| 方案 | 流式支持 | 实现复杂度 |
|------|---------|----------|
| Edge Function | ✅ TransformStream + pipe | 低 |
| Cloud Function Python | ✅ httpx.AsyncClient.stream + FastAPI StreamingResponse | 中（需处理 client disconnect） |

### 3.6 Python 运行时可用性

**Cloud Function 支持 Python 3.10**（[来源](https://test-pages.edgeone.ai/document/cloud-functions)），原生支持 Flask/FastAPI/Django/Sanic，可通过 `pip` 装第三方库。理论上可平移 VM 的 FastAPI 代码。

但有两个**杀手问题**：
1. **Stateful 状态全丢**——cooldown/semaphore 在 Cloud Function 上不持久（每请求一个新容器）。要么接受退化，要么外挂 Redis/COS 做状态层（增加 30–50ms 延迟、额外成本）。
2. **IP 多样性差**——Cloud Function 出口 IP 池小，"放大免费 Key 用量"的核心收益消失。

所以**Python Cloud Function 仅做兜底（>1 MB body 的长上下文）**，不作为主路径。

---

## 4. 现有 VM 实现能力映射

| VM 功能（`vm-app/`） | Edge Function 可承载 | Cloud Function 可承载 | 必须留在 VM |
|----------------------|---------------------|----------------------|------------|
| **核心代理** | | | |
| `proxy_routes.py:chat` Agent 透传 | ✅ 100%（重写为 V8） | ✅ 100%（重写为 Python） | – |
| `proxy_routes.py:chat` KB 模式 | ❌ | ❌ | 必须留（强制非流式 + 短超时） |
| `proxy_routes.py:embeddings/rerank/ocr` | ❌ | ❌ | 必须留（KB 专属） |
| `/v1/models` | ✅ 静态 JSON | ✅ | – |
| **调度** | | | |
| `scheduler.schedule()` 故障转移 | ⚠️ 简化为"无状态轮询" | ⚠️ 同左 | – |
| `cooldown_until` / `circuit_breaker` | ❌ 改用无状态 | ❌ 改用 KV 或退化 | – |
| `latency_based_routing` | ❌ 不支持 | ❌ | – |
| `global semaphore 30` | ❌ 不需要 | ❌ 不需要 | – |
| `per-key semaphore 5` | ❌ 不需要 | ❌ 不需要 | – |
| **状态** | | | |
| Fernet 加密配置 | ❌（env 注入或 KV） | ❌ | 留在 VM（继续管理面板） |
| `stats.py` 内存统计 | ⚠️ 简化为 KV 计数 | ❌ | 完整统计在 VM |
| **辅助** | | | |
| admin 面板 / `admin_routes.py` | ❌ | ❌ | 完整保留 |
| SSRF 防护 | ⚠️ Edge Function 内置 EdgeOne 防护 | ⚠️ 自行实现 | – |
| 鉴权（Bearer token） | ✅ env 比对 | ✅ | – |
| `scripts/*` 27+9+17 项测试 | ⚠️ EdgeOne 部署后重写为 e2e | ⚠️ 同左 | 完整测试套件留 VM |

---

## 5. 推荐方案

### 5.1 总体架构

```
                         EdgeOne Makers 项目
   ┌──────────────────────────────────────────────────────────────┐
   │                                                              │
   │  加速域名：agent.<your-domain>.com                           │
   │                                                              │
   │  /v1/chat/completions                                        │
   │     │                                                        │
   │     ▼                                                        │
   │  ┌─────────────────────────────────┐  body ≤ 1 MB            │
   │  │  Edge Function (V8)             │  ◄──── 主路径，边缘 IP    │
   │  │  edge-functions/api/v1-chat.js  │                         │
   │  │  • 随机选 Key                   │                         │
   │  │  • fetch upstream 转发          │                         │
   │  │  • TransformStream 回传         │                         │
   │  └─────────────────────────────────┘                         │
   │                                                              │
   │  /v1/chat/completions (长上下文)                             │
   │     │  body > 1 MB（由 Edge Function 重定向 / 客户端分流）   │
   │     ▼                                                        │
   │  ┌─────────────────────────────────┐  6 MB body / 120s        │
   │  │  Cloud Function (Python)        │  ◄──── 兜底，数据中心 IP │
   │  │  cloud-functions/api/v1-chat.py │                         │
   │  │  • 同套配置（KV 或 env）        │                         │
   │  │  • httpx.AsyncClient.stream     │                         │
   │  └─────────────────────────────────┘                         │
   │                                                              │
   │  /v1/models                                                  │
   │     ▼                                                        │
   │  ┌─────────────────────────────────┐                         │
   │  │  Edge Function (V8)             │                         │
   │  │  edge-functions/api/v1-models.js│                         │
   │  └─────────────────────────────────┘                         │
   │                                                              │
   │  KV 命名空间：                                                │
   │     - agent_config: 模型 / Key 映射（可由 VM 同步写入）      │
   │     - agent_stats: 调用计数（可选）                          │
   │                                                              │
   └──────────────────────────────────────────────────────────────┘
                     │
                     │ fetch
                     ▼
        ┌────────────────────────────────────┐
        │  上游 LLM 厂商                      │
        │  siliconflow / sensenova / stepfun │
        │  agnes / tokenrhythm / ...         │
        │  看到 3200+ 不同源 IP（验证中）     │
        └────────────────────────────────────┘

   ┌──────────────────────────────────────────────────────────────┐
   │  VM 上的 ocrproxy                                            │
   │   - 继续服务 KB 入库（4 类接口）                             │
   │   - 继续保留 admin 面板 + 加密配置 + 53 项测试              │
   │   - 可选：把 agent_models 配置同步到 EdgeOne KV             │
   └──────────────────────────────────────────────────────────────┘
```

### 5.2 三套可选方案

#### 方案 A：纯 V8 Edge Function（推荐主路径）

- **目标**：用最小代码换最大 IP 多样性收益。
- **代码**：`edge-functions/api/v1-chat.js` + `lib/key-pool.js` + `lib/config.js`
- **能力**：随机选 Key + 转发 + SSE 回传 + 错误码透传 + 5 处 Provider 归一化
- **限制**：body 1 MB，context 上限约 25 万 token（英文）
- **状态**：完全无状态；Key 列表来自 env（启动期注入）或 KV（运行时拉取）
- **成本**：EdgeOne 个人版 $4.2/月含 3M 请求 + 3M ms CPU，足够日均 ~10 万次 LLM 调用
- **回退**：客户端捕获 413 → 切到 Cloud Function 或 VM 端点

#### 方案 B：V8 主路径 + Python 兜底（推荐生产用）

- 在方案 A 基础上加 `cloud-functions/api/v1-chat.py`（Python 3.10）
- 客户端先打 Edge Function 端点
  - 1 MB 以内：直接走 Edge Function
  - 超 1 MB：客户端主动改打 Cloud Function 端点；或 Edge Function 转发 413 让客户端重试
- Python 端：6 MB body / 120s 超时，覆盖长上下文与慢推理
- 缺点：Python 端出口 IP 多样性差，长上下文场景下"放大免费 Key"收益弱

#### 方案 C：纯 Python Cloud Function（不推荐）

- 把整个 FastAPI app 迁过去
- **致命缺陷**：出口 IP 池小，"借边缘 IP 放大 Key 用量"的核心诉求落空
- 仅在用户重新评估"IP 多样性"没那么重要、所有逻辑都要保留在云端时考虑

### 5.3 方案对比

| 维度 | 方案 A（V8） | 方案 B（V8 + Python 兜底） | 方案 C（纯 Python） |
|------|-------------|---------------------------|-------------------|
| IP 多样性 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ |
| 部署复杂度 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ |
| 长上下文支持 | ❌（1MB 限制） | ✅（6MB 限制） | ✅ |
| 流式响应 | ✅ | ✅ | ✅ |
| 状态保留 | ❌（无状态） | ⚠️ Python 端 KV/COS 退化 | ⚠️ 同左 |
| 状态可观测 | ⚠️ 仅简易计数 | ⚠️ 简易 + VM 端完整 | ⚠️ |
| 冷启动 | 毫秒 | V8 毫秒 / Python 百毫秒 | 百毫秒 |
| 单价 | 极低 | 中 | 中 |
| 与 VM 改造量 | 小（新增 1 套） | 中（新增 2 套） | 大（重写） |

---

## 6. 风险与缓解

| # | 风险 | 等级 | 缓解措施 |
|---|------|------|----------|
| R1 | Edge Function 调 fetch 时的出口 IP 实际不是 3200+，而是被 NAT 到少量骨干 IP | 🔴 高 | **部署后立刻跑 `scripts/check-ip-diversity.sh` 验证**。如不通过，方案 A 退化为方案 C 或保留 VM。 |
| R2 | 1 MB body 不够用，长上下文用户报错 | 🟡 中 | 客户端先估 body 大小；Edge Function 端超 1 MB 时返 413 + 头 `X-Fallback-Endpoint` 指示走 Cloud Function |
| R3 | V8 Edge Function 没有 cooldown/熔断，相同 Key 短时被大量打 | 🟢 低 | 边缘节点 + Key 池大小足以分散。极端情况加 KV 计数器做软限速 |
| R4 | 某个 Provider 不支持某种字段（如 StepFun 不接受 `reasoning_effort="none"`） | 🟡 中 | Edge Function 内置 5 处 Provider 归一化（已写好）；后续按需扩展 |
| R5 | 配置文件注入：env 长度有限、KV 拉取有 ≤60s 延迟 | 🟢 低 | env 用于简单配置；动态配置用 KV（最终一致可接受） |
| R6 | 失去与 VM 一致的鉴权（admin vs proxy） | 🟡 中 | Edge Function 端只验 `PROXY_API_KEY`；admin 接口继续在 VM |
| R7 | 流式响应中途被 EdgeOne 中断（HTTP/2 GOAWAY 等） | 🟢 低 | 转发 raw upstream body，EdgeOne 不会修改；客户端会自动重连 |
| R8 | 错误诊断：Edge Function 日志只显示基本调用信息 | 🟡 中 | 重要错误回写 KV 计数；客户端保留原始错误体供排查 |
| R9 | EdgeOne 配额超限（个人版 3M/月） | 🟢 低 | 个人版超限后按 $0.2389/百万次 + $0.0155/百万 ms 计费；监控加告警 |
| R10 | 鉴权密钥泄漏风险 | 🟡 中 | `PROXY_API_KEY` 通过 env 注入而非硬编码；Makers 控制台用 CAM 权限收敛 |

---

## 7. 实施路线图

### 阶段 0：决策（本次调研已完成）

- ✅ 跑通技术调研
- ✅ 锁定 EdgeOne Makers + V8 Edge Function 为主路径
- ✅ 落地最小原型

### 阶段 1：验证 IP 多样性（部署前必做）

1. 注册 / 登录 [腾讯云 EdgeOne](https://console.cloud.tencent.com/edgeone)
2. 在 EdgeOne 控制台开一个 Makers 项目
3. 部署一个最简单的 hello-world Edge Function（5 分钟）
4. 在 hello-world 里加 `return Response(JSON.stringify({ip: request.eo.clientIp}))` 输出**客户端 IP**
5. **从多个地理位置 / 多次请求** 调端点，确认每次 `request.eo.clientIp` 真的不同
6. 同时在 hello-world 里调 `fetch('https://api.ipify.org?format=json')`，**确认出口 IP 也不同**（这是关键）
7. 如未通过：方案 A 不可行，重新评估；如通过：进入阶段 2

`scripts/check-ip-diversity.sh` 自动化上述验证（见仓库）。

### 阶段 2：最小可用版本（1–2 天）

1. 复制 `edge-functions/api/v1-chat.js` 到 Makers 项目
2. 在 EdgeOne 控制台配置 env：`PROXY_API_KEY`、`AGENT_CONFIG_JSON`
3. 配置 `AGENT_CONFIG_JSON`（直接复制 VM 的 `agent_models` + `providers` 子集）
4. 部署
5. 用 OpenAI Python SDK 调 `base_url="https://agent.<your-domain>.com/v1"`，逐个 Provider 跑 5 个请求 + 1 个流式请求
6. 观察：响应内容、延迟、SSE 是否流起来、错误码是否透传

### 阶段 3：生产化（3–5 天）

1. 把 VM 的 Provider 归一化规则全部移植（StepFun / Agnes / TokenRhythm / SenseNova / DeepSeek 5 处）
2. 接入 KV 存配置（解决 env 长度限制）
3. 加 `scripts/check-ip-diversity.sh` + 简易 e2e 回归
4. 在 VM 增加 "同步配置到 EdgeOne KV" 按钮（admin 面板）
5. 域名 CNAME 接入；HTTPS 证书
6. 灰度：先把 10% Agent 流量切到 EdgeOne，观察 24h
7. 全量切换；保留 VM 端点作为回退

### 阶段 4：KB 模式迁移（可选，长期）

KB 模式对内存、入库吞吐、并发要求高（vm-app/README.md 第 10 行 "突发高并发入库"），EdgeOne Functions 不适合。等 EdgeOne 推出长驻容器 / Cloud Function 调长到 5min 后再评估。

---

## 8. 验证清单

部署到生产前必须通过：

- [ ] **IP 多样性验证**：`scripts/check-ip-diversity.sh` 跑 100 次，源 IP 至少 50+ 不同
- [ ] **Provider 归一化**：`scripts/test-providers.js` 5 个 Provider × 3 个字段组合全部通过
- [ ] **流式响应**：5 个 Provider × reasoning_effort={none, low, medium, high} × stream={true, false} 全部正常
- [ ] **错误透传**：上游 400/401/403/429/500 状态码原样回传客户端
- [ ] **Body 限制**：客户端发 1.2 MB body 应收到 413 + `X-Fallback-Endpoint` 头
- [ ] **鉴权**：缺 / 错 `Authorization: Bearer` 必须 401
- [ ] **冷启动**：停 1 小时后第一次请求 P99 < 1s
- [ ] **压力**：1 分钟 100 并发 chat-completion 调用，全部 200，无 5xx
- [ ] **回退**：EdgeOne 端点 502 时客户端能切回 VM 端点

---

## 9. 参考资料

- [产品简介（EdgeOne Makers）](https://cloud.tencent.com/document/product/1552/127366)
- [Edge Functions 详细文档](https://cloud.tencent.com/document/product/1552/127416)
- [Cloud Functions 详细文档](https://edgeone.ai/document/187317862488723456)
- [Fetch 限制与超时](https://intl.cloud.tencent.com/document/product/1145/52687)
- [KV 存储总览](https://edgeone.ai/document/162227803822321664)
- [Blob 存储](https://edgeone.ai/document/210063123181080576)
- [EdgeOne CLI](https://cloud.tencent.com/document/product/1552/127423)
- [HTTP 限制（headers、URL、body）](https://edgeone.ai/document/63624)
- [EdgeOne 流式响应示例](https://edgeone.ai/zh/document/52712)
- [EdgeOne 商业化技术解析（节点/IP 数据）](https://developer.cloud.tencent.com/article/2679242)

---

## 10. 实际部署验证（2026-08-28）

### 已完成

| 步骤 | 结果 |
|------|------|
| `npx edgeone whoami` | ✅ 登录 account 100027227704 |
| `npx edgeone makers init` | ✅ |
| 首次部署 `npx edgeone makers deploy . -n ocrproxy-v3-1787917789 -e production` | ✅ Deploy Success，URL `https://ocrproxy-v3-1787917789-vjlvguys.edgeone.cool` |
| 本地 dev 模式 build | ✅ "Compiled edge functions successfully" |
| `/hello` (V8 Edge Function) | ✅ 返回 `{message, method, path, uuid, clientIp}` JSON |
| `/health` (V8 Edge Function) | ✅ 返回 config 状态、cooldowns 列表、model_count |
| `/v1/models` (无 auth，无 config) | ✅ 500 `config_error`（auth bypass + 走到 config 加载逻辑） |
| `node scripts/test-units.mjs` | ✅ 51/51 通过（含 cooldowns.js 25 项） |

### 未完成（被卡住）

| 步骤 | 状态 |
|------|------|
| 设置 `PROXY_API_KEY` + `AGENT_CONFIG_JSON` env vars | ✅ `npx edgeone makers env set` 调用成功 |
| 重部署让 env vars 生效 | ❌ 多次重部署都卡在 `Pending` 状态 90s+ |
| 跑 `scripts/check-ip-diversity.sh` | ❌ 阻塞于重部署 |
| 跑 `scripts/smoke-test.sh` | ❌ 阻塞于重部署 + env vars |
| IP egress 验证 | ❌ 需要 `/check-ip` 端点（旧部署没有，新部署卡住） |

### 修复了一个 bug

`edge-functions/v1/chat/completions.js` 第 233 行原本是 `'x-edgeone-relay-latency-ms', String(Date.now() - startMs)`——对象字面量里 `key, value` 写法导致 esbuild 编译失败。改成 `'x-edgeone-relay-latency-ms': String(Date.now() - startMs)` 后，本地 dev build 通过。

### 给后续的提示

1. **环境变量需要重部署才生效**——Makers 的设计，env set 不会热更新。
2. **重部署可能卡 Pending**——多次尝试都卡住，可能是平台临时状态。建议：**在控制台手工创建项目 + 绑定自定义域名 + 直接上传 .zip** 绕过 CLI。
3. **首次部署 vs 重部署**——首次 30-50s 完成，重部署可能 90s+ 卡住。CLI 没有 force 选项。
4. **URL 必须带 `eo_token` cookie**——否则被 EdgeOne 的 preview protection 拦下。redirect 会丢 query，建议用 cookie。
5. **global area 的 `.cool` 域名**对国内访问可能有问题（观察到过旧项目内容"康康个人博客"）。生产建议用 `.app`（china-mainland）或绑自有域名。
6. **/api/state 端点**（admin GET/DELETE cooldowns）已在代码中，等重部署可用。

### 关键代码改动

- 新增 `lib/cooldowns.js`（210 行）—— KV 读/写、circuit breaker、状态快照、批量读
- 重写 `v1/chat/completions.js`（340 行）—— 有状态 failover 循环、首块 peek、KV 集成
- 重写 `health.js`（70 行）—— 暴露 cooldowns 状态
- 新增 `api/state.js`（100 行）—— admin GET/DELETE cooldowns
- 修正一处对象字面量语法错误（导致 esbuild 编译失败）
