# OCRProxy — 大模型中转与智能调度服务 (Monorepo)

本项目采用 **Monorepo** 架构，统一维护一套全功能的 VM 服务端应用 (`vm-app`) 与一套无服务器 EdgeOne 边缘函数版本 (`agent-edgeone`)。所有 VM 模式共用一套通用加密配置 Schema，在保持 100% 完整功能特性的同时，通过 **`RUN_MODE`** 实现界面与路由的动态自适应。

---

## 架构概览 (Architecture Overview)

```
ocrprox (Monorepo)
├── vm-app/                            # 统一的 VM 核心代码库（单代码库，多模式自适应）
│   ├── app/                           # 包含全量后端路由、透明调度器、探活与统计
│   ├── static/admin.html              # 完整版富交互管理后台（根据 RUN_MODE 动态自适应）
│   ├── install.sh                     # 交互式一键安装脚本（支持交互选择 1:Agent / 2:KB / 3:Full）
│   ├── requirements.txt               # 依赖列表
│   └── scripts/                       # 自动化测试与初始化工具
│
├── agent-edgeone/                     # 部署于腾讯云 EdgeOne 边缘函数 (Serverless)
│   ├── edge-functions/                # V8 边缘函数 (OpenAI 兼容 /v1/* 接口)
│   ├── admin.html / css / js          # 现代化 EdgeOne 管理后台
│   └── package.json                   # EdgeOne 构建与 106+ 自动化测试套件
│
├── shared/                            # 共享资源与规范文档
│   ├── presets/                       # 11 大官方供应商标准预设 JSON 与目录索引 catalog.json (AMD, MiniMax, Google, DeepSeek, etc.)
│   ├── admin/                         # 跨端共用的现代化 Web 管理后台前端 (HTML / CSS / JS)
│   └── docs/config-schema.md          # 统一配置规范文档
│
├── index.html                         # 个人博客首页 (腾讯云 VM 80 端口托管)
└── design-system/                     # UI 设计系统 Tokens 与组件库
```

---

## 运行模式对比与自适应行为 (`RUN_MODE`)

无论选择哪种运行模式，底层均运行同一套完整的后端服务与管理前端，**配置文件格式 100% 通用无损**，支持在后台管理界面随时切换运行模式：

| 维度 | `RUN_MODE=agent` (智能体模式) | `RUN_MODE=kb` (知识库模式) | `RUN_MODE=full` (全功能混合模式) |
| :--- | :--- | :--- | :--- |
| **典型部署环境** | 海外 Azure / 自建 VM，用于 Cursor / Cline / OpenClaw 直连海外大模型 | 国内腾讯云 VM，用于 Dify / FastGPT / Ragflow 高并发知识库入库 | 单机同时服务智能体编程与知识库检索 |
| **默认 Key 轮换策略** | **粘性故障转移 (`sticky_failover`)**：固定使用当前 Key，遭遇 429/5xx 顺延切换，且**切换后长期驻留新 Key**，杜绝抖动 | **轮询负载均衡 (`round_robin`)**：原子计数轮询各 Key，最大化利用并发配额 | 支持针对 Agent 与 KB 独立配置分流策略 |
| **内存治理机制** | 极轻量占用 (~30MB)，零拷贝 SSE 异步流式转发，无需定时重启服务 | 大 payload (OCR / Embedding) 结束立即调用 glibc `malloc_trim(0)` 释放堆内存，杜绝内存膨胀 | 混合感知内存回收，按需释放 |
| **服务运维与重启** | 默认关闭每日定时重启定时器，保证长连接会话长效稳定 | 默认启用每日凌晨 04:00 重启定时器，重置内存碎片 | 可按需在后台管理面板一键平滑重启服务 |
| **后台界面自适应** | 隐藏 KB 候选挂载区与 KB 4项入库超时，只展示 Agent 模型、供应商凭证、Agent 监控与接入指南 | 隐藏 Agent 模型区与 Agent 对话超时，只展示 4 大虚拟模型挂载、KB 入库超时与 Dify 接入指南 | **完整展示**（供应商凭证库 + Agent 模型 + KB 虚拟模型 + 全量参数与示例） |
| **`/v1/models` 返回** | 仅返回 `agent_models` 中的真实模型列表 | 固定返回 4 个虚拟聚合模型 (`chat`, `embedding`, `reranker`, `ocr`) | 联合返回真实模型 + 4 个虚拟聚合模型 |
| **`/v1/chat/completions`** | 原生透传 tools、reasoning、SSE 流式字节 | 强制禁用思考提速、非流式快速摘要提取 | 若 model 为 `chat` 走 KB 提速策略，若为真实模型走 Agent 原生透传 |
| **`/v1/messages`** | **原生支持 Anthropic Messages 协议** (专为 MiniMax-M3, B.AI, Claude SDK 直通) | 知识库模式禁用 (返回 404) | 原生支持真实 Agent 模型直通转发 |
| **配置数据存储** | **100% 结构通用无损**，任何模式下导入/导出或切换模式**绝不丢弃任何字段** |

