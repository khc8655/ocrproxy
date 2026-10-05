# OCRProxy 共享资产与唯一真理源 (`shared/`)

> **⚠️ 开发者与 AI Agent 必读铁律**：  
> `shared/` 目录是整个 Monorepo 代码库的**唯一真理源 (Single Source of Truth)**。  
> **严禁**直接编辑 `vm-app/static/admin.html`、`agent-edgeone/admin.html` 或各端的 `presets/index.js` 编译产物！所有界面修改与厂商规则调整必须在 `shared/` 下完成，并通过编译脚本同步至各端。

---

## 一、 目录组织架构

```
shared/
├── admin/                         # 🎨 前端管理控制台唯一开发真理源 (模块化源码)
│   ├── admin.html                 # 语义化 HTML 骨架与弹窗容器 (~700 行)
│   ├── admin.css                  # 统一设计系统样式表 (Tokens, 栅格, 状态徽章)
│   └── js/                        # 7 大高内聚独立业务领域脚本
│       ├── core.js                # 全局状态管理、加密/解密工具、Toast 与 API 请求封装
│       ├── vault.js               # EdgeOne Vault 凭据中枢通信、Key 掩码与连通性诊断
│       ├── providers.js           # 供应商管理、CDN/GitHub 按需拉取、协议解耦配置
│       ├── agent-models-ui.js     # Agent 模型卡片渲染、快速挂载弹窗、Key 胶囊交互
│       ├── models.js              # 模型探测、上游模型名映射、优先级与故障转移策略
│       ├── settings.js            # 系统设置、运行模式切换 (Agent/KB)、超时预算控制
│       └── app.js                 # 顶层单页应用控制器、生命周期初始化、事件总线分发
│
├── presets/                       # 🧩 13 大官方提供商声明式适配规则 (JSON 真理源)
│   ├── catalog.json               # 提供商轻量索引目录 (由 build-presets.mjs 自动生成)
│   ├── openai.json                # OpenAI 官方原生中转 (零拷贝纯中转规范)
│   ├── google.json                # Google AI Studio / Gemini 适配规则 (含思考矩阵)
│   ├── vertex.json                # Google Vertex AI 深度适配 (含 OpenAPI 端点规范)
│   ├── deepseek.json              # DeepSeek 官方适配规则
│   ├── minimax.json               # MiniMax / 海螺 AI 适配规则 (双协议支持)
│   ├── stepfun.json               # 阶跃星辰 StepFun 适配规则
│   ├── amd.json                   # AMD Radeon Cloud 适配规则
│   ├── bai.json                   # 百川智能 / B.AI 适配规则
│   ├── agnes.json                 # Agnes AI 适配规则
│   ├── siliconflow.json           # 硅基流动 SiliconFlow 适配规则
│   ├── sensenova.json             # 商汤科技 SenseNova 适配规则
│   ├── tokenrhythm.json           # TokenRhythm 适配规则
│   └── cline.json                 # Cline 原生适配规则
│
└── docs/                          # 📖 跨端统一规范与设计文档
    ├── config-schema.md           # 统一加密配置 Schema 规范
    ├── hermes-gemini-vertex-adaptation.md # Google Vertex AI 协议深度适配备忘录
    └── mcp_vault_credentials_api.md       # Vault 中枢凭据分发接口协议规范
```

---

## 二、 前端模块化开发与编译工作流 (`shared/admin/`)

### 1. 架构设计哲学
为了彻底解决单文件 HTML 膨胀至数千行、难以维护且容易改坏历史功能的痛点，前端采用**模块化物理拆分 + 自动化单体打包**方案：
- **开发态 (Development)**：在 `shared/admin/` 中按职责拆分为独立的 HTML、CSS 和 7 个 JS 业务脚本，代码清晰、易读、无冲突；
- **构建态 (Build)**：通过 Node.js 构建脚本将 HTML、CSS 和 JS 无损打包为自包含的单文件 HTML，内嵌版本号与构建时间戳；
- **运行态 (Production)**：各端直接托管单文件 HTML，零外部网络打包依赖，静态渲染性能极高。

### 2. 编译与同步命令
当修改了 `shared/admin/` 下的任何 HTML、CSS 或 JS 文件后，在项目根目录下执行：

```bash
node agent-edgeone/scripts/build-admin.mjs
```

构建脚本会自动完成：
1. **VM 服务端分发**：将 `shared/admin/` 资源同步至 `vm-app/static/`，并自动读取 `version.json` 为所有 `<script src="/static/js/*.js?v=...">` 注入最新版本号，实现浏览器免强刷缓存更新；
2. **EdgeOne 边缘函数内联**：按照依赖拓扑将 CSS 与 JS 深度内联拼接为自包含单体 HTML，写入 `agent-edgeone/edge-functions/` 与静态产物，实现边缘节点零外链极速响应。

---

## 三、 模型提供商适配预设与构建流 (`shared/presets/`)

### 1. 声明式规则设计原则 (`adapter_rules`)
系统完全抛弃了在代码中写死 `if (provider === "xxx")` 的侵入式硬编码，所有上游厂商的特性均在 `shared/presets/*.json` 中以纯声明式 JSON 配置：
- **`reasoning` 规则**：
  * OpenAI 纯中转：配置为 `"strategy": "openai_passthrough"`；
  * Google Gemini / Vertex AI：配置为 `"strategy": "gemini_thinking_matrix"`（全站唯一允许转换思考策略的模型）；
  * 其他所有厂商：保留原生直通，不得配置思考转换规则！
- **`tools` 规则**：
  * `"normalize_choice_to_string": false`：严禁将结构化 `tool_choice` 强转为字符串 `"auto"`，确保 Cursor/Cline 精确调用；
- **`stream` 规则**：
  * 全面采用原生 SSE 字节透传，禁止注入流式正则拦截器。

### 2. 预设编译与分发命令
当新增或修改了 `shared/presets/*.json` 规则后，在项目根目录执行：

```bash
node agent-edgeone/scripts/build-presets.mjs
```

该脚本将：
1. 校验所有 JSON 文件的语法合法性；
2. 计算每个预设文件的 SHA256 哈希值，更新 `shared/presets/catalog.json` 索引；
3. 将所有 JSON 预设编译为静态 JavaScript 常量，自动写入：
   - `agent-edgeone/edge-functions/lib/presets/index.js`
   - `edge-functions/lib/presets/index.js`
4. 提交到 GitHub 后，各 VM 节点将自动通过 jsDelivr CDN (`cdn.jsdelivr.net/gh/khc8655/ocrproxy@main/shared/presets/`) 享受秒级按需拉取。

---

## 四、 常见开发任务速查指引

| 任务 | 正确操作步骤 | 严禁行为 |
| :--- | :--- | :--- |
| **修改管理后台某个按钮样式或文案** | 1. 修改 `shared/admin/admin.html` 或 `admin.css`<br>2. 运行 `node agent-edgeone/scripts/build-admin.mjs` | ❌ 直接在 `vm-app/static/admin.html` 中改动 |
| **新增一个模型提供商预设 (如 Groq)** | 1. 在 `shared/presets/` 下新增 `groq.json`<br>2. 运行 `node agent-edgeone/scripts/build-presets.mjs`<br>3. 运行 `npm test` 校验通过 | ❌ 直接在 EdgeOne 的 JS 代码里写死厂商判断 |
| **调整前端 Key 胶囊逻辑** | 1. 修改 `shared/admin/js/agent-models-ui.js`<br>2. 运行 `node agent-edgeone/scripts/build-admin.mjs` | ❌ 直接修改已打包的内联 `<script>` 代码 |
