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
│   └── package.json                   # EdgeOne 构建与 132 项自动化测试套件
│
├── shared/                            # 共享资源与规范文档
│   ├── presets/                       # 11 大官方供应商标准预设 JSON 与目录索引 catalog.json (AMD, MiniMax, Google, DeepSeek, etc.)
│   ├── admin/                         # 跨端共用的模块化动静分离 Web 管理后台
│   │   ├── admin.html                 # 纯 HTML 语义骨架与弹窗容器 (~700 行)
│   │   ├── admin.css                  # 统一设计系统样式表 (Tokens, 栅格, 导航轨) (~370 行)
│   │   └── js/                        # 6 大独立业务领域小脚本 (core, vault, providers, models, settings, app)
│   └── docs/config-schema.md          # 统一配置规范文档
│
├── index.html                         # 个人博客首页 (腾讯云 VM 80 端口托管)
└── design-system/                     # UI 设计系统 Tokens 与组件库
```

---

## 运行模式对比与自适应行为 (`RUN_MODE`)

系统彻底废除臃肿冲突的混合模式，全面收敛为**严格二元的单一模式定位**。海外节点专精 Agent，国内节点专精 KB，彻底杜绝参数竞争与环境干扰：

| 维度 | `RUN_MODE=agent` (智能体直连模式) | `RUN_MODE=kb` (知识库入库模式) |
| :--- | :--- | :--- |
| **典型部署环境** | 海外原生网络 VM (如 Azure / AWS)，专供 Cursor / Cline 直连 | 国内高防与内网 VM (如 腾讯云 / 阿里云)，专供 Dify / FastGPT 批量知识库入库 |
| **界面展示呈现** | **彻底消除 Subtab 标签栏**，单页全宽展示 Agent 模型管理与调用深度监控 | **彻底消除 Subtab 标签栏**，单页全宽展示 4 大虚拟聚合模型 (`chat`, `embedding`, `reranker`, `ocr`) |
| **EdgeOne 资产配置交互** | **极简 3 次点击胶囊流**（点选供应商胶囊 ➔ 点选 Key 胶囊 ➔ 点选模型胶囊 ➔ 保存，零键盘打字） | **极简 3 次点击胶囊流**（角色胶囊 ➔ 供应商胶囊 ➔ Key 胶囊 ➔ 推荐模型胶囊，零键盘打字） |
| **默认 Key 轮换策略** | **粘性故障转移 (`sticky_failover`)**：锁定当前激活 Key，遇 429 顺延切新 Key 并长期驻留 | **轮询负载均衡 (`round_robin`)**：原子计数轮询各 Key，最大化打散并发与利用 TPM 配额 |
| **模型暴露范围 (`/v1/models`)** | **仅返回 `agent_models` 中的真实模型列表**（绝不泄露虚拟模型） | **固定返回 4 个虚拟聚合别名** (`chat`, `embedding`, `reranker`, `ocr`) |
| **推理与思考链处理** | **100% 原始透传**：tools、reasoning_effort、思考链、SSE 流式字节原汁原味透传 | **强制禁用思考提速**：非流式极速返回纯净结果，入库速度提升 300% |
| **Anthropic 协议直通 (`/v1/messages`)** | **原生支持** (针对 MiniMax-M3, B.AI, Claude 官方 SDK 直通) | 知识库模式严格禁用 (返回 404) |
| **内存与运维策略** | 轻量常驻，无需重启，长连接会话 24h 不中断 | 每日凌晨 04:00 自动定时平滑重启释放堆内存碎片 |

---

## EdgeOne 凭据中枢与 VM 双轨凭据架构 (EdgeOne Vault Hub & Local Credential Sovereignty)

系统确立了“**本地存储为主权基石，中枢托管为增效辅助**”的双轨架构，既能统一享受 EdgeOne 中枢集中下发的厂商与密钥，又完全保留了各 VM 节点的本地自主控制权：

### 1. 职责与双轨机制
- **EdgeOne 凭据资产中枢 (Vault Hub)**：集中维护官方适配提供商与其拥有的 API Keys，支持脱敏清单分发与动态探测；中枢鉴权校验边缘函数环境变量 `PROXY_API_KEY`；
- **VM 本地凭据自主管理 (Local Credential Sovereignty)**：
  - 完整保留「供应商与 Key 凭证库」管理面板（支持 A-Z 字母索引导航轨与分组标线）；
  - 支持随时在卡片上自主新增、编辑与删除本地专属 Key，变更直接持久化至 `proxy_config.enc`，绝不依赖或受制于中枢；
  - 模型配置弹窗内清晰区隔“本地已配置供应商”与“EdgeOne 凭据中枢托管”，并提供行内「+ 添加本地 Key」快捷入口。
- **Web 端免 `.env` 可视化配置与实时诊断**：
  - 在管理后台「系统设置」提供 Card 6「EdgeOne 凭据中枢连接与诊断 (Vault Hub)」；
  - 可视化填入中枢 URL 与 Token（密码可一键显隐），配置直接加密保存于 `proxy_config.enc`，**严禁修改或污染 `.env` 文件**；
  - 提供一键「测试中枢连通性」，实时诊断连通状态、网络延迟、供应商总数与 Google Key 列表；
- **全链路透明错误处理 (Zero Silent Errors)**：
  - 中枢 401（Token 与 EdgeOne PROXY_API_KEY 不匹配）、502（网络不可达）、504（请求超时）均向 Web 端输出透明友好的排查指引，杜绝任何静默吞错。
- **按需无感拉取与云端绝对权威覆盖 (Cloud Authority & Local Key Sovereignty)**：
  - **云端作为绝对真理源**：当从 EdgeOne Vault Hub 拉取凭据或执行同步时，云端配置无条件覆盖本地同名供应商的协议 (`protocol`/`protocols`)、思考开关 (`anthropic_messages`)、端点 (`base_url`/`anthropic_base_url`) 及适配规则 (`adapter_rules`)，彻底根治协议识别冲突；
  - **本地独有 Key 安全保留**：在覆盖供应商元数据的同时，智能合并密钥凭据字典，保留本地临时或独有新增的 Key，避免本地 Key 被误冲毁。

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
  - **VM 服务端版**：默认 **`60s`**（充分容纳 KB 大文档入库推理与多 Key 故障转移切换）。
- **`upstream_timeout_sec` (单 Key 响应超时)**：默认 **`15s`**，单个 Key 超时立即切换。
- **`schedule_total_budget` (单请求重试上限)**：默认 **`5 次`**。
- **`max_attempts_per_provider` (单厂商尝试上限)**：默认 **`6 次`**（满足商汤、硅基等单厂商配置 5~8 个不同账号 Key 的深度轮询调度）。
- **`fast_failover_provider_down` (跨厂商快速熔断)**：默认 **开启**。当上游厂商遭遇 502/504 或超时且存在其他备用厂商时，直接跳过该厂商所有剩余 Key，秒级切换至备用厂商。
- **429 欠费与额度耗尽 30 分钟智能冷冻 (Quota Quarantine)**：
  - 自动识别商汤 `Allocated quota exceeded`、OpenCode `Consumer daily free usage limit exceeded` 等致命账号级错误；
  - 触发后立即打入 **30 分钟（1800s）长效冷冻**，调度层物理跳过，杜绝废 Key 吃掉重试预算；控制台列表直接标注红色 `[欠费]` 徽章；
  - 成功调用（HTTP 200）即刻自动清除冷冻与欠费标记。
- **控制台极简原生数字排序 (Lightweight Numeric Ordering)**：
  - 彻底移除复杂或难按的 `↑` / `↓` 箭头；
  - 序号列采用原生超轻量数字输入框（支持任意数字输入自动安全截断归位），纯本地数组秒级位移，后端零依赖。

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
  - **Agnes AI**：全面支持最新 `agnes-3.0-flash` 旗舰开源推理模型与 `agnes-2.5-flash`；Agent 模式下缺省默认开启思考（`default_thinking: true` 自动映射为 `chat_template_kwargs: {"enable_thinking": true}`），客户端传 `reasoning_effort: "none"` 时精准关闭；KB 模式严格锁死禁用思考以保障毫秒级低延迟；内置 `max_tokens_ceiling: 65536` 钳制保护（杜绝 Hermes 等 Agent 工具超限 400 报错）；
  - **Google AI Studio (Gemini)**：
    - **Thinking Matrix**：Flash 支持 `minimal/low/medium/high`，Pro 适配 `low/high`，`none` 映射为 `include_thoughts: false`，Gemma 模型自动规避；
    - **思考预算自动提升**：开启思考时若客户端设置的 `max_tokens` 过小（< 16384），自动提升至 65535，杜绝思考 Token 耗尽导致的空响应与截断；
  - **MiniMax (国内官方订阅 & Anthropic Messages 双通道)**：
    - **双通道直通**：OpenAI 协议直通 `https://api.minimaxi.com/v1/chat/completions`，Messages 协议直通 `https://api.minimax.cn/anthropic/v1/messages`；
    - **非标参数清洗**：自动剥离 Claude 3.7 专有的 `output_config` 等非标字段（防止 MiniMax 报 400 错误）；
    - **大小写严格保护**：强制确保模型名称保留为官方要求的 `MiniMax-M3`；
    - **Thinking 规范化**：自动规整 `budget_tokens` 并补全 `type: "enabled"`，无缝支持 Thinking 内容块输出；
  - **B.AI (双协议兼容网关与 GLM 思考链专属适配)**：
    - **双通道直通**：原生双端点支持，`/v1/chat/completions` 与 `/v1/messages` 智能分流直通；
    - **GLM 常开思考专属适配**：针对 `glm-5.3-flash` 等常开思考模型（不支持关闭思考且仅认 `low/high/max`），专属映射：将 Hermes 默认的 `medium` 自动重映射为 `high`，将 `none` 安全剔除（omit）以避免触发 400 校验异常，彻底根治“该模型始终思考，不支持关闭思考；请使用 low、high 或 max”报错；
    - **严格厂商隔离**：该规则仅对 B.AI 旗下的 GLM 模型生效，B.AI 内部的 `qwen3.8-flash` 及其他厂商模型完全保持原生标准直通，不受任何干扰。
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

