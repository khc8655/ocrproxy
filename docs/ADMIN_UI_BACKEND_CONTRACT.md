# 共享 UI 与两端后端契约规范 (Admin UI Backend Contract)

> **权威规范文件**：[`shared/contracts/admin-ui-backend.json`](../shared/contracts/admin-ui-backend.json)  
> **自动化核验工具**：[`tests/test_backend_contract.py`](../tests/test_backend_contract.py)  
> **适用范围**：VM 常驻服务（`vm-app/`）与 EdgeOne 边缘函数（`edge-functions/`、`agent-edgeone/`）

---

## 一、 架构背景与研发痛点

在 OCRProxy 系统中，前端控制台源码维护在单一真理源 [`shared/admin/`](../shared/admin/)：
- **VM 模式**：通过 FastAPI 提供 RESTful 管理接口，状态由 Python 单进程内存或持久化文件记录。
- **EdgeOne 模式**：运行在分布式 Serverless 环境（跨机房多个隔离 Isolate），状态由边缘分布式 KV 存储承载。

**曾遇到的核心痛点**：
由于两端后端实现语言不同（Python vs Node.js ESM）、架构差异大，以往在开发控制台功能时，容易发生“VM 实现了某字段而 EdgeOne 漏了”或“键名命名风格不一致（如一个用 agent 模型名，一个用 upstream 模型名）”，导致控制台在某端显示“未调用”或逻辑异常。

为彻底消除实现漂移、提高后续迭代开发效率，系统建立了**双端统一契约系统（Unified Backend Contract）**。

---

## 二、 核心契约规范（SSOT）

所有规范在 [`shared/contracts/admin-ui-backend.json`](../shared/contracts/admin-ui-backend.json) 中严格声明，任何后端的实现必须满足以下契约：

### 1. 候选节点调用状态键名规范
在 `GET /api/admin/stats` 接口返回的 `candidates_status` 对象中，各节点的键名必须严格遵循四段式结构：

$$\mathbf{key} = \texttt{agent:\{agent\_model\}:\{provider\}:\{key\_label\}}$$

- `agent_model`：前端展示与调度的 Agent 虚拟模型名（如 `claude`、`gpt-4o`）。
- `provider`：供应商唯一标识（如 `up`、`amd`、`openai`）。
- `key_label`：密钥别名（如 `k1`、`k2`）。

**状态项字段定义**：
```json
{
  "status": 200,          // 最近一次调用的 HTTP 响应码 (int，200 表示成功)
  "latency_ms": 150,      // 最近一次调用的耗时毫秒数 (int >= 0，null 表示未测量)
  "time": 1729312345000,  // 最近一次调用发生的时间戳 (epoch ms)
  "is_quota": false       // 是否发生配额耗尽 / 欠费拦截 (bool)
}
```

> [!NOTE]
> **EdgeOne KV 写预算保护**：EdgeOne 节点针对未发生状态变化的记录（如连续调用均为 200），同一 Isolate 内最多每 10 秒回写一次 KV，避免消耗边缘写额度；一旦状态发生变化（如正常变 429），立即实时写入。VM 端则为实时精准记录。

---

### 2. 「使用中」主力 Key 映射契约
在 `GET /api/admin/stats` 接口中，必须提供 `agent.active_keys` 字典：
```json
{
  "agent": {
    "active_keys": {
      "claude": "k1",
      "gpt-4o": "k2"
    }
  }
}
```
前端共享组件据此在表格中为对应 Key 渲染亮绿色的「使用中」主力状态徽章。

---

### 3. 手动探活（「测」按钮）契约
- **请求格式**：前端通过 `HOST.buildTestBody` 发送探活请求，**必须包含 `agent_model` 字段**。
- **副作用**：后端在完成探活后，必须将测试耗时与状态回写至 `candidates_status` 中的相应条目（`agent:<agent_model>:<provider>:<key_label>`），确保用户在控制台点击「测」后，当前行立刻更新最近耗时，无需依赖 localStorage 本地缓存。

---

### 4. 宿主胶水全局对象契约
宿主控制台页面（VM 的 `core.js` 与 EdgeOne 的 `admin.js`）必须对共享组件 `agent-models-ui.js` 注入以下全局变量：
- `HOST.api.config`：获取配置接口路径
- `HOST.api.stats`：获取运行状态接口路径
- `HOST.api.testKey`：探活单 Key 接口路径
- `HOST.buildTestBody`：构建单 Key 探活报文方法
- `state.config`：当前生效的全局配置对象
- `state.stats`：当前生效的节点状态数据（随配置加载自动拉取）

---

### 5. 首页 Agent 统计契约 (`stats.agent.summary`)
- **字段**：`GET /api/admin/stats` 响应中的可选字段 `agent.summary`（含 `window`/`date`/`timezone`/`requests`/`failures`/`failovers`/`tokens_in`/`tokens_out`/`usage_requests`/`ttft_ms_avg`/`total_ms_avg`/`models`），完整定义见 [`shared/contracts/admin-ui-backend.json`](../shared/contracts/admin-ui-backend.json) 的 `endpoints.stats.response.agent.summary`。
- **冷却字段**：`candidates_status.*.cooldown_until`（epoch ms，可选）为契约字段，双端在 Key 处于冷却窗口内时下发，供首页「当前快照」计算「冷却 / 故障中的 Key」。
- **双端口径**：VM（`vm-app/app/agent_metrics.py`）返回按北京时间自然日累计的今日统计；EdgeOne **刻意不返回**该字段，前端 `core.js` 自动降级为基于 `candidates_status` 的「当前快照」三卡。前端仅凭 `summary.window` 是否存在切换两种渲染。
- **核验场景**：API 层 `S7`（VM 有 `agent.summary`、EdgeOne 无）与真实浏览器 `U3`（VM 显示「今日 Token 总量」、EdgeOne 显示「可用 Key」，无 `NaN`/`undefined`）；「+ Key → 从中枢添加」能力位由 `U2` 覆盖。

