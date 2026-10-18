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
├── agent-edgeone/                     # 部署于 EdgeOne 边缘函数 (Serverless)
│   ├── edge-functions/                # V8 边缘函数 (自包含极速内联单体，由 build-admin.mjs 自动生成)
│   ├── admin.html / css / js          # 由 shared/admin 编译输出的单体产物 (带自动生成警示)
│   └── package.json                   # EdgeOne 构建与 167 项自动化测试套件
│
├── shared/                            # 共享资源与唯一规范源
│   ├── presets/                       # 14 大官方供应商标准预设 JSON（含 NVIDIA NIM）与目录索引 catalog.json
│   ├── admin/                         # 全局唯一的前端开发真理源 (Single Source of Truth)
│   │   ├── admin.html                 # 纯 HTML 语义骨架与弹窗容器 (~700 行)
│   │   ├── admin.css                  # 统一设计系统样式表 (Tokens, 栅格, 导航轨)
│   │   └── js/                        # 7 大独立业务领域小脚本 (core, vault, providers, agent-models-ui, models, settings, app)
│   └── docs/config-schema.md          # 统一配置规范文档
│
└── design-system/                     # UI 设计系统 Tokens 与组件库
```

---

## 运行模式对比与自适应行为 (`RUN_MODE`)

系统彻底废除臃肿冲突的混合模式，全面收敛为**严格二元的单一模式定位**。节点专精 Agent，或专精 KB，彻底杜绝参数竞争与环境干扰：

| 维度 | `RUN_MODE=agent` (智能体直连模式) | `RUN_MODE=kb` (知识库入库模式) |
| :--- | :--- | :--- |
| **典型部署环境** | 国际互联网原生网络环境，专供 Cursor / Cline 直连 | 专有企业网络 / 内网服务器环境，专供 Dify / FastGPT 批量知识库入库 |
| **界面展示呈现** | **彻底消除 Subtab 标签栏**，单页全宽展示 Agent 模型管理与调用深度监控 | **彻底消除 Subtab 标签栏**，单页全宽展示 4 大虚拟聚合模型 (`chat`, `embedding`, `reranker`, `ocr`) |
| **EdgeOne 资产配置交互** | **极简 3 次点击胶囊流**（点选供应商胶囊 ➔ 点选 Key 胶囊 ➔ 点选模型胶囊 ➔ 保存，零键盘打字） | **极简 3 次点击胶囊流**（角色胶囊 ➔ 供应商胶囊 ➔ Key 胶囊 ➔ 推荐模型胶囊，零键盘打字） |
| **默认 Key 轮换策略** | **粘性故障转移 (`sticky_failover`)**：锁定当前激活 Key，遇 429 顺延切新 Key 并长期驻留 | **轮询负载均衡 (`round_robin`)**：原子计数轮询各 Key，最大化打散并发与利用 TPM 配额 |
| **模型暴露范围 (`/v1/models`)** | **仅返回 `agent_models` 中的真实模型列表**（绝不泄露虚拟模型） | **固定返回 4 个虚拟聚合别名** (`chat`, `embedding`, `reranker`, `ocr`) |
| **推理与思考链处理** | **100% 原始透传**：tools、reasoning_effort、思考链、SSE 流式字节原汁原味透传 | **强制禁用思考提速**：非流式极速返回纯净结果，入库速度提升 300% |
| **Anthropic 协议直通 (`/v1/messages`)** | **原生支持** (针对 MiniMax-M3, B.AI, Claude 官方 SDK 直通) | 知识库模式严格禁用 (返回 404) |
| **内存与运维策略** | 轻量常驻，底层断开 httpx 引用环与固定 mmap 阈值，无需重启，长连接会话 24h 不中断 | 零泄漏常驻，大图解析前置网络层限流准入与上游响应零拷贝，无需重启，入库任务平稳运行 |

---

## EdgeOne 凭据中枢与 VM 双轨凭据架构 (EdgeOne Vault Hub & Local Credential Sovereignty)

系统确立了“**本地存储为主权基石，中枢托管为增效辅助**”的双轨架构，既能统一享受 EdgeOne 中枢集中下发的厂商与密钥，又完全保留了各 VM 节点的本地自主控制权：

### 1. 职责与双轨机制
- **EdgeOne 凭据资产中枢 (Vault Hub)**：集中维护官方适配提供商与其拥有的 API Keys，支持脱敏清单分发与动态探测；中枢鉴权严格校验专用环境变量 `VAULT_ACCESS_TOKEN`（彻底物理剥离 `ADMIN_PASSWORD` 与 `PROXY_API_KEY`），完全实行物理级三权分立，金库接口仅限专用金钥访问；
- **VM 本地凭据自主管理 (Local Credential Sovereignty)**：
  - 完整保留「供应商与 Key 凭证库」管理面板（支持 A-Z 字母索引导航轨与分组标线）；
  - 支持随时在卡片上自主新增、编辑与删除本地专属 Key，变更直接持久化至 `proxy_config.enc`，绝不依赖或受制于中枢；
  - 模型配置弹窗内清晰区隔“本地已配置供应商”与“EdgeOne 凭据中枢托管”，并提供行内「+ 添加本地 Key」快捷入口。
- **Web 端免 `.env` 可视化配置与实时诊断**：
  - 在管理后台「系统设置」提供 Card 6「EdgeOne 凭据中枢连接与诊断 (Vault Hub)」；
  - 可视化填入中枢 URL 与 Token（密码可一键显隐），配置直接加密保存于 `proxy_config.enc`，**严禁修改或污染 `.env` 文件**；
  - 提供一键「测试中枢连通性」，实时诊断连通状态、网络延迟、供应商总数与 Google Key 列表；
- **全链路透明错误处理 (Zero Silent Errors)**：
  - 中枢 401（Token 与 EdgeOne VAULT_ACCESS_TOKEN 不匹配）、502（网络不可达）、504（请求超时）均向 Web 端输出透明友好的排查指引，杜绝任何静默吞错。
- **按需无感拉取与云端绝对权威覆盖 (Cloud Authority & Local Key Sovereignty)**：
  - **云端作为绝对真理源**：当从 EdgeOne Vault Hub 拉取凭据或执行同步时，云端配置无条件覆盖本地同名供应商的协议 (`protocol`/`protocols`)、思考开关 (`anthropic_messages`)、端点 (`base_url`/`anthropic_base_url`) 及适配规则 (`adapter_rules`)，彻底根治协议识别冲突；
  - **本地独有 Key 安全保留**：在覆盖供应商元数据的同时，智能合并密钥凭据字典，保留本地临时或独有新增的 Key，避免本地 Key 被误冲毁；
- **精准增量同步与本地凭据最高优先级保护 (Incremental Vault Sync & Local Key Sandboxing)**：
  - **精准增量落库 (`POST /api/admin/vault/sync`)**：杜绝全量强塞污染本地数据库。同步时严格仅增量同步当前本地已添加或已绑定模型/KB 的供应商，未配置的远端提供商绝不落库；
  - **本地自建 Key 绝对隔离与保护**：无论在 EdgeOne 还是 VM 端，在模型弹窗中点击「+ 添加本地 Key」录入的密钥均显式打上 `is_local: true` 标记。EdgeOne 中枢对外接口严格过滤防泄露；VM 执行中枢同步时，本地带有 `is_local: true` 的凭据享有最高保护，绝对不被中枢覆盖或清空。

### 2. 精准每 Key 速率限制与零开销保障 (Per-Key RPM Rate Limiter)
- **多 Key 免费额度精准压榨**：针对 AMD、InternLM（书生·浦语）等提供商的严苛 RPM 限制（如免费 Key 仅 2 次/分），在供应商及具体 Key 级别支持配置每分钟请求上限 (`rpm_per_key` / `rpm`)。
- **60 秒滑动窗口与无锁原子抢占**：在内存中维护精准到毫秒的滑动窗口，当单 Key 达到上限时自动顺延使用其他可用 Key，避免向上游超发请求触发 429；全部 Key 打满时以毫秒级极速响应 429 + `Retry-After`，防死锁并杜绝无谓重试堆积。
- **完全零开销原则**：未配置 RPM（留空或 0）时，系统完全零开销、不创建任何滑动窗口或定时器，保持原有高性能透传。
- **双端管理与无缝继承**：在 EdgeOne 凭据中枢与 VM 管理控制台均可直观配置与查看 RPM，支持 Key 继承供应商默认值或单独独立覆盖，界面全面禁用鼠标滚轮误触。

---

## OpenAI 零拷贝极速透传与纯净中转体系 (Zero-Copy Passthrough & Clean Proxy)

在 v2026.10.04-02 版本中，OCRProxy 针对 OpenAI 官方 API 及兼容中转进行了深度的性能重构与适配体系纯净化：

1. **OpenAI 零拷贝极速转发 (Zero-Copy Fast-Path)**：
   - **入站零反序列化**：当路由命中无需模型重命名的 OpenAI 原生中转时，直接获取客户端发送的原始二进制 `raw_bytes`，跳过 Python 层庞大的字典反序列化（对百 K 上下文或多模态 Base64 请求，彻底消除数十兆堆内存开销与 GC 停顿）；
   - **出站原生二进制直通**：以 `content=raw_bytes` 直接送入 HTTPX，同时在内存中保留一份二进制缓冲以支撑 429/5xx 故障转移（Failover）；
   - **非流式零序列化返回**：上游响应直接使用 `Response(content=resp.content, media_type="application/json")`，彻底跳过 `resp.json()` 解析与 `JSONResponse` 重编码；
   - **流式 SSE 零篡改直通**：彻底铲除全局 `_filter_chunk` 正则扫描，原始 TCP 字节流通过 `resp.aiter_bytes()` 直抵客户端，VM 仅做纯透明网络中继，CPU 占用率低于 0.5%。

2. **除 Gemini 外思考等级不转化原则 (Gemini-Only Transformation Rule)**：
   - 历史上对非标厂商硬编码的思考转化逻辑（如 MiniMax `minimax_adaptive`、阶跃星辰 `effort_remapping`、AMD 思考等级降级、B.AI GLM 强制转 high、Agnes `chat_template_kwargs` 等）**全部彻底铲除**；
   - 客户端发送的 `reasoning_effort` 保持原汁原味透传，上游返回的思考字段保持原始格式透传；
   - **唯一例外保留**：严格仅针对 Google AI Studio 与 Google Vertex AI 保留 `gemini_thinking_matrix`、思考预算自动提升以及 JSON Schema 深度清洗（剔除 Gemini 不支持的 `$schema` 与 `additionalProperties`）。

3. **Tool Choice 结构化原样支持**：
   - 全面关闭 DeepSeek、硅基流动、商汤、TokenRhythm、Cline 等预设中的 `normalize_choice_to_string` 强转 `"auto"` 行为；
   - 完整支持 Cursor、Cline 等现代 Agent 框架指定的精准结构化工具调用（`{"type": "function", ...}`）。

---

## 后端核心服务与厂商规则物理隔离架构 (Core Agnostic Engine & Declarative Rules Architecture)

在 `v2026.10.09-07` 版本中，OCRProxy 正式实施**后端核心服务与厂商规则绝对物理隔离架构**（见《架构标准规范》铁律十一）：

### 1. 核心网关引擎绝对“目中无人”
- **调度器 (`scheduler.py`) 纯粹性**：职责仅限于高可用轮询、429 限流冷却、ActiveKey 主备故障转移与并发槽位控制。**绝对不包含任何第三方厂商名称的硬编码**，彻底杜绝隐式凭据查找与跨厂商降级；
- **转发层 (`proxy_routes.py`) 通用性**：负责纯通用的 HTTP 请求生命周期管理与流式长连接保持；
- **管理后台 (`admin_routes.py`) 标准化**：负责通用配置存取与标准 HTTP 探活，杜绝厂商特判。

### 2. 彻底清偿 OpenCode Free 历史特化债务
- **剔除所有侵入性 Hack**：鉴于上游官方 Free Tier 强推客户端设备指纹并频繁变动规则，系统彻底剥离了 `_gen_opencode_session_id`、`_is_opencode_free`、桩工具注入、401/403 匿名回退等所有脏代码；
- **保留纯净标准版 `opencode`**：保留标准的 OpenCode 预设（纯净 OpenAI 协议直通，`https://opencode.ai/zen/v1`），仅供用户持有官方正规 API Key 时使用；
- **彻底杜绝代码发版绑定**：增删改任何厂商适配，100% 只在 Web 控制台界面或预设 JSON 中进行，**主服务代码 0 改动、0 重启、0 发版**！