### 5. 前端组件化解耦架构：EdgeOne 与 VM 端 Agent 模型 UI 统一 (Unified Component)
为彻底解决多端维护分裂、杜绝整页覆盖的安全红线，前端实施了**组件级逻辑提炼与精准装配 (Component-Level Extraction)**：
- **核心组件共享 (`shared/admin/js/agent-models-ui.js`)**：
  - 提炼统一的 Agent 模型渲染、三步式胶囊选择弹窗、上游模型探测、单 Key 探活、全量并发探活、生产 1+1 实时测速、原生数字输入框秒级换序、设为主力 Key 与持久化；
  - **自适应数据与宿主桥梁**：组件自动根据宿主环境选择存储目标（EdgeOne 写入 KV，VM 写入本地配置文件），自动分流探活端点（EdgeOne 路由至 `/api/test`，VM 路由至 `/api/admin/test-agent-model`），两端操作体验像素级一致；
- **绝对物理隔离 (Vault Hub 铁律保护)**：
  - 构建脚本（`build-admin.mjs`）仅在编译时以无副作用方式内联拼接 JS 组件，**绝对禁止跨端覆盖 HTML 骨架**；
  - EdgeOne 专属的 6 大顶级导航栏（`概览`、`Agent 模型`、`供应商与 Key 凭证库`、`全局策略`、`JSON 配置`、`接入说明`）与真理源凭据中枢（Vault Hub）地位 100% 保持常驻且独立，A-Z 索引轨与全量厂商纳管功能完好无损。