---

## 模型提供商解耦架构与云端动态分发 (Decoupled Provider Architecture & CDN Distribution)

为解决模型厂商适配频繁变动导致主程序必须重新编译与部署的痛点，OCRProxy 实现了**提供商适配与网关核心主程序完全分离**的声明式架构：

### 核心设计原则
1. **彻底解耦**：核心 Python 网关与 EdgeOne JS 路由完全消除硬编码的 `if provider == "..."` 分支，转由统一的纯声明式规则引擎（`adapter_rules`）通用执行。
2. **轻量按需拉取 (On-Demand Fetching)**：控制台添加提供商时，仅拉取轻量级的 `catalog.json` 目录列表（仅几十字节/厂商）。只有用户选择并保存特定供应商时，才按需拉取对应供应商的完整适配规则落地到本地配置。
3. **精准增量更新 (Incremental Updates)**：检查更新时仅对比本地已添加的提供商，不进行全量拉取。用户可一键增量同步指定厂商的最新规则，本地已配置的 API Key、别名和映射设置 100% 原样保留。
4. **本地零冗余清理 (Local Cleanup on Delete)**：删除供应商时，对应的本地适配规则与挂载一并彻底清除，保持配置干净精简。
5. **双通道分发与离线兜底**：
   - 优先通过 **jsDelivr CDN** (`cdn.jsdelivr.net/gh/khc8655/ocrproxy@main/shared/presets/`) 极速拉取；
   - 遇到网络异常自动无缝降级至 GitHub Raw 备用源；
   - 本地内置 11 大主流厂商离线默认包（Fallback），无网环境完全无阻。

---

## Key 调度、超时控制与智能熔断 (Routing, Timeout Budget & Fault Tolerance)

为了从根源上杜绝在高峰期或上游拥堵时请求挂起数分钟的问题，OCRProxy 实现了全链路统一的 **Schema v2 全局超时控制与智能熔断体系**：

### 1. 分流策略 (`agent_routing_strategy`)
- **`sticky_failover` (粘性故障转移 - 智能体推荐)**：
  - 默认固定使用当前的可用 Key；
  - 仅当该 Key 触发 429 限流或 5xx 错误时顺延切换至下一个候选 Key；
  - **切换后长期驻留新 Key**，杜绝多轮对话中的 Key 频繁抖动。
- **`manual` (纯手动直通模式 - 锁定 Key / 纯透传)**：
  - 由管理员在模型列表中手动指定激活某一个 Key（`active_key`），提供可视化状态与一键切换；
  - **绝不自动切 Key、不自动轮询、不熔断**；死等上游返回，原始状态码（200/400/401/403/429/500/504）与响应体 100% 纯透传；
  - 后台设置面板自动灰化禁用重试次数、熔断与冷却参数。
