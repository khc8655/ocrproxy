# OCRProxy 质量保障与自动化测试套件 (`tests/`)

> **💡 开发者与 AI Agent 必读**：  
> 本目录包含 OCRProxy 的全量测试套件。为确保系统的高可靠性，**任何涉及模型适配、路由策略、协议转换或前端接口的修改，在提交前必须至少执行对应的自动化测试套件**。  
> 特别是新模型适配，**必须执行全量准入测试并获得【🟢 生产可用 · 达到正式上线标准】判定后，方可上线使用**。

---

## 一、 测试套件矩阵与职责总览

```
tests/
├── test_live_models_suite.py      # 🏆 核心准入套件：6 大维度模型生产级实机自动化准入测试
├── test_adapter_audit_suite.py    # ⚡ 单元测试：OpenAI 零拷贝 Fast-Path 与非 Gemini 思考透传断言 (24 项)
├── test_edgeone_normalize.mjs     # 🌐 单元测试：EdgeOne 边缘函数适配规则与 rawBytes 透传断言 (10 项)
├── test_messages_pipeline.py      # 📨 单元测试：Anthropic Messages (/v1/messages) 双向管道与 URL 拼接
├── test_live_kb_suite.py          # 📚 实机套件：KB 知识库模式对话/向量/重排/OCR 全功能测试
├── test_duplicate_model_prevention.mjs # 🛡️ 单元测试：知识库候选节点与 Agent 模型 Key 防重复挂载拦截断言
├── test_run_server_dual_stack.py  # 🌐 单元测试：VM 服务真双栈 Socket 绑定及无 IPv6 环境容灾降级断言 (发版核心门禁)
├── test_edgeone_upgraded_ui.py    # 🖥️ 集成测试：升级版前端组件与状态契约测试 (需本地 scratch 夹具，缺失则 SKIP)
├── test_vm_agent_ui_e2e.py        # 🧭 E2E：真实 Chromium 点击 VM Agent 控制台全流程 (自带 Mock 上游，离线可跑)
├── test_vm_static_sync.py         # 🔁 门禁：shared/admin 与 vm-app/static 发布副本必须一致
└── test_admin_upstream_guard.py   # 🛡️ 单元测试：管理端探活 SSRF 守卫 (允许已保存的内网/HTTP 供应商，永远拒绝元数据地址)
```

---

## 二、 核心套件深度指南：生产级模型上线准入测试 (`test_live_models_suite.py`)

### 1. 准入理念与覆盖维度
新适配一个模型后，为了彻底消除人工反复测试的低效与不确定性，测试套件构建了 **6 大维度的端到端全自动准入流水线**：

| 准入测试维度 | 校验点与断言标准 | 失败排查指引 |
| :--- | :--- | :--- |
| **维度 1: 目录检索自省**<br>(`/v1/models`) | 请求 `/v1/models`，断言状态码为 200，格式严格符合 OpenAI 标准 `{"object": "list", "data": [...]}`，且目标模型处于已注册列表。 | 检查 `proxy_config.enc` 或后台模型列表中是否正确添加了该模型并保存。 |
| **维度 2: 思考等级阶梯**<br>(`reasoning_effort`) | 依次测试 `none`、`low`、`medium`、`high` 四级参数：<br>1. 校验首字耗时与回复字数呈阶梯变化；<br>2. 校验思维链（`reasoning_content`）字段提取与格式有效性。 | 检查该厂商预设中的 `adapter_rules.reasoning`，确认除 Gemini 外未注入多余思考转换规则。 |
| **维度 3: 流式 vs 非流式对比**<br>(Stream vs Non-stream) | 1. 非流式：断言 HTTP 200，完整返回 `content`；<br>2. SSE 流式：逐行解析 `data: {...}`，断言首包时间 (TTFT) < 3000ms，数据块完整拼接无乱码。 | 检查网络连接或流式代理通道，排查是否有中间代理缓冲了 SSE 数据包。 |
| **维度 4: 高频工具调用多轮闭环**<br>(Function Calling Closure) | 连续执行 3~5 轮完整工具闭环：<br>1. 请求携带 `calculate` 与 `get_weather` 定义；<br>2. 校验模型返回合规的 `tool_calls` 与 JSON 参数；<br>3. 脚本在本地执行 Mock 工具并回传 `role: tool`；<br>4. 校验模型成功给出最终总结回答。 | 检查模型是否具备 Function Calling 能力；检查预设中 `normalize_choice_to_string` 是否误设为 `true`。 |
| **维度 5: 多模态图文与 OCR**<br>(Multimodal Vision / OCR) | 向 `/v1/chat/completions` 发送带有纯色测试图片 Base64 的 Prompt：<br>1. 多模态模型：断言 HTTP 200 并正确识别图片颜色；<br>2. 纯文本模型：优雅识别“不支持视觉”，记录为纯文本专用，不阻断上线。 | 确认上游模型是否支持 Vision；检查图片 Base64 格式是否符合标准 Data URI 规范。 |
| **维度 6: 错误传参与边界鲁棒性**<br>(Negative & Security) | 1. 不存在的模型名：断言返回 404/400 且返回 OpenAI 标准错误 JSON；<br>2. 空 `messages: []`：断言优雅返回 400；<br>3. 畸形参数格式：断言返回 400/422，无 500 崩溃；<br>4. 伪造/无 Key 请求：断言鉴权守卫严格 401 拦截。 | 检查网关异常捕获中间件，确保上游 4xx 错误被透传而非抛出未捕获异常。 |