### 6. 生产级默认安全加固体系 (Security by Default)
系统遵循开箱即安全的原则，在代码层面与一键部署中默认启用全方位加固：
- **公网文档与元数据彻底隐藏**：生产环境默认关闭 `/docs`、`/redoc` 与 `/openapi.json`（返回 404），彻底阻断外部扫描器侦察接口结构；
- **全局企业级安全响应头**：所有 HTTP 响应默认注入 `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`X-XSS-Protection`、`Referrer-Policy`，并剥除 `Server: uvicorn` 框架指纹；
- **管理后台防暴力破解与防时序攻击**：针对 `/api/admin/*` 连续 5 次错误尝试自动触发 10 分钟 IP 级滑动窗口临时阻断，强制使用 `hmac.compare_digest` 防御时序侧信道攻击；
- **系统沙箱与权限隔离**：Systemd 默认开启 `NoNewPrivileges=true`、`ProtectSystem=strict`、`PrivateTmp=true`，配置文件严格锁定 `600` / `700`。

---

## 快速上手与部署指南

### 1. VM 统一版本部署 (`vm-app`)

#### 一键快速安装与生命周期管理（极简推荐 ⭐⭐⭐）

在目标服务器（Ubuntu / Debian / Linux）上**直接以普通用户运行**（无需前置 `sudo`，仅缺失系统底层依赖时按需提示 `sudo`）：

```bash
# 首次安装：交互式向导（提示确认端口、密码与运行模式）
# 已安装机器：自动进入无感平滑升级（配置与密钥 100% 保留备份）
curl -fsSL https://raw.githubusercontent.com/khc8655/ocrproxy/main/install.sh | bash
```

> **自动化静默安装示例**（适合脚本/CI/无人值守部署）：
> ```bash
> # 指定端口、密码与模式 (-m agent | kb | full)
> curl -fsSL https://raw.githubusercontent.com/khc8655/ocrproxy/main/install.sh | bash -s -- -p 8787 -w YourAdminPassword123 -m agent -y
> ```

#### 系统已注册全局运维命令 (`ocrproxy` CLI)

安装完成后，系统已自动注册全局便捷运维命令 `/usr/local/bin/ocrproxy`，并配置了细粒度免密运维白名单，**日常维护全程无需输入 root 密码**：

| 命令 | 说明 | 权限说明 |
| :--- | :--- | :--- |
| **`ocrproxy upgrade`** | 从 GitHub `main` 分支平滑就地升级，自动更新代码与依赖并自检 | **普通用户直接运行**（免 sudo 密码） |
| **`ocrproxy status`** | 查看当前 systemd 服务运行状态与端口监听 | 普通用户直接运行 |
| **`ocrproxy log`** | 实时追踪服务运行日志（等同 `journalctl -u ocrproxy -f`） | 普通用户直接运行（Ctrl+C 退出） |
| **`ocrproxy restart`** | 优雅平滑重启服务 | **免密重启**（已配置极窄 sudoers 白名单） |
| **`ocrproxy uninstall`** | 安全卸载服务（支持交互确认并归档备份配置） | 支持 `--keep-config` 保留密钥数据 |

#### GitOps 单向发布纪律说明
- **全面对齐 EdgeOne**：VM 版本的生命周期管理与 EdgeOne 保持一致，**严禁使用 SSH/SCP 手动登录云主机修改代码**；
- **唯一代码流向**：本地开发/测试 -> Git 提交并推送至 GitHub 仓库 -> 目标云主机通过 `ocrproxy upgrade` 或网络一键脚本直接拉取最新发布制品更新，杜绝环境漂移。

#### 一键网络安装与平滑升级 (支持 Caddy 反代与全网直通)
```bash
curl -fsSL https://raw.githubusercontent.com/khc8655/ocrproxy/main/install.sh | bash
```

在安装向导中按需选择端口、密码、模式及反代策略：
```
------------------------------------------------------------
  OCRProxy 一键部署与管理中心 (v2026.09.22)
------------------------------------------------------------
请输入服务监听端口 (默认: 8787): 8787
请设置 Web 管理后台密码 (建议 8 位以上，回车自动生成 16 位强随机密码): 
请选择系统运行模式 (1: Agent 智能体直连模式 [默认] | 2: KB 知识库入库加速模式): 1
请选择是否启用反向代理 (如 Caddy / Nginx 等):
  1: 启用反代 (安全推荐：服务仅监听 127.0.0.1 本地端口，外部流量由 Caddy/Nginx 代理)
  2: 不使用反代 (服务监听 IPv4/IPv6 全网，直接通过 IP:端口 访问) [默认]
```

安装脚本自动完成以下配置：
1. 配置 `systemd` 服务守护进程（支持 Dual-Stack IPv6/IPv4 `::` 或 `127.0.0.1` 监听）；
2. 自动配置 `journald` 50MB 磁盘日志配额与 7 天保留策略，彻底防止日志占满磁盘；
3. 生成加密主密钥并创建通用初始配置文件 `/opt/ocrproxy/config/proxy_config.enc`；
4. 注册 `/usr/local/bin/ocrproxy` CLI 管理命令与 `/etc/sudoers.d/ocrproxy` 免密运维白名单；
5. 安装完成友好打印：本地运行端口、网络监听模式、Web 管理后台默认密码、大模型接入 API Key、Caddyfile 反代推荐配置样例（`flush_interval -1` 无缓冲适配 SSE）、常用运维命令；
6. 支持随心平滑升级：运行 `ocrproxy upgrade` 或再次执行安装命令，即刻就地无损升级。

---

### 2. EdgeOne 边缘函数版本 (`agent-edgeone`)

进入 `agent-edgeone/` 目录：
```bash
cd agent-edgeone
npm install
npm test            # 运行 158 项自动化单元测试（含编译构建强断言门禁）
npm run build:admin # 构建单文件管理后台（含 Fail-Fast 产物强校验）
npm run deploy      # 一键发布至 EdgeOne
```

---

## 🏛️ 核心架构规范与开发铁律 (Architecture Standards & Anti-Failure Rules)

> [!IMPORTANT]
> 本项目的最高开发准则已收敛于 [ARCHITECTURE_STANDARDS.md](./ARCHITECTURE_STANDARDS.md)。
> 所有开发者与 AI 智能体在提交代码前必须严格遵守，杜绝一切低级错误：
> 1. **严禁假共用与角色倒错**：EdgeOne 是神圣不可侵犯的云端凭据资产中枢 (Vault Hub)，必须物理解耦其专属控制台，供应商与 Key 管理 Tab 必须永远全宽常驻，绝对禁止用构建脚本从 VM 跨端覆盖；
> 2. **构建与静态内联强断言**：构建脚本必须解耦引号与 query 参数限制，末尾强制执行 Fail-Fast 编译强断言，严禁静默输出残次品；
> 3. **SPA 前端原生防御性设计**：HTML `<head>` 顶层原生硬编码隐藏样式，即使外部 CSS 彻底失效，也绝对禁止向未登录用户裸露后台表单；
> 4. **UI 容器单职责解耦**：系统版本号（`topVersionBadge`）与运行模式（`topModeBadge`）必须独立 DOM 节点维护，杜绝文本越界覆写；
> 5. **自动化脚本硬超时熔断**：任何临时与后台测试脚本，首行必须强制注入 5~10 秒硬超时炸弹（`setTimeout` 强制自杀），坚决遵循奥卡姆剃刀轻量验证，杜绝任务死锁假死；
> 6. **跨机房协议标准化**：远程主机运维严禁使用易因冒号死锁的裸 `scp -6`，统一全量采用 SSH 管道流传输（`tar ... | ssh ... tar`）；
> 7. **云端真理源绝对权威覆盖**：当从云端拉取配置时，供应商协议、端点与适配规则必须 100% 以 EdgeOne 为绝对真理源覆盖本地，杜绝本地历史脏数据反噬。



---

## 客户端与管理鉴权架构

1. **Web 管理后台登录**：使用安装时生成的独立密码 `ADMIN_PASSWORD` 保护；
2. **客户端接口调用 (`/v1/*`)**：使用 `PROXY_API_KEY` 进行鉴权；可在 Web 管理后台「系统运行与可靠性参数 -> 客户端连接鉴权」中直接查看、复制、修改或一键随机生成，修改后点击「保存设置」即刻全域生效，无需登录服务器修改环境变量；
3. **服务平滑重启**：可在 Web 后台「服务运维与系统重启」卡片中一键发起安全重启，耗时约 2-3 秒，自动重连。

---

## 高可靠性与并发安全防护 (Reliability & Concurrency Protection)

### 1. 配置并发安全与版本乐观锁 (`_version` 乐观锁 + 滚动加密备份)
- **多端/多标签页并发冲突防护**：配置文件内置单调递增 `_version` 版本号。当旧会话或后台标签页提交过期版本时，服务端严格以 `HTTP 409 Conflict` 拦截保存，前端弹窗友好提示并自动重新加载最新配置，彻底杜绝新增 Key/模型被旧标签页覆盖丢失。
- **自动滚动加密备份**：每次配置成功落盘前，自动在受保护的配置目录中保留带时间戳的加密备份（`proxy_config.enc.bak-<timestamp>`），自动滚动保留最近 20 份历史版本，提供双重兜底保障。
- **跨模式全量资产保留**：无论是从 Agent 模式还是 KB 模式保存，服务端与边缘函数均永久完整保留 `agent_models` 与 `candidates` 两套资产，杜绝因模式切换冲毁未展示模式的节点。

### 2. 跨模型独立监控与隔离机制
- **同 Key 多模型完全解耦**：统计监控状态主键升级为 `kb:{type}:{provider}:{key}:{model}`（与 `agent:{model}:{provider}:{key}`），彻底消除同一个 API Key 挂载到不同模型时耗时、探活状态和可用性联动的缺陷。
- **边缘函数跨模型限流隔离**：EdgeOne 冷却机制将 KV 键升级为 `cd_{provider}_{key}_{model}`，避免模型 A 限流（429）株连模型 B。

### 3. 调度器精准分流：临时限流 (TPM/RPM) 与真账户欠费隔离
- **临时速率限制 (TPM/RPM/QPS)**：识别包含 `tpm`、`rpm`、`rate limit`、`429001` 等分钟级滑动窗口限流报错，严格不标记为欠费，仅执行短退避（15 秒）并平滑轮转至下一候选 Key，窗口刷新后自动秒级恢复。
- **真账户欠费/额度耗尽 (Hard Quota Exhaustion)**：精准匹配 `insufficient_quota`、`allocated quota exceeded`、`balance is insufficient`、`账户欠费`、`余额不足` 等资产级报错，判定为真正欠费并执行 30 分钟长效冷冻，并在管理后台明确标红指示「欠费/冷冻中」。
- **KB 模式与 OCR 视觉思考链全面压制**：`/v1/chat/completions` 与 `/v1/ocr` 均统一应用请求适配器规则，显式注入 `reasoning_effort: "none"`、`thinking: {"type": "disabled"}` 与 `include_thoughts: False`，彻底消除视觉大模型潜在的慢推理时延，保障知识库毫秒级极速解析。


### 4. 高频重试日志限额与内存治理
- **高频入库错误折叠**：知识库（KB）批处理高并发入库重试时，相同供应商与 Key 在 60 秒内触发的重复错误自动折叠（记录 `repeat_count`），严格限制全局最新错误记录最大 100 条且错误文本截断至 300 字符，杜绝磁盘日志与内存爆炸。
- **有界内存字典与快速垃圾回收**：运行时状态采用 O(1) 字典增量刷新，绝不无限增长，高负载下内存稳定在 40~50MB。

