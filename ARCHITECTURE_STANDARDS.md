# OCRProxy 核心架构规范与开发铁律 (Architecture Standards & Guidelines)

本文档是 OCRProxy 项目的**最高架构准则**。任何开发人员或 AI 智能体在修复 Bug、新增特性、重构模块或编写构建脚本时，**必须严格遵守以下六大核心原则**，严禁违背。

---

## 🏛️ 原则一：两大版本物理隔离与明确定位 (Two Major Editions)
本项目统一采用 Monorepo 维护，但代码与构建物理隔离开，仅存在两大版本：
1. **VM 版本 (`vm-app/`)**：
   - 运行于 Linux / Ubuntu / Debian 虚拟机或独立容器环境中，基于 Python FastAPI + Uvicorn。
   - 提供全功能大模型代理网关、知识库调度、加密持久化与原生管理控制台。
2. **EdgeOne 版本 (`agent-edgeone/` & `edge-functions/`)**：
   - 运行于腾讯云 EdgeOne 边缘函数 (Serverless V8 边缘运行环境)。
   - 提供极低延迟、零冷启动的边缘大模型代理网关。
3. **隔离铁律**：
   - **严禁构建脚本交叉污染**：EdgeOne 构建脚本（如 `build-admin.mjs`）的产物**绝对禁止**覆写 `vm-app/static/` 中的任何文件；
   - EdgeOne 的单文件前端仅输出至 `agent-edgeone/edge-functions/` 与根目录 `edge-functions/`；
   - VM 版本的前端静态资源独立存放在 `vm-app/static/`，拥有独立生命周期与多模式功能。

---

## 🔄 原则二：VM 版本的运行模式 (`RUN_MODE`)
VM 版本通过环境变量 `RUN_MODE` 动态自适应，**同一套后端代码支持三种模式**，绝不分裂分支：
1. **`RUN_MODE=kb` (知识库模式)**：
   - **定位**：面向国内知识库与 RAG 平台（Dify / FastGPT / Ragflow 等）的高并发入库服务；
   - **模型暴露**：固定对外暴露 4 大入库虚拟模型：`chat`（对话/摘要）、`embedding`（向量）、`reranker`（重排）、`ocr`（图文识别）；
   - **调度机制**：采用原子计数轮询（`round_robin`），最大化利用多 Key 并发配额；每次大 Payload 执行完毕后主动触发内存回收（`malloc_trim`）；
   - **界面展示**：自动隐藏 Agent 真实模型配置，突出 4 大虚拟模型挂载与入库超时参数。
2. **`RUN_MODE=agent` (智能体模式)**：
   - **定位**：面向 Cursor / Cline / OpenClaw / Hermes 等 AI 编程助手与智能体；
   - **模型暴露**：暴露真实大模型名（如 `deepseek-v4-flash`, `step-3.7-flash`, `gemini-2.5-flash`）；
   - **调度机制**：采用粘性故障转移（`sticky_failover`）或纯手动直通（`manual`），保证多轮对话上下文连贯与稳定；
   - **界面展示**：自动隐藏 KB 虚拟候选模型，突出真实 Agent 模型映射与思考参数调优。
3. **`RUN_MODE=full` (混合全功能模式)**：
   - **定位**：单机同时服务知识库高并发入库与智能体编程中转；
   - **特性**：同时开放 4 大入库虚拟模型与全量真实 Agent 模型，前端完整展示全部 Tab。

---

## ⚡ 原则三：EdgeOne 版本定位（纯 Agent 模式）
1. **极简且聚焦**：
   - EdgeOne 部署在无服务器边缘环境，没有文件系统与常驻进程，因此 **EdgeOne 版本仅专注且仅支持 Agent 智能体模式**；
   - 不承载 KB 模式的 Heavy Payload（如几十兆的 PDF OCR 解析或超大批量 Embedding 矩阵计算）；
2. **存储适配**：
   - EdgeOne 采用分布式 EdgeOne KV 作为配置中心；
   - 具有全局请求硬超时预算（`request_total_budget_sec=25s`），在 EdgeOne 平台 30s 强杀前 5s 优雅主动响应，杜绝挂死。

---

## 🧩 原则四：共用与独立的差异化解耦 (Shared vs Isolated)
1. **共用部分 (Shared Core)**：
   - **提供商适配预设 (`shared/presets/`)**：11 大主流厂商（AMD、阶跃、商汤、硅基、MiniMax、Google 等）的请求/响应规范化规则、思考等级映射、参数清洗规则完全共享；
   - **Schema v2 数据结构**：`providers`、`agent_models`、`candidates` 的字段命名与业务含义两端 100% 保持一致，数据可在 VM 与 EdgeOne 之间无损导入导出。
2. **独立差异部分 (Isolated Implementation)**：
   - **运行时与网络**：VM 为 Python AsyncIO + HTTPX；EdgeOne 为 Web Standard `fetch` + V8 Isolate；
   - **持久化层**：VM 为本地 AES-Fernet 加密文件；EdgeOne 为边缘 KV 命名空间；
   - **管理前端**：
     - VM 控制台：必须支持 **KB 模式、Agent 模式、Full 模式动态自适应**，支持实时错误日志审计与服务重启；
     - EdgeOne 控制台：聚焦 Agent 模型与 Key 池维护，轻量化单文件打包。

---

## 💾 原则五：配置与程序主机物理分离 (Decoupled Config & Host)
为了在程序频繁发布、git pull、版本回滚或容器重建时，用户的 API Key、生产模型映射与历史统计**绝对不被覆盖或丢失**：
1. **VM 端配置独立目录**：
   - 程序源码位于 `/opt/ocrproxy/`（或 `/var/www/ocrproxy/`）；
   - 加密配置文件**必须落地在独立的持久化目录**（默认为 `/opt/ocrproxy/config/proxy_config.enc`），升级脚本在任何更新前**强制自动创建带时间戳的完整备份**（`backup_YYYYMMDD_HHMMSS/`）；
2. **配置永不入库**：
   - 任何带有真实 Key 的配置文件一律列入 `.gitignore`，严禁提交到 Git；
3. **版本升级与热重载**：
   - 程序更新只需替换代码目录并触发平滑热重载（`systemctl restart ocrproxy`），配置由后端自动加载解密，做到程序代码随便更，业务配置稳如山。

---

## 🛡️ 原则六：防劣化与跨版本影响审计 (Zero-Regression Rule)
**任何改动都绝不允许顾此失彼！**
在修改任何一个模式下的任何一个 Bug 或功能时，**必须在实施前进行全方位交叉评估**：
1. **改动 EdgeOne 时**：
   - 思考：修改是否动到了 `shared/` 目录？
   - 思考：构建脚本是否错误地生成并覆盖了 VM 的静态文件？
   - 思考：KV 存储结构的改动是否会导致 VM 解析旧配置报错？
2. **改动 VM 端时**：
   - 思考：在 Agent 模式下的调整，是否破坏了 KB 模式的 `/v1/chat/completions` 或 `/v1/embeddings`？
   - 思考：在 KB 模式下调整路由，是否影响了 Agent 模式的 `tools` 或 `reasoning_content` 透传？
3. **改动控制台前端时**：
   - 思考：该字段是否只属于特定模式？必须使用 `runMode` 逻辑进行自适应显隐，切勿直接写死。
4. **验证铁律**：
   - 每次发布前，必须至少验证 **EdgeOne Agent 模式**、**VM Agent 模式**、**VM KB 模式** 三种形态下的核心接口与控制台呈现。