### 3. 通用声明式规则与动态占位符机制 (Declarative Rules Contract)
若特定上游需要非标鉴权或动态头，无需修改一行主代码，直接在规则配置中声明：
- **声明式鉴权头**：配置 `auth_header: "x-custom-key"` 与 `auth_format: "Token {key}"`（默认 `Authorization: Bearer {key}`）；
- **动态占位符支持**：在 `inject_headers` 中声明动态占位符，引擎自动求值：
  - `${random_session_id}`：动态生成标准 CLI 会话 ID（如 `ses_4a...`）；
  - `${timestamp}`：当前 Unix 时间戳（秒）；
  - `${uuid}`：标准 UUIDv4；
- **通用参数裁剪与声明式思考约束**：声明 `strip_params`、`stream_only`、`reasoning.effort_map`（如将不支持的 `"none"` 映射为 `"low"`）、`reasoning.force_adaptive_thinking`、`reasoning.disallow_reasoning_split_false` 等通用参数即可，且 Anthropic `/v1/messages` 端点下自动保留 `output_config.effort`。

---

## EdgeOne 凭据中枢只读持久化与零明文安全架构 (Vault Persistence & Zero-Leak Security)

在分布式多节点架构中，为防止配置漂移与凭证泄露，OCRProxy 在 `v2026.10.09-01` 确立了**凭据中枢只读持久化与零明文密文安全规范**：

### 1. 中枢为唯一真理源 (Single Source of Truth)
- **绝对权威**：EdgeOne 边缘凭据中枢是所有供应商规范定义、路由规则和密钥凭据的最高权威中心；
- **来源追踪 (`origin: vault` vs `origin: local`)**：所有从中枢按需拉取或规则同步的数据，均打上不可篡改的 `origin: vault` 来源标记；

### 2. 本地持久化落盘与只读保护 (Read-Only Local Persistence)
- **离线容灾与秒级启动**：中枢下发的数据安全持久化落盘存储于 VM 本地（`proxy_config.enc`），**服务器重启、进程守护重启 100% 留存**，即使中枢网络中断，本地各模型调度代理依然高可用运行；
- **本地只读锁定**：对于 `origin: vault` 的条目，本地管理后台**强制锁定为只读**，严禁在本地篡改 Base URL、协议、密钥，禁止删除中枢供应商；所有中枢规则由中枢统领，本地仅支持一键同步更新覆盖；
- **本地自建独立自治**：仅用户手动在本地点击「+ 本地自建」创建的条目属于 `origin: local`，拥有完整的本地增删改查权限，且中枢同步绝不冲掉本地私有数据。

### 3. 零信任密文安全与反脱敏保真 (Zero-Trust Secret Vault & Fail-Safe Guard)
- **前端零明文 Key**：管理控制台的所有界面（模型卡片、Key 胶囊、Key 芯片、详情弹窗）**仅展示语义化标签名称（如 `🏷️ kanghongcan`、`🏷️ 大号`、`🏷️ 小号`）**，完全不展示真实密钥密文字符串；
- **后端 API 级脱敏拦截**：`GET /api/admin/config` 接口下发配置时，后端全局自动将所有 Key 替换为掩码（`●●●●●●●●`），浏览器审查元素与 Network 抓包绝不接触任何上游密钥；
- **保存强制反脱敏保真 (Fail-Safe Secret Guard · v2026.10.09-03)**：Web 控制台提交保存请求时，后端接口层与底层加密存储内核双重拦截掩码占位符，自动从磁盘现存配置中还原对应的真实有效密钥，物理杜绝掩码污染落盘；
- **安全服务端代理路由**：客户端发起请求时，VM 后端核心调度器直接在安全本地持久化文件中寻址真实密钥与上游通信，全流程实现密文闭环。

