# ocrproxy UI 单一真理源架构标准与重构技术规约 (v1.0)

## 1. 核心设计原则
1. **统一真理源 (Single Source of Truth)**：
   - 绝对禁止在 `agent-edgeone/` 维护任何独立的 `admin.html`、`admin.css`、`admin.js`。
   - 所有的后台 UI 源码必须且仅能存在于 `shared/admin/`：
     - `admin.html`：结构骨架，通过 `data-cap="..."` 声明平台特异性组件。
     - `admin.css`：统一样式与设计系统 Tokens。
     - `js/host.js`：宿主适配层（运行时根据当前环境注入 capabilities 与 api 映射）。
     - `js/settings-form.js`：基于 `settings.schema.json` 自动渲染与双向绑定的配置表单引擎。
     - 其它业务模块：`core.js`, `vault.js`, `providers.js`, `agent-models-ui.js`, `models.js`, `settings.js`, `app.js`。
2. **差异放进系统配置，不在 UI 层硬编码判断**：
   - 超时、重试、预算、熔断、模式差异等，统一在 `shared/config/settings.schema.json` 中声明。
   - 严格禁止在 UI JS 中使用 `runMode === 'kb'` 拼接不同的配置 Key 或动态计算派生值（如总预算）。
   - UI 仅保存显式填写的原始有效值；留空表示使用系统默认值，禁止使用 `|| defaultValue` 覆盖合法的 `0` 值。
3. **宿主适配器 (Host Adapter Pattern)**：
   - 客户端统一通过全局对象 `HOST` 进行环境探测与能力交互：
     - `HOST.kind`: `'vm' | 'edgeone'`
     - `HOST.api`: 各功能接口端点（如 `/api/admin/config` vs `/api/config`）
     - `HOST.capabilities`: 各能力开关（如 `logs`, `vaultClient`, `vaultHub`, `systemUpdate`, `accessGuides` 等）
     - `HOST.buildTestBody`: 统一模型与 Key 探活参数构建
   - DOM 元素标记 `data-cap="feature_name"`，由启动器自动根据当前宿主能力决定显示或隐藏。
4. **命名统一与向前迁移**：
   - 彻底废除语义模糊的 `schedule_total_budget`，统一为：
     - `max_retries`: 单次请求最大重试次数（整数）。
     - `request_total_budget_sec`: 单次请求总预算时间（秒，浮点数）。
   - 服务端加载配置时保留双向兼容迁移：若历史配置中包含 `<= 10` 的 `schedule_total_budget`，自动迁移为 `max_retries`；若 `> 10` 则迁移为 `request_total_budget_sec`。
5. **门禁防护体系 (Build Gates)**：
   - `verify-frontend-symbols.mjs`：
     - 校验顶层函数声明与 `global.X =` 不得重名；
     - 检查预设更新地址不得出现错误镜像或未授权域名；
     - 严禁 `agent-edgeone/` 出现任何残留独立的 `admin.html`、`admin.css`、`admin.js`。

---

## 2. 实施技术路线

### 阶段一：阻断缺陷与对齐 (P0)
- [x] P0-1: 统一命名重试与预算字段，在 Python 端（`admin_routes.py`, `proxy_routes.py`, `scheduler.py`）与 EdgeOne 端（`config.js`, `completions.js`）实施兼容迁移，UI 彻底移除写入 `schedule_total_budget`。
- [x] P0-2: 纠正 `agent-edgeone/admin.js` 内的预设地址，废弃前端直连 GitHub，收口到后端 API。
- [x] P0-3: 消除 `models.js`、`core.js`、`providers.js`、`vault.js`、`agent-models-ui.js` 间的函数声明覆盖与重名污染。
- [x] P0-4: 对齐参数默认值（`max_attempts_per_provider=3`, `cooldown_429_sec=60` 等）。

### 阶段二：系统配置 Schema 化 (P1)
- [x] 创建 `shared/config/settings.schema.json` 规范定义元数据。
- [x] 编写 `shared/admin/js/settings-form.js` 驱动通用表单渲染。
- [x] VM 后端创建 `settings_schema.py`，EdgeOne 编译生成 `lib/settings-schema.js`，实现双端统一参数读取与 clamp。

### 阶段三：宿主适配器与单一 UI 编译 (P2)
- [x] 编写 `shared/admin/js/host.js` 宿主适配器。
- [x] 将 EO 的独有面板（接入代码示例、原始 JSON 编辑、配置导入等）整合至 `shared/admin/admin.html` 并标明 `data-cap`。
- [x] 改造 `agent-edgeone/scripts/build-admin.mjs`，统一读取 `shared/admin/*`，生成 EdgeOne 独立 edge-functions。
- [x] 删除 `agent-edgeone/admin.html`、`agent-edgeone/admin.css`、`agent-edgeone/admin.js`。

### 阶段四：预设规范与构建门禁 (P3)
- [x] 移除 UI 层的内联兜底预设，统合后端预设服务。
- [x] 抽离通用 BindingEditor。
- [x] 完善 `verify-frontend-symbols.mjs` 与自动化测试。
