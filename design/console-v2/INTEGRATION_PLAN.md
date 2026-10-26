# Console v2 接入计划（草稿）

> 目标：把 `design/console-v2` 从 mock 原型接成可上线的真实控制台，而不是直接替换现有 `shared/admin/`。
> 原则：先跑通最小闭环（登录 → 真实配置读写 → 真实探测/统计 → 构建门禁），再补 UI 规范与视觉细节。

## 0. 当前状态（2026-10-26）

- [x] 原型隔离到 `design/console-v2`，移除了开发平台残留（`.vibex/.cursor/vibex-local`）。
- [x] 移除了 `useConsole.ts` 的种子 `proxy_api_key`；原型不再内置 Key。
- [x] 设计规范保存为 `docs/UI_DESIGN_SPEC_DRAFT.md`，**未替换**现有规范。
- [ ] 真实 API / 登录 / Schema / 构建 / 测试（本计划后续阶段）。

## 1. 最小闭环（P0）

### 1.1 登录与宿主识别

现有后端契约（不要新造）：

- 登录校验：`GET /api/admin/config`，`Authorization: Bearer <ADMIN_PASSWORD>`；成功即视为登录。
- 管理员凭证只放 `sessionStorage`，关闭标签页失效；禁止写 `localStorage`。
- 宿主：构建/部署时注入 `window.__HOST_KIND__ = 'vm' | 'edgeone'`；生产隐藏手动 VM/EdgeOne 切换。
- 401：清空凭证，回到登录页；不要静默展示工作台。

### 1.2 真实 API 适配层

新增 `src/lib/api.ts`，`useConsole` 不再直接依赖 mock/localStorage：

| 功能 | 现有接口 | 备注 |
|---|---|---|
| 读取配置 | `GET /api/admin/config` | VM/EdgeOne 同一路径；返回 `config` 或扁平对象需兼容 |
| 保存配置 | `PUT /api/admin/config`（带 `_version` CAS） | 409 必须提示并重载，不能覆盖 |
| 统计 | `GET /api/admin/stats` | Agent summary / candidates_status / error_logs |
| 单 Key 探测 | VM `POST /api/admin/test-candidate`；EdgeOne `POST /api/test` | 由 host capability 选择 |
| Agent 模型探测 | VM `POST /api/admin/test-agent-model` | |
| 模型列表探测 | `/api/admin/probe-models` | |
| 预设目录/详情 | `/api/admin/presets/catalog` / `detail` | |
| Vault | `/api/vault/*`（服务端 token） | 前端不接触 vault token |
| 日志 | VM `stats.error_logs`；EdgeOne 平台日志 | EdgeOne 不新增 UI 日志页 |

### 1.3 Schema 对齐

原型类型（`src/types.ts`）需要映射到后端真实 Schema：

- `providers[]` → `config.providers{}`（对象，key label → `{key, origin, is_local}`）
- `models[]` → `config.agent_models{}`（`upstream_model`、`keys[]`、`active_key`）
- `kbCandidates[]` → `config.candidates{chat/embedding/reranker/ocr}[]`
- `settings` → `config.settings`，字段以 `shared/config/settings.schema.json` 为准
- 导入/导出必须保留未知字段，避免 UI 保存时丢配置

### 1.4 构建与部署

两条路线，先选一条验证：

1. **旁路预览（推荐先做）**：Vite build 输出到 `vm-app/static/console-v2/`，只读旁路访问，不动现有 `/admin`；用真实 API 验证。
2. **正式替换**：把构建产物内联为 VM `admin.html` / EdgeOne 单文件；需要改 `build-admin.mjs`、G4/G6、静态契约测试后才能替换。

在路线 1 通过前，禁止修改现有 `shared/admin` 或替换规范。

## 2. 功能补齐（P1）

按现有控制台已有功能逐项对照，缺一不可：

- 供应商/Key：VM vault Key 只读、来源标记、按需拉取、规则升级；
- 模型：Agent 模型绑定、KB 四类候选、排序、探测、主动切换；
- 设置：按 host/mode 过滤、草稿/保存、恢复默认、底层 JSON、导入导出、备份；
- 运维：重启/升级（VM）、版本、运行模式/时段调度；
- 概览：真实 Agent/KB 统计、错误日志、网关信息；
- 安全：Key 不落 localStorage/URL，日志脱敏，CSP，XSS 防护；
- EdgeOne：能力矩阵、Hub UI 常驻、平台日志入口说明。

## 3. 测试与门禁

- TypeScript + ESLint + `vite build`；
- API 契约测试：配置读写往返、409、401、Schema 不丢字段；
- Playwright E2E：登录、改配置、保存、刷新、探测；
- secret 扫描：禁止真实 Key、禁止把 Key 写 localStorage；
- 与现有 T0/T1 门禁并行，未通过不替换 `/admin`。

## 4. 验收标准

- 不登录无法访问任何配置/操作；
- 所有修改真实落盘，刷新/重启后仍在；
- 导入导出与现有 Schema 完全兼容；
- 无真实 Key 进入前端 bundle/localStorage/URL；
- 现有全量测试与 G1~G6 通过；
- 取得用户确认后才替换原 UI 与设计规范。