### 4. 单真理源统一 UI 架构 (Single-Source of Truth UI Architecture · v2026.10.09-06)
- **唯一样式与视图中心 (`shared/admin/`)**：彻底打破 EdgeOne 与 VM 各自维护两套 HTML/CSS/JS 的割裂状态。所有前端组件与视图逻辑以 `shared/admin/` 为唯一真理源，`build-admin.mjs` 自动同步编译下发至 `vm-app/static/` 与 `edge-functions/`；详见 [单真理源设计规范说明](file:///Users/xk/Documents/ocrprox/shared/docs/ui-single-source-design.md) 与 [核心架构铁律十](file:///Users/xk/Documents/ocrprox/ARCHITECTURE_STANDARDS.md)；
- **首页接入网关与模型展示卡片 100% 对齐**：两端统一使用清晰大方的三行横向卡片：
  1. Base URL（网关地址）与一键复制；
  2. 客户端凭据 (Client Key) 与一键复制；
  3. 可用模型胶囊标签（点击模型名即刻复制）+「复制全部模型名」与「管理全部模型」；
- **探活与连通性健壮性**：消除 ES6 TDZ（暂存死区）异常，补齐旋转动画 `.spinner` 样式，在 `finally` 块中加入强制复原兜底，确保测试按钮永不消失；
- **改动定位速查（严禁全局搜索查半天代码）**：
  * **骨架与卡片布局** ➔ [`shared/admin/admin.html`](file:///Users/xk/Documents/ocrprox/shared/admin/admin.html)
  * **样式、动画与设计 Token** ➔ [`shared/admin/admin.css`](file:///Users/xk/Documents/ocrprox/shared/admin/admin.css)
  * **网关渲染、复制助手与全局状态** ➔ [`shared/admin/js/core.js`](file:///Users/xk/Documents/ocrprox/shared/admin/js/core.js)
  * **模型卡片、Key 胶囊与连通性探活** ➔ [`shared/admin/js/agent-models-ui.js`](file:///Users/xk/Documents/ocrprox/shared/admin/js/agent-models-ui.js)
  * **供应商管理与中枢规则同步** ➔ [`shared/admin/js/providers.js`](file:///Users/xk/Documents/ocrprox/shared/admin/js/providers.js)
  * **系统设置与运行模式切换** ➔ [`shared/admin/js/settings.js`](file:///Users/xk/Documents/ocrprox/shared/admin/js/settings.js)
  * **生命周期入口与事件分发** ➔ [`shared/admin/js/app.js`](file:///Users/xk/Documents/ocrprox/shared/admin/js/app.js)
- **修改后的标准构建流水线**：
  ```bash
  # 1. 一键编译同步 (自动注入版本号与内联边缘函数)
  node agent-edgeone/scripts/build-admin.mjs
  # 2. 全量自动化回归门禁测试
  node agent-edgeone/scripts/test-units.mjs && python3 tests/test_secret_preservation.py && python3 tests/test_phase3_phase4_audit.py
  ```

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

### 1. 分流策略 (`agent_routing_strategy` & `kb_routing_strategy`)
在 Agent 智能体直连与 KB 知识库入库场景下，系统全面精简并收敛为最符合实际生产心智的策略组合：

#### Agent 智能体模式 (`agent_routing_strategy`)
- **`sticky_failover` (粘性故障转移 · 智能体推荐/默认)**：
  - 默认固定使用当前激活的主力 Key；
  - 仅当该 Key 触发 429 限流、5xx 服务端错误或网关连接超时时顺延切换至下一个候选 Key；
  - **切换后长期驻留新 Key**，杜绝多轮对话中的 Key 频繁抖动。
- **`manual` (纯手动直通模式 · 锁定 Key / 纯透传)**：
  - 由管理员在模型列表中手动指定激活某一个 Key（`active_key`），提供可视化状态与一键切换；
  - **单 Key 独占直通**：绝不自动切 Key、不自动轮询、不熔断；**受 120s 首字节与 300s 空闲超时的网络硬时钟全面保护**，原始状态码（200/400/401/403/429/500/502/504）与响应体 100% 原始透传，绝无死锁或无限挂死风险；
  - 后台设置面板自动灰化禁用重试次数、熔断与冷却参数。

#### KB 知识库模式 (`kb_routing_strategy` · v2026.10.16-03)
知识库批量入库场景（如 Dify、FastGPT 单次并发分发 50+ 个分块 chunk）与单路 Agent 对话具有本质区别。系统彻底废除造成单点打崩或饥饿的反模式（`sticky_failover` 会将 50 个 chunk 全砸向单 Key 触发 429，`priority_fallback` 导致备用 Key 长期饥饿，`latency_based` 因 chunk 大小抖动而剧烈失真），精简收敛为两大策略：
- **`round_robin` (轮询并发分流 · 知识库推荐/默认)**：
  - 原子计数无锁轮询各候选 Key，最大化打散高并发分块入库请求，平摊并充分利用各 Key 的 TPM/RPM 限额；
  - 遇到 429 或瞬态网络错误时平滑轮换到下一节点。
- **`manual` (纯手动直通调试 · 锁定首个节点单路直通)**：
  - 锁定第一个候选节点直接请求，不自动重试、不切换候选节点，原始状态码与错误信息 100% 原样透传；
  - 专供管理员在调试或排查新接入的 Embedding/Rerank/OCR 上游连通性与原始响应；
  - 后台设置面板自适应灰化重试与冷却输入。
- *(注：历史存量旧值 sticky_failover / priority_fallback / latency_based / random 均自动归一化收敛至 round_robin)*

### 2. 全局硬时钟预算与多层超时控制 (Timeout Budget & Fault Tolerance)
为保障智能体长思考模型稳定运行、并在遇到异常时实现精准快速恢复，OCRProxy 建立了**四层硬时钟防御体系**：

| 层级 | 防御机制 | 默认时限 | 说明与行为 |
| :--- | :--- | :--- | :--- |
| **第 1 层** | **TCP 建连超时** (`connect`) | **5 秒** | 上游域名无法解析、网络中断或机房不可达时，5s 内无法握手立即掐断，抛出 **`HTTP 502 Bad Gateway`**。 |
| **第 2 层** | **首字节 / 思考等待超时** (`read`) | **120 秒**<br>*(由 `agent_first_byte_timeout_sec` 控制)* | 请求发出后等待上游首包（含 reasoning 思考帧）。超 120 秒未返回即触发 `ReadTimeout`，抛出 **`HTTP 504 Gateway Timeout`**，彻底解耦 KB 与 Agent 超时。 |
| **第 3 层** | **流式块间空闲超时** (`stream_idle_timeout_sec`) | **300 秒** | 推流建立后，若上游突发静默中断，连续 300s 无新 token 自动截断并补发标准 SSE 错误帧；推流期间每 15 秒注入 `: keep-alive\n\n` 心跳防止客户端断开。 |
| **第 4 层** | **单请求全局硬时钟死线** (`total_budget_sec`) | **自适应 (上限 600s)**<br>*(manual 模式约 305s)* | 调度器单调时钟硬死线，无论发生何种重试或挂起，到达死线强行终结请求，彻底杜绝孤儿协程。 |

- **KB 双层极简时钟体系 (2-Tier KB Timeouts · v2026.10.16-03)**：
  - 彻底终结了历史版本中 7 个幽灵参数（`chat_fast_timeout`, `upstream_timeout_sec`, `upstream_timeout_chat`, `upstream_timeout_kb`, `upstream_timeout_ocr`, `upstream_timeout_embedding`, `upstream_timeout_rerank`）互相竞争覆盖的混乱局面，收敛为两层清晰时钟：
  - **快速入库处理超时 (`upstream_timeout_sec`)**：默认 **`15s`**。统管高频轻量的 **Chat 对话**、**Embedding 向量化** 和 **Reranker 重排序**，单次入库超时即切下一 Key，杜绝分块长时间卡死。
  - **大文件/OCR 处理超时 (`upstream_timeout_kb`)**：默认 **`60s`**。专供视觉 OCR 与多模态大图解析，提供充裕的计算时间。
  - 控制台保存时自动全向同步写入旧键名，保证 100% 向下兼容。
- **网关级传输错误规范化与自动重试头 (Gateway Statuses & Retry Headers · v2026.10.16-02)**：
  - 将底层网络传输异常（`ConnectTimeout`、`ReadTimeout`、`ConnectError`、`RemoteProtocolError` 等）统一规范化映射为 HTTP **`502 Bad Gateway`** / **`504 Gateway Timeout`**，并显式注入响应头 `x-should-retry: true` 与 `Retry-After: 1`；
  - 彻底改变以往直接抛 500 导致客户端彻底放弃重试的问题，使 Cursor、Claude Code、openai-python 等客户端能准确识别并自动发起无缝重试。
- **智能体粘性同 Key 级数退避重试 (Sticky Same-Key Backoff Retry · v2026.10.16-02)**：
  - 在 `sticky_failover` 模式下，当遭遇网关级瞬态错误（502/503/504/连接重置）且无备选 Key 时，在原 Key 上执行 1s、2s 级数退避重试（受 `agent_same_key_retries` 约束，默认最多 2 次），平滑应对跨国链路轻微抖动。
- **智能体独立首字节超时 (`agent_first_byte_timeout_sec` · v2026.10.16-01)**：默认 **`120s`**。Agent 模式独立首字节（含 reasoning 思考帧）等待超时，彻底解耦 KB 与 Agent 的超时时钟，废除按模型名猜测思考超时的硬编码逻辑，深度思考长推理模型（如 DeepSeek-R1 / V4.1-Flash）首包不再被提前掐断。
- **失效连接 5s 探测自愈窗口 (`_STALE_RETRY_WINDOW_SEC` · v2026.10.16-01)**：放宽至 **`5.0s`**，完美适配跨国链路 TCP RST 与 Cloudflare 偶发静默关闭时的自动重连，同时避免非幂等请求的盲目重试。
- **出站请求规范化 (v2026.10.16-01)**：HTTP 客户端默认注入 `User-Agent: OCRProxy/{version}`，流式推理自动注入 `Accept: text/event-stream`，避免被上游 CDN 或防火墙误判。
- **添加模型跨 Key 防重复绑定校验 (Model Binding Deduplication · v2026.10.16-01)**：在控制台添加或编辑模型时，智能检测同一提供商下是否已存在同名上游模型绑定，杜绝重复创建脏节点。
- **`request_total_budget_sec` (单次请求全局硬预算)**：
  - **动态自适应调度**：基于当前模式单次超时 `× max_retries` 智能自适应推导，硬上限全面放宽至 **`600s`**，彻底解除历史硬编码死线限制，完美兼容长思考多轮重试。
  - **EdgeOne 边缘版**：默认 **`300s`**。EdgeOne `fetch` 通过 `eo.timeoutSetting` 支持最长 300 秒出站超时（默认 15 秒，见腾讯云文档「边缘函数 Runtime APIs · Fetch」），边缘函数已显式设置，长思考模型可直接走 EdgeOne。
- **`stream_idle_timeout_sec` (流式空闲超时 · v2026.10.09-08)**：默认 **`300s`**。流式请求的**首字节**受单 Key 首字节超时约束（超时即 failover），流建立后上游静默（长思考、大段工具参数生成）在该时长内不会被截断。
- **`cooldown_404_sec` (404 候选冷却 · v2026.10.09-08)**：默认 **`600s`**。某候选返回 404（模型下架/路径不符）时继续 failover 到其它候选并冷却该候选；仅当存在备选候选时生效。
- **`kb_global_max_concurrency` (KB 全局并发阀 · v2026.10.09-08)**：默认 **`30`**，仅作用于 KB 类请求（KB chat / embedding / rerank / OCR），防大 base64 OOM；Agent 长流不占此阀，只受 `max_concurrency_per_key` 约束。uvicorn 连接上限可用环境变量 `UVICORN_LIMIT_CONCURRENCY`（默认 512）调整。
- **饱和 Key 智能秒切 (Saturated Key Fast Switch · v2026.10.09-09)**：并发槽已满的 Key 自动稳定排至候选末尾；当后续存在空闲候选时至多等待 1s 即刻尝试下一候选（首选 Key 满载无需白等 10s），仅当全部候选均满载时才等满 10s。
- **429 严格遵循 Retry-After (v2026.10.09-09)**：支持解析 HTTP 响应头中的 delta-seconds 与 RFC 1123 HTTP-date 格式。Agent 模式多候选时按 Retry-After 冷却该节点（上限 60s，单候选不冷冻）；KB 模式取 `max(cooldown_tpm_sec, Retry-After ≤ 300s)`。
- **中途断流 SSE 终结事件 (Mid-Stream Break Terminal Event · v2026.10.09-09)**：流式传输在发出首字节后若遭遇上游连接中断（无法再 failover），向客户端补发标准终止 SSE 错误事件（OpenAI 格式 `data: {"error":...}`，Anthropic 格式 `event: error`），按 502 记入统计并惩罚延迟权重，杜绝客户端收到被静默截断的内容。
- **KB/OCR 内存回收异步合并节流 (Coalesced Memory Reclaim · v2026.10.09-09)**：`gc.collect() + malloc_trim(0)` 改造为后台合并任务（并发最多 1 个、间隔 ≥2s、请求路径 0 毫秒阻塞），彻底消除入库高并发时的 GIL 争用卡顿。
- **物理级三权分立与凭据中枢加固 (Strict Three-Role Privilege Separation · v2026.10.09-10)**：EdgeOne 与 VM 端彻底移除 `ADMIN_PASSWORD` 兜底访问金库凭据的后门逻辑，`/api/vault/*` 仅且只能使用专用 `VAULT_ACCESS_TOKEN` 进行鉴权；首次登录成功立即自动渲染导航栏并加载模型预设目录。
- **国内 OTA 多源轮询与平滑升级加速 (Multi-Source OTA & CN Mirror Acceleration · v2026.10.09-11)**：后台更新检测引入多源轮询降级链（官方 GitHub ➔ 国内实时镜像 ghfast ➔ 全球 CDN jsDelivr），根除国内网络超时误报“已是最新”的假阳性缺陷；一键升级与 CLI 全链路支持国内镜像源高速下载源码。
- **`max_retries` / `schedule_total_budget` (单请求重试上限)**：默认 **`3 次`**。
- **`max_attempts_per_provider` (单厂商尝试上限)**：默认 **`2 次`**。
- **`fast_failover_provider_down` (跨厂商快速熔断)**：默认 **开启**。当上游厂商遭遇 502/504 或超时且存在其他备用厂商时，直接跳过该厂商所有剩余 Key，秒级切换至备用厂商。
- **429 欠费与额度耗尽 30 分钟智能冷冻 (Quota Quarantine)**：
  - 自动识别商汤 `Allocated quota exceeded`、OpenCode `Consumer daily free usage limit exceeded` 等致命账号级错误；
  - 触发后立即打入 **30 分钟（1800s）长效冷冻**，调度层物理跳过，杜绝废 Key 吃掉重试预算；控制台列表直接标注红色 `[欠费]` 徽章；
  - 成功调用（HTTP 200）即刻自动清除冷冻与欠费标记。
- **控制台极简纯键盘数字录入与即时保存体验**：
  - 彻底去除全端数字输入框原生的上下微调小箭头（Spin Buttons），还原极简纯净的纯键盘输入；
  - 表单支持输入框按 `Enter` 回车键或 `Ctrl/Cmd + S` 快捷键即时触发配置保存；
  - 面板底部配备常驻保存操作栏，统一收敛为单一明确的「💾 保存设置并生效」操作。

### 3. 链路追踪与透明诊断响应头
每次请求均在 HTTP 响应头中注入实时链路信息：
- `x-proxy-route`: 如 `stepfun/自己=ok` 或 `sensenova/测试=http_429->agnes/自己=ok`
- `x-proxy-attempts`: 如 `1` 或 `2`
- `x-proxy-latency-ms`: 如 `1870`

### 4. 统一声明式适配器管道 (Declarative Adapter Pipeline · v2026.10.04-02)
通过 `shared/presets/*.json` 纯声明式规则驱动，彻底消除各端代码中的硬编码 `if-else`：
- **除 Gemini 外思考等级不转化原则 (Gemini-Only Exception)**：
  - **OpenAI 官方中转**：配置为 `"strategy": "openai_passthrough"`，全链路原生二进制零拷贝 Fast-Path 直通；
  - **MiniMax / StepFun / AMD / B.AI / Agnes 等所有第三方厂商**：全面剔除历史硬编码重映射，客户端传入什么 `reasoning_effort` 档位（`none/low/medium/high`）就 100% 原样透传给上游，上游返回什么格式就原样透传给客户端；
  - **Google Gemini & Vertex AI (全站唯一适配例外)**：
    * **Thinking Matrix**：Flash 支持 `minimal/low/medium/high`，Pro 适配 `low/high`，`none` 映射为 `include_thoughts: false`；
    * **思考预算自动提升**：开启思考时若客户端设置的 `max_tokens` 过小（< 16384），自动提升至 65535，杜绝思考截断；
    * **Vertex AI 官方端点**：适配 OpenAPI 规范端点，自动消除 `/v1` 拼接错误，专属 `x-goog-api-key: <KEY>` 凭据头自动注入，模型自动规范化 `google/` 前缀；多轮工具调用自动保活 `thought_signature` 安全签名。
- **Tool Choice 结构化原生支持**：
  - 全面关闭所有预设中将对象形式强转为 `"auto"` 字符串的逻辑（`normalize_choice_to_string: false`）；
  - 完美支持 Cursor、Cline、Claude Code 指定的精细化单函数/多函数调用；
  - **Tool Schema 深度清洗 (Gemini 专属)**：递归剔除 Google 端点严格拒收的 `$schema`、`additionalProperties`、`$defs`、`$ref` 等非标字段。
- **流式 SSE 零篡改直通**：
  - 彻底删除流式响应层逐 chunk 正则扫描与字节篡改，原生 SSE 纯字节直通，消除打字机卡顿。

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
> **⚡ 依赖智能检测与秒级跳过 (Zero-Overhead Dependency Check)**：
> 脚本具备自适应依赖探查能力。若宿主机已具备满足要求的 Python 3.9+、venv 与基础工具链，将**完全跳过系统级 `apt-get` 流程**；若虚拟环境已满足依赖要求，将**直接跳过重复 pip 安装**。极大缩短首次安装与日常升级耗时，避免无谓网络开销与权限打扰。

#### 系统已注册全局运维命令 (`ocrproxy` CLI)

安装完成后，系统已自动注册全局便捷运维命令 `/usr/local/bin/ocrproxy`，并配置了细粒度免密运维白名单，**日常维护全程无需输入 root 密码**：

| 命令 | 说明 | 权限说明 |
| :--- | :--- | :--- |
| **`ocrproxy upgrade`** | 从 GitHub `main` 分支平滑就地升级，自动更新代码与依赖并自检 | **普通用户直接运行**（免 sudo 密码） |
| **`ocrproxy status`** | 查看当前 systemd 服务运行状态与端口监听 | 普通用户直接运行 |
| **`ocrproxy log`** | 实时追踪服务运行日志（等同 `journalctl -u ocrproxy -f`） | 普通用户直接运行（Ctrl+C 退出） |
| **`ocrproxy restart`** | 优雅平滑重启服务 | **免密重启**（已配置极窄 sudoers 白名单） |
| **`ocrproxy uninstall`** | 安全卸载服务（支持交互确认并归档备份配置） | 支持 `--keep-config` 保留密钥数据 |

#### 常用运维指令速查表 (Cheat Sheet)
> 完整运维手册、Caddy/Nginx 配置与常见排错指南请参阅 👉 [《OCRProxy 常用运维指令与管理手册》](docs/OPERATIONS_GUIDE.md)。

| 运维场景 | 一行执行指令 | 场景说明 |
| :--- | :--- | :--- |
| **切换为反代模式** | `sudo sed -i 's/^APP_HOST=.*/APP_HOST=127.0.0.1/' /opt/ocrproxy/.env && ocrproxy restart` | 仅监听 127.0.0.1，阻断外网裸连，配合 Caddy/Nginx |
| **切换为直通模式** | `sudo sed -i 's/^APP_HOST=.*/APP_HOST=::/' /opt/ocrproxy/.env && ocrproxy restart` | 恢复公网 IPv4/IPv6 全网直通，支持 IP 直接访问 |
| **一键平滑升级** | `ocrproxy upgrade` | 1 秒从 GitHub 就地拉取更新，配置密钥 100% 保留 |
| **查看当前密码** | `grep ADMIN_PASSWORD /opt/ocrproxy/.env` | 快速查看 Web 管理控制台登录密码 |
| **查看接入 Key** | `grep PROXY_API_KEY /opt/ocrproxy/.env` | 快速提取客户端 OpenAI 调用密钥 |
| **修改监听端口** | `sudo sed -i 's/^APP_PORT=.*/APP_PORT=9090/' /opt/ocrproxy/.env && ocrproxy restart` | 将服务端口调整为 9090 (可自定义) |
| **查看实时日志** | `ocrproxy log` | 实时跟踪服务请求与排错 (按 Ctrl+C 退出) |
| **服务状态与健康** | `ocrproxy status` | 检查进程存活、内存占用及监听端口 |

#### Web 管理端在线检测与 OTA 一键升级 (Web OTA Upgrade)
除了命令行 `ocrproxy upgrade` 外，VM 管理后台（「⚙️ 系统设置」 -> 「4. 故障避让与系统运维」）提供了原生 **「程序版本在线检测与 OTA 升级」** 能力：
- **实时比对**：自动或手动静默对比本地版本与 GitHub 官方最新发行版本（遵循 `vYYYY.MM.DD[-NN]` 命名规范）；
- **一键更新**：点击「一键在线平滑升级」后，系统将在后台自动拉取最新代码并平滑重载 systemd 守护进程，5~10 秒内自动恢复，**所有配置、Key 与环境变量 100% 保持无损**。

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
  OCRProxy 一键部署与管理中心 (v2026.10.07-01)
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
2. 生成加密主密钥并创建通用初始配置文件 `/opt/ocrproxy/config/proxy_config.enc`；
3. 注册 `/usr/local/bin/ocrproxy` CLI 管理命令与 `/etc/sudoers.d/ocrproxy` 免密运维白名单；
4. 安装完成友好打印：本地运行端口、网络监听模式、Web 管理后台默认密码、大模型接入 API Key、Caddyfile 反代推荐配置样例（`flush_interval -1` 无缓冲适配 SSE）、常用运维命令；
5. 支持随心平滑升级：运行 `ocrproxy upgrade` 或再次执行安装命令，即刻就地无损升级。

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
> 7. **云端真理源绝对权威覆盖**：当从云端拉取配置时，供应商协议、端点与适配规则必须 100% 以 EdgeOne 为绝对真理源覆盖本地，杜绝本地历史脏数据反噬；
> 8. **前端打包原子完整性与零崩溃门禁**：构建脚本必须强制对核心生命周期函数（`renderAgentModels`、`saveAgentModel` 等）执行 Fail-Fast 编译强断言，严禁遗漏任何公共组件，杜绝因未定义函数直接将用户死锁在登录页之外；
> 9. **双凭据统一鉴权防死锁**：全端管理接口（`/api/config`、`/api/vault/*` 等）必须同时无缝兼容 `ADMIN_PASSWORD` 与 `PROXY_API_KEY`，严禁代码与配置规范脱节造成鉴权拦截死锁；
> 10. **UI 单一真相源与方案 A 严格沉浸式规范**：VM Worker 控制台纯以模型为中心，严禁暴露「供应商与 Key 凭证库」二级子 Tab；所有 Agent 模型逻辑严格由 `agent-models-ui.js` 唯一定义并作为单一真相源，彻底杜绝双重实现覆盖与命令式 DOM 破坏性覆盖。

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

### 5. 流生命周期租约与并发流治理 (ConcurrencyLease & Stream Backpressure)
- **并发租约全生命周期锁定 (`ConcurrencyLease`)**：流式响应建立后，调度器将信号量（Key 并发信号量与全局限额信号量）的释放权安全交接给 `StreamingResponse`。在流式传输完整结束或客户端断开连接之前，租约持续生效，彻底根治流式响应首包返回即释放信号量导致并发失控与 OOM 的历史隐患。
- **单调硬时限控制 (Monotonic Hard Deadline)**：废除 1.5x 动态预算上浮，调度器以 `time.monotonic()` 建立不可篡改的硬性 Deadline；单候选请求超时受限于剩余预算；并发排队等待引入超时保护，超时快速切换至下一候选节点。
- **EdgeOne 流式背压规范与首块预读 (Chunk Peeking)**：
  - `createKeepAliveStream` 彻底废除 `while(true)` 无限循环，重构为符合 Web Streams 规范的标准 `pull(controller)` 按需驱动模式，当下游消费缓慢时自动停止拉取，背压完全生效；
  - 边缘流式转发集成首块预读（Chunk Peeking）：在返回响应给下游前先预读第一包数据，若上游返回 HTTP 200 但立即断连发送 0 字节，边缘节点捕获后主动判定为 `empty_stream` 并触发下一个候选节点 Failover，杜绝向客户端吐出空流。

### 6. EdgeOne Marks 与 VM 双端统一日志体系与安全脱敏 (Unified Logging & Zero Secret Leakage)
- **双端标准事件标签 (Unified Event Tags)**：EdgeOne 边缘函数（腾讯云 Serverless V8）与 VM 服务端（FastAPI / Uvicorn）在严重错误与关键审计事件中采用完全对齐的标准标签：
  - `[AuthError]`：密码错误、客户端 Key 无效、Vault 越权、缺少必需环境变量 (503/401/403)；
  - `[AuthBlocked]`：触发防暴力破解 IP 临时封禁；
  - `[ConfigError]` / `[KVError]` / `[DiskError]`：配置校验失败、乐观锁版本冲突 (409)、存储读写异常；
  - `[ProbeWarn]`：管理员探活 Key / 测试模型失败（上游返回 400/401/404/5xx 或连接超时）；
  - `[CircuitBreaker]`：上游 Key 遭遇 429 限流或 5xx 熔断冷却；
  - `[FailoverExhausted]`：所有候选节点重试全部耗尽；
  - `[ConfigAudit]`：配置成功保存并持久化。
- **Zero Secret Leakage 安全脱敏守卫**：
  - 双端日志模块（`agent-edgeone/edge-functions/lib/logger.js` 与 `vm-app/app/logger_utils.py`）内置严格脱敏过滤器；
  - 密钥统一输出别名或掩码（如 `sk-20e7****fcb3`），密码与 Token 一律为 `[REDACTED_SECRET]`，绝对禁止明文泄露至日志流；
  - 严格遵守 EdgeOne 单条日志 4KB 长度限制，长文本自动截断。

---

## 开发者与 AI Agent 快速上手指南 (Developer & Agent Onboarding Guide)

如果您是一名新加入的开发者或 AI Coding Agent，请**严格遵守以下准则开展工作**：

### 1. 核心目录与开发职责速查

| 目录 | 职责与作用 | 正确修改方式 | 绝对禁止项 |
| :--- | :--- | :--- | :--- |
| **`shared/admin/`** | 前端控制台唯一真理源 | 修改其中的 HTML、CSS 或 `js/*.js`，修改后执行 `node agent-edgeone/scripts/build-admin.mjs` 编译 | ❌ **严禁直接修改** `vm-app/static/admin.html` 或 `agent-edgeone/admin.html`！ |
| **`shared/presets/`** | 13 大官方厂商适配规则真理源 | 修改对应厂商的 `.json`，修改后执行 `node agent-edgeone/scripts/build-presets.mjs` 编译 | ❌ **严禁直接在代码中**硬编码 `if provider == "xxx"`！ |
| **`vm-app/`** | 服务端核心 Python 架构 (FastAPI) | 调度器 (`scheduler.py`)、API 路由 (`proxy_routes.py`)、加密配置 (`config_store.py`) | ❌ **严禁破坏** OpenAI 零拷贝 Fast-Path 二进制直通架构！ |
| **`agent-edgeone/`** | Serverless 边缘函数 (Node.js) | 边缘转发 (`completions.js`)、参数清洗 (`normalize.js`)、构建打包脚本 (`scripts/`) | ❌ **严禁将静态预设**写入 EdgeOne KV（KV 仅存用户私有密钥和路由）！ |
| **`tests/`** | 全量质量保障与模型准入测试套件 | 包含 6 维度准入套件、单元测试与离线断言，详细规范参见 [`tests/README.md`](file:///Users/xk/Documents/ocrprox/tests/README.md) | ❌ **严禁不做测试**就直接提交发版！ |

### 2. 接手开发三大铁律 (Three Golden Rules)
1. **前端真理源铁律**：所有 UI/交互变更必须在 `shared/admin/` 下进行，编译产物自动分发至各端；
2. **纯净透传铁律 (Gemini-Only)**：除 Google Gemini / Vertex AI 外，所有厂商的思考等级（`reasoning_effort`）与 `tool_choice` 结构体必须 100% 原汁原味透传，严禁擅自引入非标思考转换；
3. **模型上线准入铁律**：新适配任何模型后，必须执行自动化准入套件并取得通过：
   ```bash
   python3 tests/test_live_models_suite.py --model <新模型名>
   ```
   **必须 6 大维度 100% 通过（【🟢 生产可用 · 达到正式上线标准】）后方可放行**。

---

## NVIDIA NIM 官方平台深度适配与流式加固 (NVIDIA NIM Defensive Hardening)

系统已原生内置 **NVIDIA NIM (Inference Microservices)** 官方加速平台标准预设，并针对其实机特性与社区已知痛点完成了工程化加固：
1. **精选官方推荐模型（避开 404 权限黑洞）**：
   - 官方目录虽然返回 80+ 个模型，但实测有 55 个模型在普通开发者 Key 下会报错 404 (`Function not found for account`)；
   - OCRProxy 精选收录实测 100% 可用的优质模型：`meta/llama-3.2-11b-vision-instruct`（极速出字 <800ms，支持图文与函数调用）、`nvidia/nemotron-3.5-lightning-30b-a3b`（官方自研闪电推理模型）、`nvidia/nemotron-3-ultra-550b-a55b`（550B 超大规模模型）；
2. **流式主动嗅探与即时断流 (`data: [DONE]` Active Termination)**：
   - 彻底修复 Nemotron 等推理模型在发送完 `data: [DONE]` 后底层的 HTTP Chunked 连接不主动发 EOF、导致网关卡住等待 30 秒超时的固有缺陷；
   - 网关 SSE 事件管道在检测到 `[DONE]` 标记后立即产生终止信号并主动释放底层 TCP 连接，实现秒级流式结束；
3. **函数调用类型容错 (Tool Calling Arguments Sanitization)**：
   - 在响应后处理层对 `tool_calls[].function.arguments` 是非字符串对象的情况自动兜底 `json.dumps` 修复，防止客户端反序列化崩溃。

### 3. 日常开发常用命令速查

```bash
# [前端构建与门禁] 修改 shared/admin 后，一键执行双重门禁校验并重新编译管理后台
npm run build:admin

# [符号门禁] 静态编译 JS 并严格扫描核心交互函数声明（严禁未定义符号逃逸）
npm run check:symbols

# [冒烟门禁] 模拟浏览器 DOM 环境执行登录与全生命周期交互自动化冒烟
npm run test:ui

# [预设] 修改 shared/presets/*.json 后，一键重新编译内置预设与更新 catalog.json
node agent-edgeone/scripts/build-presets.mjs

# [单元测试] 验证适配器纯净透传与 OpenAI 零拷贝 (24 项断言)
python3 tests/test_adapter_audit_suite.py

# [边缘测试] 验证 EdgeOne 适配器规则与 rawBytes 透传 (10 项断言)
node tests/test_edgeone_normalize.mjs

# [准入测试] 对指定模型执行全量 6 维度生产级自动化准入测试
python3 tests/test_live_models_suite.py --model gemini-3.5-flash-lite

# [发版审计] 运行全平台发版硬性门禁测试套件
python3 tests/test_phase3_phase4_audit.py

# [发布更新] 提交到 GitHub 后，VM 服务端一键 OTA 平滑升级
ocrproxy upgrade   # 或在管理后台「系统设置」点击一键平滑升级
```

---

## 规范体系、迭代发版与安全质量红线

所有版本发布、特性迭代与安装脚本修改必须严格遵守官方三大核心规范体系：
1. **[《OCRProxy 核心架构规范与开发铁律》](ARCHITECTURE_STANDARDS.md)**：包含生产环境三套拓扑分工、单真理源 UI 开发铁律、核心服务与厂商规则绝对物理隔离铁律等十二大开发铁律；
2. **[《OCRProxy 官方安全架构规范与红线标准》](docs/SECURITY_SPEC.md)**：确立物理级三权分立鉴权矩阵、Fail-Closed 默认拒绝、SSRF 深度防御、恒定时间比对、反脱敏保真与代码库零秘钥铁律；
3. **[《OCRProxy 迭代发版规范与红线标准》](docs/RELEASE_SPEC.md)**：执行版本号 6 处全网联动、安装脚本 100% 零漂移、以及包含安全测试在内的全量自动化测试 100% 守门发版 Checklist。

---

## 最新版本更新记录 (Release Notes)

### `v2026.10.16-02` (2026-10-16)
- **网关级传输错误规范化与自动重试头 (PR #9)**：
  - 将底层网络传输异常（`httpx.ConnectTimeout`、`httpx.ReadTimeout`、`ConnectError`、`RemoteProtocolError` 等）统一规范化映射为 HTTP **`502 Bad Gateway`** 与 **`504 Gateway Timeout`**，并自动注入响应头 `x-should-retry: true` 与 `Retry-After: 1`；
  - 彻底改变以往直接抛 500 导致客户端（Cursor、Claude Code、openai-python 等）放弃重试的问题，使客户端能够按标准进行无缝重试；
- **智能体粘性同 Key 级数退避重试 (Sticky Same-Key Backoff Retry)**：
  - 在 `sticky_failover` 模式下，当遭遇网关级瞬态错误（502/503/504/连接重置）且当前无其他备选 Key 时，在原 Key 上先执行 1s、2s 级数退避重试（受 `agent_same_key_retries` 约束，默认最多 2 次），平滑应对跨国链路轻微抖动，避免直接向客户端抛错；
- **Agent 路由策略全面收敛精简**：
  - 管理后台与调度器将 Agent 路由策略全面精简为两大最符合实际心智的选项：`sticky_failover` (粘性故障转移 · 智能体推荐) 与 `manual` (纯手动直通模式 · 锁定 Key / 纯透传)；
  - 澄清 `manual` 直通模式行为：单 Key 独占直通，不切 Key、不重试、不熔断，但受 120s 首字节与 300s 空闲超时的网络硬时钟全面保护，绝无无限挂起风险。

### `v2026.10.16-01` (2026-10-16)
- **解耦 Agent 首字节超时与 KB 超时**：
  - 新增 `agent_first_byte_timeout_sec`（默认 120s），彻底废除按模型名猜测思考超时的硬编码逻辑，深度思考长推理模型（如 DeepSeek-R1、V4.1-Flash）首包不再被提前掐断；
  - 彻底解耦 KB 入库短超时（`upstream_timeout_sec` 15s）与 Agent 推理长超时，两者互不影响；
- **失效连接 5.0s 探测自愈窗口**：
  - 将 `_STALE_RETRY_WINDOW_SEC` 放宽至 5.0s，完美适配跨国链路 TCP RST 与 Cloudflare 偶发静默关闭时的自动重连，同时避免非幂等 POST 请求的盲目重试；
- **出站请求标准化**：
  - HTTP 客户端默认注入 `User-Agent: OCRProxy/{version}`，流式请求默认注入 `Accept: text/event-stream`，避免被上游 CDN 或防火墙误拦截；
- **模型跨 Key 防重复绑定校验**：
  - 控制台新增或编辑模型时，智能检测同一提供商下是否已存在同名上游模型绑定，杜绝重复创建脏节点。

### `v2026.10.13-01` (2026-10-13)
- **MiniMax 预设升级至 v1.4.0**：
  - 新增声明式 `effort_map` (将不支持的 `"none"` 映射为 `"low"`)；
  - 引入双协议自适应思考规则，完美兼容 Anthropic (`/v1/messages`) 与 OpenAI 思考参数，保障长上下文生成稳定性。

### `v2026.10.12-02` (2026-10-12)
- **上游 410 模型下线识别（借鉴 freellmapi #1421/#1423）**：上游返回 HTTP 410 Gone 时，VM 调度器把 `provider:model` 标记为永久下线（默认 24 小时，设置项 `cooldown_410_sec`，设为 0 关闭），同一厂商下所有 Key 一并跳过，客户端点名该模型也不再撞上游；Agent / KB 模式与 manual 策略均生效；
- **重载不复活**：下线标记在 `/v1/reload` 和配置热重载后保留，只有该厂商模型从配置中移除或到期才清除；冷却列表新增 `is_gone` 字段；
- **全部下线直接 410**：某模型全部候选都已下线时直接返回 410 与明确提示，替代原先误导性的 “请几秒后重试” 503；
- **EdgeOne 对称对齐**：410 时把同厂商同上游模型的所有 Key 写入 24 小时 KV 冷却，并返回 410 中文提示；
- 新增 `vm-app/scripts/scheduler_410_test.py` 回归测试与 EdgeOne 单元测试。

### `v2026.10.12-01` (2026-10-12)
- **上游非 JSON / HTML 报错智能清洗与 OpenAI 规范对齐**：彻底解决上游服务商（如 OpenAgents、Cloudflare、Nginx）在遇到 413 请求体超限或 502/504 网关异常时直接返回原始 HTML 网页导致客户端 AI 插件（Cursor、Cline 等）反序列化崩溃的问题；通过 `clean_upstream_error_text` 智能提取 `<title>` 与核心错误语义，自动清洗 HTML 标签，返回符合 OpenAI 标准规范的 JSON 错误体（`error.type="invalid_request_error"`, `error.code="request_too_large"`）；
- **413 Payload 超限快速熔断机制 (Fast Failover Short-Circuit)**：在调度器中针对 413（请求体过大）这一不可通过换 Key 恢复的错误进行特化处理，自动将该 provider 标记为 down 并跳过同 provider 其他 Key 的无意义重复尝试，无其他可用跨厂商节点时快速熔断返回客户端，大幅缩减超时等待时间；
- **调度报错结构化净化**：清洗后的错误描述统一写入 `stats.error_logs` 与控制台日志，杜绝原始 HTML 源码污染后台仪表盘与 journald 系统日志；
- **EdgeOne 边缘函数错误响应对称对齐**：同步升级 EdgeOne 端的非 JSON 错误清洗与 413 描述规范，确保多端体验完全一致。

### `v2026.10.11-06` (2026-10-11)
- **EdgeOne 客户端凭据与管理员密码物理隔离**：彻底根除 EdgeOne 首页「接入网关与可用模型」卡片误读 `getKey()` 导致客户端 API Key 读成 Web 登录密码的缺陷；重构为独立 `getClientKey()` 函数，后端 `/api/config` 自动回填 EdgeOne 环境变量 `PROXY_API_KEY`，在全局设置面板新增 `PROXY_API_KEY` 可视化配置与一键复制，彻底隔离后台管理密码与客户端凭据；
- **紧急修复登录界面函数丢失致命 Bug**：彻底根除 `TypeError: loginErr is not a function`，在 `shared/admin/js/core.js` 补回防御式健壮的 `function loginErr(m)`，彻底解决 DOM `<div id="loginErr">` 挂载为 `window.loginErr` 导致的函数覆盖与登录阻断缺陷；
- **全流程三重机械化发版门禁 (Release Quality Gates)**：
  - **Gate 1 (静态符号契约扫描)**：引入 `agent-edgeone/scripts/verify-frontend-symbols.mjs`，通过 Node `node:vm` 硬编译全量 JS，严密扫描所有核心交互函数契约，未声明符号立即阻断构建；
  - **Gate 2 (运行时 DOM 冒烟门禁)**：引入 `agent-edgeone/scripts/test-ui-smoke.mjs`，构建具有真实浏览器属性（含 DOM ID 全局挂载特性）的沙箱环境，真实运行并冒烟验证登录、错误提示、凭据清理全生命周期；
  - **Gate 3 (构建与测试强阻断)**：将上述门禁强制绑定进 `npm run build:admin` 与 `npm test`，任何语法错误或符号缺失直接 `exit 1` 阻断打包与 CI；
- **日志与中间件性能深度优化 (贯彻日志审查意见)**：
  - 彻底移除定时重启移除后遗留的无用 `in_flight_tracking_middleware`；
  - 新建 `vm-app/app/middleware.py` 将安全响应头改写为纯 ASGI 中间件，消除 `BaseHTTPMiddleware` 开销，SSE 延迟降至 2.4ms 级原生性能；
  - 修复 KB 错误折叠时候选节点状态与延迟更新被跳过的缺陷，并在前端日志卡片如实渲染折叠计数徽章 (`repeat_count`)；
  - 引入 Key 错误滑动窗口聚合折叠，防止 `round_robin` 下多 Key 交替报错刷爆 100 条日志上限；
  - 将调度器内部候选尝试、冷却跳过等高频流转日志统一降级为 `DEBUG` 级别。

### `v2026.10.11-05` (2026-10-11)
- **根除探活假阳性放行 Bug**：彻底重构 EdgeOne 与 VM 端的 `probeKey` 及 `verify-key` 探活判定逻辑，严格限定仅 HTTP 2xx 返回为通过，严禁将 HTTP 400 (Bad Request) 或 404 (Not Found) 误判为鉴权成功；当上游返回非正常状态时如实呈现状态码与具体失败原因；
- **前端加载与渲染容错死锁防护**：为 `renderAll` 各子面板包裹异常安全边界，防止任一局部脏数据阻断主应用启动；登录遮罩层新增「清除本地登录缓存并刷新」一键重置按钮，彻底消除凭据失效导致的遮罩死锁；
- **边缘端配置持久化自愈与孤立绑定清理**：在 `saveConfig` 中新增孤立绑定自动修剪机制，当删除供应商凭据时自动从 `agent_models` 中剥离孤立关联，防止校验冲突或页面异常。

### `v2026.10.11-04` (2026-10-11)
- **控制台设置面板 DOM 闭合与卡片规范对齐**：修复 Card 4 (容灾运维) 网格容器闭合标签缺失导致的层级塌陷缺陷，彻底根治 OTA 升级与重启横栏被挤压为两列网格以及 Card 5、Card 6 被错误吞噬嵌套进 Card 4 的排版异常；
- **各设置卡片独立容器层级恢复**：恢复 Card 1~Card 6 单卡同级独立规范，使控制台布局回归标准扁平、清晰规范的视觉呈现；
- **自动化 HTML 标签平衡语法门禁**：新增 `test_admin_html_tag_nesting_and_balance` 单元测试，在每次构建和单测执行时自动检验全站 HTML 标签开闭配对，杜绝标签错位流向生产。

### `v2026.10.11-03` (2026-10-11)
- **PR #7 合并 (OCR 上游请求体异步流式零拷贝)**：采用 JSON 外壳占位符预序列化 + 图片 Base64 字符串按 256KB 切片异步流式发送机制 (`_ReplayableBody`)，显式携带 `Content-Length` 保持标准 HTTP 传输协议（非 chunked），彻底免去大图 data URL 组装与 `httpx` `json.dumps/encode` 两份巨型内存拷贝。遇到故障切换 (Failover) 或重试时可多次安全复用，并发压测峰值内存再降 33%；
- **入站 JSON 字节直读优化**：`_parse_json_body` 直接使用 `json.loads(body_bytes)` 反序列化入站请求体，跳过冗余 `bytes()` 转换与临时解码字符串，入口立减一份 body 级堆缓冲；
- **管理端 OCR 准入参数可视化配置**：系统设置新增「OCR 同时处理图片数 (`ocr_max_inflight`, 默认 6)」与「OCR 排队最长等待 (`ocr_queue_timeout_sec`, 默认 30s)」，支持可视化灵活调节限流并发与排队超时时长；
- **模式自适应界面隔离**：OCR 准入参数控件仅在 KB 知识库模式下自适应展现，Agent 智能体模式保持纯净隐藏；
- **完备的转义与重写安全兜底**：若图片 Base64 包含需 JSON 转义字符或上游适配规则变更占位符位置，平滑退回原生 dict 格式发送，100% 确保请求正确性。

### `v2026.10.11-02` (2026-10-11)
- **PR #6 合并 (httpx 响应流环状引用彻底解除)**：针对 httpx 将 `BoundAsyncStream` 反向绑定回自身导致 `request._content` (10~20MB Base64 大图或超长文本) 滞留于第 2 代 (Generation 2) 循环垃圾池的问题，实现 `release_httpx_response(resp)` 在响应消费后立即解构流绑定，使巨型请求体对象直接由 Python 引用计数即刻物理归还系统，彻底解决长时间大图/长文本推理内存居高不下的真凶；
- **大图 OCR 解析并发准入控制**：新增 `_ocr_semaphore` (默认 6 并发)，在读取 Request Body 前对入站 OCR 请求进行信号量限流，将并发请求缓冲在 uvicorn 网络层 (仅占 64KB socket 缓冲)，彻底消除并发上传导致的上 G 级堆内存冲顶，超限提供 503 + Retry-After 优雅排队保护；
- **固定 glibc mmap 阈值为 128KB**：启动时调用 `mallopt(M_MMAP_THRESHOLD, 128KB)` 锁定分配阈值，强制所有 >=128KB 的图像与字符缓冲区由系统独立 `mmap` 分配，在解引用时直接通过 `munmap` 将物理内存页秒级归还 Linux 内核，杜绝堆内存碎片；
- **OCR 上游响应零拷贝直接透传**：上游识别结果直接以 `raw_content` 透传，移除冗余的 `json.loads` 反序列化与二次 `JSONResponse` 包装，节约两份大内存拷贝；
- **全面废除定时重启功能 (KB 与 Agent 彻底取消)**：鉴于内存泄漏与碎片已在底层物理根治，系统长时间运行内存平稳归零，彻底移除 KB 与 Agent 模式下的每日定时重启进程、配置项及前端控制台面板，保持业务会话与入库长久连续稳定。

### `v2026.10.11-01` (2026-10-11)
- **定时平滑重启时间自定义配置**：系统设置支持任意指定每日自动重启的具体时间点 (`auto_restart_time`, HH:MM 格式)，并在前端控制台提供原生时间选择器与开关动态联动；
- **按需轻量调度 (零常驻开销)**：未开启或未配置定时重启时，绝对不启动任何后台定时协程与工作任务，彻底杜绝无用常驻进程对 CPU 和内存的无端占用；
- **智能优雅平滑退避重启**：到达设定重启时刻后，系统自动检测在途 (in-flight) `/v1` 代理长连接，优先等待正在进行的代码补全与长文本生成完毕（最长缓冲等待 30 秒）再安全释放进程，彻底避免在 Agent 工作正酣时强行掐断会话；
- **进程与 Systemd 联动自愈**：优雅退出后由宿主机 systemd (`Restart=always`) 秒级拉起全新纯净进程，彻底清零堆内存碎片，实现无感平滑自愈。

### `v2026.10.10-01` (2026-10-10)
- **调度器首包真内容判定 (First-Payload Detection)**：流式响应自动缓冲前导帧 (role-only delta, `: keep-alive`, usage-only 帧, Anthropic message_start / ping) 直至首个真实有效负载到达才向客户端提交。捕获上游 200 in-band 错误帧并自动透明 failover 至下一个候选节点，彻底根除上游返回 200 包含错误内容导致客户端崩溃的假 200 缺陷；
- **空回复与断流自动切换**：流式响应未产生任何实际内容即结束时自动触发故障转移；非流式 2xx 但仅包含 error 对象的响应同样自动切换至备用节点；
- **Agent 阶梯冷却与同网关熔断**：首包超时耗尽或连接失败按 30s -> 2min -> 10min 阶梯冷却（请求成功一次立即清零），遇到 502/503/504 网关故障时自动优先跳过同厂商其他 Key 尝试其他可用厂商；
- **免费提供商生态扩充与更新**：
  - 新增 **OpenRouter** (`openrouter.json`) 官方预设：收录 7 大热门免费模型 (`:free`) 与 OpenAI/Anthropic 双端点，支持 429 故障转移与 402 余额耗尽识别；
  - 升级 **NVIDIA NIM** (`nvidia.json` v2.0.0)：更新至最新免费模型矩阵，完善未激活 (404) 与免费配额超限 (403/429) 的自动切换策略；
  - 升级 **OpenCode Zen** (`opencode.json` v2.0.0)：精简免费模型集合，适配免费层级 403/429 判定规则；
- **可观测性与标准协议增强**：所有代理请求增加 `X-Fallback-Trail` 诊断追踪响应头；全节点冷却时返回标准 HTTP `Retry-After` 头部。

### `v2026.10.09-14` (2026-10-09)
- **Gemini 思考签名与工具调用支持**：在 VM 执行器中集成 `gemini_compat.py`，通过在 `tool_call_id` 中以 `{id}:::{signature}` 无状态携带与还原 `thought_signature`，并配合 LRU 缓存与 `skip_thought_signature_validator` 双重兜底，彻底解决 Gemini 3 在 Cursor / Cline 等 OpenAI 客户端中多轮工具调用报 400 崩溃的缺陷；
- **Vertex AI 思考标签流式分离**：实现 `_ThoughtSplitter` 跨 chunk 状态机与非流式拆分，将 Vertex AI 返回的 `<thought>...</thought>` 抽取至 `reasoning_content`，正文保留在 `content`，与客户端思考折叠无缝贴合；
- **官方预设规则对齐**：补齐 MiniMax-M3.1-Flash-Preview 预设与大小写映射；商汤日日新 / Agnes 启用 Anthropic Messages 直通；更新 Google 推荐模型为 3.8 Flash / 3.5 Flash / 3.1 Pro / 2.5 系列；
- **严格厂商隔离与零拷贝保护**：Gemini 执行器仅对 `reasoning.strategy == "gemini_thinking_matrix"` 候选生效，非 Gemini 候选节点与零拷贝 fast-path 保持 100% 原始透传，EdgeOne 与 KB 模式保持纯净零影响。

### `v2026.10.09-13` (2026-10-09)
- **修复 systemd-run 非法参数**：彻底移除 `install.sh` 生成 CLI 中的 `--remain-after-exit=no` 非法参数并引入 `--collect` 机制，根治在服务器执行 `ocrproxy upgrade` 时报 `systemd-run: option '--remain-after-exit' doesn't allow an argument` 导致升级中断退出的缺陷；
- **交互式终端直连优化**：在交互式终端 (TTY) 下执行 `ocrproxy upgrade` 时直接前台运行并实时回显下载与部署进度，不再误转入后台单元；
- **国内极速下载链路重构**：`prepare_source_code` 在默认无 Token 场景下优先轮询国内高速镜像源 (`ghfast.top` / `gh-proxy.com` / `mirror.ghproxy.com`) 并将连接超时缩短至 5 秒，彻底解决国内服务器在官方 GitHub 累计等待 75 秒超限导致的 Web 后台 OTA 升级探测超时；
- **后台 OTA 升级指令增强**：向升级单元自动透传 `OCRPROXY_RUNNING_IN_OTA_UNIT=1` 环境变量，并增加国内镜像直接拉取兜底。

### `v2026.10.09-12` (2026-10-09)
- **客户端 Key 占位符根治**：`vm-app/app/admin_routes.py` 的 `get_config_endpoint` 增加 `PROXY_API_KEY` 环境变量自动兜底，确保在 KB 模式及任何默认未持久化场景下，首页仪表盘「接入网关与可用模型」均能正确展示真实的客户端 API Key，杜绝 `<CLIENT_KEY>` 占位符残留；
- **KB 模式 Key 胶囊交互解耦**：`shared/admin/js/models.js` 实现独立的 `toggleCandidateKeyCapsule(el)` 切换函数，彻底解耦 Candidate 弹窗与 Agent 弹窗内部闭包状态 (`modalBindings` / `a_selectedBindingsSummary`)，消除跨弹窗状态污染；
- **操作按钮精简与全局去重**：收敛「同步中枢规则」入口至弹窗内部（「① 选择提供商」右上角）与「系统设置」面板中，移除 Agent 模式与 KB 模式主界面标题栏多余/重复的外部同步按钮，移除 KB 模式顶部与下方卡片重复的 `[+ 挂载节点]` 按钮，消除界面元素堆叠。