- **`round_robin` (轮询负载均衡)**：原子递增轮询可用 Key，均匀分摊 TPM/RPM 压力。
- **`priority_fallback` (优先级优先)**：严格按列表顺序尝试。
- **`latency_based` (最低延迟优先)**：基于近期实测延迟智能路由至响应最快的优质 Key。

### 2. 全局硬时钟预算与多层超时控制 (Timeout Budget)
- **`request_total_budget_sec` (单次请求全局硬预算)**：
  - **EdgeOne 边缘版**：默认 **`25s`**（在 EdgeOne 平台 30s 强杀前 5s 提前拦截，主动向客户端返回规范的 504 Gateway Timeout 与完整调用链路轨迹，彻底根治 4 分钟卡死）；
  - **VM 服务端版**：默认 **`45s`**。
- **`upstream_timeout_sec` (单 Key 响应超时)**：默认 **`15s`**，单个 Key 超时立即切换。
- **`schedule_total_budget` (单请求重试上限)**：默认 **`3 次`**。
- **`max_attempts_per_provider` (单厂商尝试上限)**：默认 **`2 次`**（防止同一厂商配置 7 个 Key 时在已宕机源站上死等 7 次导致乘数爆炸）。
- **`fast_failover_provider_down` (跨厂商快速熔断)**：默认 **开启**。当上游厂商遭遇 502/504 或超时且存在其他备用厂商时，直接跳过该厂商所有剩余 Key，秒级切换至备用厂商。

### 3. 链路追踪与透明诊断响应头
每次请求均在 HTTP 响应头中注入实时链路信息：
- `x-proxy-route`: 如 `stepfun/自己=ok` 或 `sensenova/测试=http_429->agnes/自己=ok`
- `x-proxy-attempts`: 如 `1` 或 `2`
- `x-proxy-latency-ms`: 如 `1870`

### 4. 统一声明式适配器管道 (Declarative Adapter Pipeline)
通过 `shared/presets/*.json` 声明式规则驱动，彻底消除硬编码 `if-else`：
- **思考链等级控制 (Reasoning & Thinking Level)**：
  - **SenseNova (商汤)**：原生支持标准 `reasoning_effort` (`none/low/medium/high`)，支持 `sensenova-6.8-flash-lite`, `deepseek-v4-flash`, `glm-5.2`；
  - **StepFun (阶跃)**：`none` 自动映射为 `low` 降级（防止上游 400），自动注入 `reasoning_format: "deepseek-style"` 以在 SSE 流中返回 `reasoning_content`；
  - **Agnes AI**：OpenAI 协议下自动映射为 `chat_template_kwargs: {"enable_thinking": true/false}`；
  - **Google AI Studio (Gemini)**：
    - **Thinking Matrix**：Flash 支持 `minimal/low/medium/high`，Pro 适配 `low/high`，`none` 映射为 `include_thoughts: false`，Gemma 模型自动规避；
    - **思考预算自动提升**：开启思考时若客户端设置的 `max_tokens` 过小（< 16384），自动提升至 65535，杜绝思考 Token 耗尽导致的空响应与截断；
  - **MiniMax (国内官方订阅 & Anthropic Messages 双通道)**：
    - **双通道直通**：OpenAI 协议直通 `https://api.minimaxi.com/v1/chat/completions`，Messages 协议直通 `https://api.minimax.cn/anthropic/v1/messages`；
    - **非标参数清洗**：自动剥离 Claude 3.7 专有的 `output_config` 等非标字段（防止 MiniMax 报 400 错误）；
    - **大小写严格保护**：强制确保模型名称保留为官方要求的 `MiniMax-M3`；
    - **Thinking 规范化**：自动规整 `budget_tokens` 并补全 `type: "enabled"`，无缝支持 Thinking 内容块输出；
  - **B.AI (双协议兼容网关)**：原生双端点支持，`/v1/chat/completions` 与 `/v1/messages` 智能分流直通；
  - **AMD Radeon Cloud (官方高性能集群与双协议网关)**：
    - **思考链深度适配**：AMD 前置网关按白名单字段重新组装请求，严禁 `thinking: {...}` 与 `chat_template_kwargs`；系统自动适配官方规范的 `reasoning_effort: "medium"`（使 `DeepSeek-V4-Flash` 能够正常思考，同时使 `Qwen3.8-Flash-Next` 保持安全思考深度，杜绝 400 报错）；
    - **Anthropic Messages 协议直通**：自动将 Claude Code 等客户端发送的 `thinking: {"type": "enabled", ...}` 转换为 AMD 官方支持的 `output_config: {"effort": "medium"}` 并剥除 `thinking`；
    - **消息规范化防爆**：自动将 `role: "developer"` 转换为 `role: "system"`，且自动提取合并所有 `system` 消息并严格置顶于 `messages[0]`，彻底根治 Qwen 模型报 `400 BadRequestError: System message must be at the beginning`；
    - **响应字段统一规整**：在流式 SSE 与非流式中，自动将 AMD 私有的 `reasoning` 映射规整为通用的 `reasoning_content`，并将 `completion_tokens_details.reasoning_tokens` 回填至顶层 `usage.reasoning_tokens`。