### 2. 执行命令与使用范例

```bash
# 1. 默认自检：自动探测 /v1/models 列表并对首个主模型进行全量准入测试 (需提供 PROXY_API_KEY)
export PROXY_API_KEY="your-proxy-key"
python3 tests/test_live_models_suite.py

# 2. 针对指定的新适配模型执行全量 6 维度准入测试
python3 tests/test_live_models_suite.py --model deepseek-v4-flash-0731 --key "your-proxy-key"

# 3. 指定目标网关 URL 进行跨环境准入测试
python3 tests/test_live_models_suite.py --model gemini-3.5-flash-lite --url https://api1.khc6.cn --key "your-proxy-key"
```

### 3. 准入判定标准
执行结束后，终端将输出最终判定看板：
- 🟢 **【🟢 生产可用 · 达到正式上线标准】**：六大维度测试用例 100% 全部通过，模型已达到高可用生产要求，可立即向 Cursor、Dify、NextChat 等生产客户端放行；
- 🔴 **测试未完全通过**：终端会输出精确到具体维度的失败原因，根据报错提示进行微调后再次运行复测。

---

## 三、 适配器纯净化与零拷贝单元测试 (`test_adapter_audit_suite.py`)

针对 `vm-app` 核心调度器与适配器规则进行离线单元验证，共包含 **24 项断言**，毫秒级执行：

```bash
/Users/xk/.local/bin/uv run --with-requirements vm-app/requirements.txt python tests/test_adapter_audit_suite.py
```

**验证重点**：
1. **ScheduleResult 零拷贝与懒加载**：断言原始字节 `raw_content` 不经历反序列化，`data` 属性仅在访问时惰性解析；
2. **OpenAI 官方零拷贝纯中转**：断言请求体与响应体 100% 字节级一致，`tool_choice` 不被强转；
3. **除 Gemini 外思考不转化**：断言 MiniMax、StepFun、AMD、B.AI、Agnes 的思考等级原汁原味透传；
4. **Gemini 唯一例外**：断言 Google AI Studio 仍正常保留 `gemini_thinking_matrix` 与 Tool Schema `$schema` 清洗。

---

## 四、 EdgeOne 边缘函数适配规则测试 (`test_edgeone_normalize.mjs`)

针对 EdgeOne 边缘函数的 JS 适配规则进行离线单元断言，共包含 **10 项测试**：

```bash
node tests/test_edgeone_normalize.mjs
```

**验证重点**：
1. EdgeOne `normalize.js` 正确透传各厂商原生思考等级；
2. 仅 Gemini 执行 thinking_config 转换与 Schema 清洗；
3. 非流式响应直接下发 `rawBytes`，杜绝重复序列化与反序列化。

---

## 五、 Anthropic 协议双向转换测试 (`test_messages_pipeline.py`)

针对 `/v1/messages` 接口的 URL 构造与参数清洗进行离线验证：

```bash
python3 tests/test_messages_pipeline.py
```

**验证重点**：
1. B.AI 与 MiniMax 境内外 Base URL 自动补齐 `/anthropic/v1/messages` 路径；
2. 剥离 Claude 3.7 非标的 `output_config`；
3. 严格保护模型大小写敏感性（如 `MiniMax-M3` 不被小写化）。

---

## 六、 常用测试速查表

| 测试目标 | 命令 | 预期通过率 |
| :--- | :--- | :---: |
| **新模型生产上线准入** | `python3 tests/test_live_models_suite.py --model <模型名>` | 100% (6 维度全绿) |
| **OpenAI 零拷贝与适配器核心** | `python tests/test_adapter_audit_suite.py` | 24 / 24 PASS |
| **EdgeOne 适配规则断言** | `node tests/test_edgeone_normalize.mjs` | 10 / 10 PASS |
| **Anthropic Messages 接口测试** | `python3 tests/test_messages_pipeline.py` | 100% PASS |
| **KB 知识库模式实机测试** | `python3 tests/test_live_kb_suite.py` | 100% PASS |


---

## VM Agent 控制台端到端测试 (`test_vm_agent_ui_e2e.py`)

不做字符串断言，而是起真实 VM 服务 + OpenAI 兼容 Mock 上游，用 Chromium 真实点击完成：登录 → 新增供应商 → 新增 Key (在线校验 / 坏 Key 拦截 / 跳过校验) → 新增 Agent 模型 (探测上游并点选) → 单 Key 测 / 全部探活 → 追加第二个 Key → `/v1/chat/completions` 真实调用 → 概览统计。全程任何 JS 异常或非预期 4xx/5xx 即失败。

```bash
pip install -r vm-app/requirements.txt playwright
python3 -m playwright install chromium     # 或 export CHROMIUM_PATH=/usr/bin/chromium
npm run test:e2e:vm                         # E2E_KEEP=1 保留截图与服务日志
```