---

## 三、 自动化契约测试矩阵 (The Same Scenarios)

测试脚本 [`tests/test_backend_contract.py`](../tests/test_backend_contract.py) 在本地真实拉起：
1. **Mock Upstream**（受控上游，支持精确返回 429/500/延迟响应）；
2. **VM 后端**（FastAPI 常驻进程，真实持久化存储）；
3. **EdgeOne 后端**（通过 `eo_local_server.mjs` 运行真实 ESM 边缘函数与内存 KV）。

两端分别执行完全相同的场景断言，并在控制台输出并排对照表：

| 场景编号 | 场景名称 | 触发动作 | 期望断言 |
| :---: | :--- | :--- | :--- |
| **S1** | 真实 Chat 流式调用记入状态 | `POST /v1/chat/completions` (stream) | `candidates_status` 中生成 `agent:claude:up:k1`，`status=200`，`latency_ms > 0` |
| **S2** | 调用后正确识别主力 Key | 同 S1 | `agent.active_keys.claude == "k1"` |
| **S3** | 真实 Messages 调用同样记入 | `POST /v1/messages` | `candidates_status` 中更新调用时间戳 |
| **S4** | 429 故障转移双 Key 状态独立 | 上游对 k1 返回 429，触发切到 k2 | k1 显示 `status=429`，k2 显示 `status=200`，`active_keys == "k2"` |
| **S5** | 手动「测」写回同一状态条目 | 模拟点击「测」调用 `testKey` | 探活成功，且 `candidates_status` 对应节点状态即时更新 |
| **S6** | 探测上游模型列表接口 | `POST /api/admin/probe-models` | 成功探测并返回包含 `mock-chat-1` 的模型列表 |
| **S7** | 首页 Agent 统计双端口径 | 读完 S1/S3/S4 状态后读 `stats` | VM：`agent.summary.window=today`，`requests>=3`、`failovers>=1`、`tokens_in>=1`、`ttft_ms_avg>0`；EdgeOne：无 `agent.summary` |
| **U1** | 真实浏览器渲染核验 | 真实 Chromium 打开控制台 | 对应 Key 行显示「最近响应耗时」徽章，无报错无白屏 |
| **U2** | 「从中枢添加」能力位 | 真实浏览器：将 `up` 标记 `origin=vault` 后 `openKeyModal('up')`，读取 `#k_vault_section` 显隐 | VM：显示；EdgeOne：不显示（由 `HOST.capabilities.vaultClient` 控制） |
| **U3** | 首页 Agent 卡片双端呈现 | 真实浏览器：`renderDashboard()` 后读取 `#agentStatsGrid` | VM 含「今日 Token 总量」；EdgeOne 含「可用 Key」；均无 `NaN`/`undefined` |
| **U4** | 新增供应商下拉只表达来源 | 真实浏览器：`openProviderModal()` 后读取 `#p_preset` 的 options/optgroups | 首项为自定义（`""`）；不含官方预设 id；无「官方预设供应商」分组 |

---

## 四、 研发纪律：契约优先工作流 (Contract-First)

后续无论新增还是修改控制台交互字段，必须严格遵循以下三步纪律：

```
[第一步: 声明契约] ──> 在 shared/contracts/admin-ui-backend.json 中定义新字段与期望
       │
[第二步: 双端实现] ──> 分别在 vm-app/ 与 edge-functions/ 实现对应逻辑
       │
[第三步: 契约测试] ──> 运行 python tests/test_backend_contract.py
                      输出 VM=PASS | EdgeOne=PASS，全绿方可合并提交！
```


## EdgeOne /api/test 语义（v20261023-01）

- 单 Key + 指定 `model`：只认真实 `chat/completions`（`max_tokens=16`）的结果；失败时**不得**用 `/models` 探测回退为成功，且必须把 status/latency 写入 `nodestat:*`，管理端模型列表据此刷新。
- 无 `model`：仅做 `/models` 探测，响应标记 `mode: "probe"`；前端 Toast 显示“探测成功（/models，非模拟请求）”，与真实请求成功区分。
- 单 Key 测试同时带 `agent_model` 时，无论成功/失败都记录为该模型绑定的最近调用，保证所有管理端会话看到一致状态。

## 统一超时模型（v20261023-03）

- **硬总超时固定 300s**：EdgeOne 为平台架构上限，VM 为安全上限；只用于防挂死，不参与"能尝试几个 Key"的计算。
- 删除 `request_total_budget_sec`、`max_retries`、`max_attempts_per_provider`；设置页不再显示相关字段。
- **粘性（manual）**：固定当前 Key，不轮换；VM 纯中转（300s 安全超时），EdgeOne 到 300s 返回超时。
- **自动轮换**：按候选 Key 逐个尝试，成功 / 试完所有 Key / 300s 谁先到谁结束。
- **KB**：正常轮换；全部 429/冷却 → `429 + Retry-After`，客户端自行重试，服务端不排队等待。
- EdgeOne 使用 `agent_first_byte_timeout_sec` 作为单次尝试超时（不再把 `upstream_timeout_sec` 当全局超时）；全冷却不再返回"0 个候选均已尝试 / HTTP 0"。