- **特殊工具调用 (Tool Calling)**：
  - **`tool_choice` 规整**：TokenRhythm / SenseNova / DeepSeek 严禁对象形式，自动转为 `"auto"` 字符串；
  - **深度 Schema 清洗**：针对 Google Gemini 递归剔除 `$schema`、`additionalProperties`、`$defs`、`$ref`，并自动校验清理不在 `properties` 中的多余 `required` 声明；
  - **文本 Tool Call 拯救**：自动捕获模型在文本中输出的代码块与 XML 标签并提取为标准 OpenAI `tool_calls`。
- **智能 URL 端点补齐**：自动感知供应商是否包含 `/v1` 后缀并智能规整拼接。

### 5. 生产级默认安全加固体系 (Security by Default)
系统遵循开箱即安全的原则，在代码层面与一键部署中默认启用全方位加固：
- **公网文档与元数据彻底隐藏**：生产环境默认关闭 `/docs`、`/redoc` 与 `/openapi.json`（返回 404），彻底阻断外部扫描器侦察接口结构；
- **全局企业级安全响应头**：所有 HTTP 响应默认注入 `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`X-XSS-Protection`、`Referrer-Policy`，并剥除 `Server: uvicorn` 框架指纹；
- **管理后台防暴力破解与防时序攻击**：针对 `/api/admin/*` 连续 5 次错误尝试自动触发 10 分钟 IP 级滑动窗口临时阻断，强制使用 `hmac.compare_digest` 防御时序侧信道攻击；
- **系统沙箱与权限隔离**：Systemd 默认开启 `NoNewPrivileges=true`、`ProtectSystem=strict`、`PrivateTmp=true`，配置文件严格锁定 `600` / `700`。

---

## 快速上手与部署指南

### 1. VM 统一版本部署 (`vm-app`)

#### 一键快速安装与升级（极简推荐 ⭐⭐⭐）

在目标服务器（Ubuntu / Debian / Linux）上直接执行单行命令：
```bash
# 全新安装（仅需输入/回车确认端口和密码）或已安装自动平滑升级
curl -fsSL https://raw.githubusercontent.com/khc8655/ocrproxy/main/install.sh | bash
```

> **自动化静默安装示例**：
> ```bash
> # 指定监听端口与 Web 后台管理员密码，无人值守全自动安装
> curl -fsSL https://raw.githubusercontent.com/khc8655/ocrproxy/main/install.sh | bash -s -- -p 8787 -w YourAdminPassword123
> ```

#### 本地源码安装
```bash
git clone https://github.com/khc8655/ocrproxy.git /tmp/ocrprox
cd /tmp/ocrprox
sudo bash install.sh
```

在安装向导中按需选择模式与端口：
```
------------------------------------------------------------
  请选择 OCRProxy 运行模式:
  1) Agent 智能体模式 (推荐海外 VM / 直连海外模型 / Cursor / Cline)
  2) KB 知识库模式   (推荐国内 VM / 知识库入库 / Dify / FastGPT)
  3) Full 全功能混合模式 (同时支持 Agent 编程与 KB 知识库)
------------------------------------------------------------
输入选项 [1-3] (默认: 1): 1
请输入服务监听端口 (默认: 3000): 3000
```

安装脚本将自动：
1. 配置 `systemd` 服务守护进程（支持 Dual-Stack IPv6/IPv4 `::` 监听）；
2. 自动配置 `journald` 50MB 磁盘日志配额与 7 天保留策略，彻底防止日志占满磁盘；
3. 生成加密主密钥并创建通用初始配置文件 `/opt/ocrproxy/config/proxy_config.enc`；
4. 输出独立的管理员密码（用于 Web 登录）与客户端默认 Key（用于 `/v1/*` 接入）。

---

### 2. EdgeOne 边缘函数版本 (`agent-edgeone`)

进入 `agent-edgeone/` 目录：
```bash
cd agent-edgeone
npm install
npm test            # 运行 106 项自动化单元测试
npm run build:admin # 构建单文件管理后台
npm run deploy      # 一键发布至 EdgeOne
```

---

## 生产级测试验证套件

本项目提供了两套标准的生产级自动化回归测试套件：

### 1. Agent 模式测试套件 (`tests/test_live_models_suite.py`)
```bash
python3 tests/test_live_models_suite.py
# 或指定目标域名
TARGET_URL="https://api1.khc6.cn" python3 tests/test_live_models_suite.py
```
- **思考等级 (Reasoning Effort) 验证**：测试 `none` / `low` / `medium` / `high` 各等级下的推理字数与思维链标记；
- **流式 (SSE) vs 非流式对比验证**：全面测试各模型首字时间 (TTFT < 800ms) 与数据块流式传输；
- **连续 10 轮工具调用 (Function Calling) 闭环测试**：连续发起函数调用、参数解析、模拟执行并送回结果完成多轮会话闭环，100% 成功率。

### 2. KB 知识库模式测试套件 (`tests/test_live_kb_suite.py`)
```bash
python3 tests/test_live_kb_suite.py
# 或指定目标域名
TARGET_URL="https://api.khc6.cn" python3 tests/test_live_kb_suite.py
```
- **KB 快速对话摘要测试 (`/v1/chat/completions`, model="chat")**：验证非流式、强制关闭/极简思考、极速响应；
- **文本向量化测试 (`/v1/embeddings`, model="embedding")**：验证单句与批量多文档向量生成、向量维度（如 2560 维）与浮点有效性；
- **检索重排测试 (`/v1/rerank`, model="reranker")**：验证多文档相似度打分与相关性重排；
- **多模态 OCR 图文提取测试 (`/v1/ocr`, model="ocr")**：验证 Base64 图像文字识别与 Markdown 输出；
- **Key 轮询负载均衡测试 (Round-Robin Routing)**：验证高并发下多 Key 均匀分摊与 `X-Routed-Via` 轮换；
- **全量负向安全鉴权测试 (Security Guard)**：验证空 Key、假 Key、非法 Header 严格 401 拦截。

---

## 客户端与管理鉴权架构

1. **Web 管理后台登录**：使用安装时生成的独立密码 `ADMIN_PASSWORD` 保护；
2. **客户端接口调用 (`/v1/*`)**：使用 `PROXY_API_KEY` 进行鉴权；可在 Web 管理后台「系统运行与可靠性参数 -> 客户端连接鉴权」中直接查看、复制、修改或一键随机生成，修改后点击「保存设置」即刻全域生效，无需登录服务器修改环境变量；
3. **服务平滑重启**：可在 Web 后台「服务运维与系统重启」卡片中一键发起安全重启，耗时约 2-3 秒，自动重连。
