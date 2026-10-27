# 控制台 UI 标准化迁移规范（Console v2 设计 → 现有 shared/admin）

> 状态：草案 v0.1（2026-10-28），待评审。
> 适用对象：执行迁移的 coding agent 与评审人。
> 本文是**规范性文件**：「必须 / 禁止」是硬约束，违反即视为 PR 不合格；「建议」可在 PR 说明中给出理由后偏离。

---

## 0. 一句话

**只换皮，不换骨。** 把 `design/console-v2`（分支 `feat/console-v2`）的视觉规范与组件规格，落到现有原生 JS 控制台 `shared/admin/` 上；数据流、HOST 适配器、settings schema、构建链、后端契约、DOM 契约一概不动。

---

## 1. 背景与决策

### 1.1 现状诊断（2026-10-28 基于 main `2f2246a` 实测）

现有前端的**架构是对的**，问题全部在视图层：

| 层 | 现状 | 结论 |
|---|---|---|
| 宿主差异 | `js/host.js`：接口路径 + `capabilities` 能力位 | 保留 |
| 设置项 | `js/settings-form.js` 按 `shared/config/settings.schema.json` 渲染 | 保留 |
| 单一真源 | `shared/admin/` → `vm-app/static/`（G4）+ `build-admin.mjs` 内联成 EdgeOne 单文件 | 保留 |
| 契约 | `shared/contracts/admin-ui-backend.json`、`tests/test_admin_ui_static_contract.py` 的 `REQUIRED_IDS` | 保留 |
| **视图** | 无组件层，`innerHTML` 字符串拼接约 85 处，每处自写按钮/徽章/弹窗 | **本次改造对象** |

视图层规格漂移的实证（`shared/admin/` 内统计）：

- 按钮 class 组合 19 种，含同义重复：`btn-warn` / `btn-warning`、`btn-danger` / `btn-secondary-danger`、`btn-xs` / `btn-sm`。
- 徽章同义重复：`badge-warn` / `badge-warning`、`badge-error`（其他地方叫 danger）、`badge-primary` / `badge-purple` 语义不明。
- 内联样式：HTML 116 处 `style="`，JS 222 处 `style=` + 68 处 `.style.xxx =`。
- 颜色硬编码：`admin.css` 的 `:root` 之外仍有 33 处十六进制色、19 处 `rgba(`；JS 内 9 处十六进制色。
- 三套 token 并存：`design-system/colors_and_type.css`（未被引用）、`admin.css :root`（实际生效）、v2 `index.css`（原型）。

### 1.2 为什么不整体换 v2

v2 的数据层是自造的（mock + localStorage），设置项硬编码在 `mock.ts`（24 项，schema 实为 26 项），能力位在 `lib/host.ts` 重抄一份，体积超 EdgeOne 预算（381 KB / gzip 110 KB）。整体替换 = 重写前端 + 重写 UI 契约与 E2E 测试，风险与收益不成比例。

### 1.3 决策

- v2 在本次迁移中的角色：**视觉参考与验收基准**，代码不直接复用。
- `design/console-v2/` 保留在分支上供本地 `pnpm dev` 对照，不合入 main 的构建链。
- v2 的 `docs/UI_DESIGN_SPEC_DRAFT.md` 中「视觉系统 / 组件规范 / 交互规范」三章（§4–§6）作为本文的视觉依据；其「代码约定」（React 目录、Tailwind）**不适用**。

---

## 2. 不变量（任何一个 PR 都不得违反）

1. **不改行为**：任何 API 调用、请求体、保存逻辑、`_version` CAS、HOST 能力判断、schema 渲染逻辑不变。PR diff 中出现 `fetch(`、`HOST.api`、`HOST.capabilities`、`SETTINGS_SCHEMA` 相关逻辑改动即不合格（纯渲染调用点的替换除外，需在 PR 说明逐处列出）。
2. **不改 DOM 契约**：`REQUIRED_IDS` 全部保留；所有被 JS/测试引用的 `id`、`data-*`、`onclick` 处理函数名保留。
3. **不改构建链**：仍是 `admin.html` + 单个 `admin.css` + `js/*.js`；`build-admin.mjs` 的 link/script 正则与门禁不放宽。唯一允许的改动：在 `admin.html` 的脚本块中新增一行 `ui.js`（见 §4）。
4. **不引入依赖**：无 npm 运行时依赖、无外部字体/CSS/JS/图标请求、无构建期转译。
5. **不加功能**：迁移期间冻结 UI 新功能（含 OAuth 登录入口）。OAuth UI 在 P2 合并后用新组件实现。
6. **双宿主一致**：每个 PR 必须在 VM 与 EdgeOne 两种 `__HOST_KIND__` 下验证。
7. **每个 PR 可独立发版**：任一阶段停下，控制台都是完整可用的。

---

## 3. 设计 token（唯一来源）

### 3.1 位置

- **唯一来源**：`shared/admin/admin.css` 文件开头的 `/* §1 Tokens */` 段 `:root { … }`。
- `design-system/`：在其 README 顶部标注「已归档，控制台 token 以 `shared/admin/admin.css §1` 为准」，P6 再决定删除或改为从 admin.css 生成。本次不得再从 `design-system/` 引用任何东西。

### 3.2 admin.css 文件结构（必须按此顺序分段）

```
/* §1 Tokens      —— 只有 :root 变量，唯一允许出现字面颜色值的地方 */
/* §2 Base        —— reset、body、排版、滚动条、焦点环 */
/* §3 Layout      —— 顶栏、页头、页面容器、栅格 */
/* §4 Components  —— .btn .badge .capsule .card .field .table .modal .toast .empty .segmented .switch */
/* §5 Pages       —— 仅页面特有布局，按 dashboard / providers / models / settings 分小节 */
/* §6 Utilities   —— 有限的工具类（见 3.5） */
/* §7 Legacy      —— 迁移期旧类的别名，P6 清空 */
```

### 3.3 token 清单（取值以 v2 `src/index.css` 为准，换算成 hex 写入）

命名统一 `--c-*`（颜色）、`--sp-*`（间距）、`--r-*`（圆角）、`--fs-*`（字号）、`--sh-*`（阴影）。现有 `--khc-*` 变量在 §7 中以别名保留到 P6。

| 类别 | token | 说明 |
|---|---|---|
| 表面 | `--c-bg` `--c-surface` `--c-surface-muted` `--c-border` `--c-border-strong` | 页面底、卡片、次级底、描边 |
| 文字 | `--c-text` `--c-text-muted` `--c-text-subtle` `--c-text-inverse` | |
| 主色 | `--c-primary` `--c-primary-hover` `--c-primary-soft` | soft = 浅底 |
| 语义 | `--c-success(-soft)` `--c-warning(-soft)` `--c-danger(-soft)` `--c-info(-soft)` `--c-violet(-soft)` `--c-teal(-soft)` `--c-sky(-soft)` | 每个色只有「实色」+「浅底」两档 |
| 间距 | `--sp-1`…`--sp-12` | 4px 栅格：4/8/12/16/20/24/32/40/48 |
| 圆角 | `--r-sm 6px` `--r-md 8px` `--r-lg 12px` `--r-pill 999px` | |
| 字号 | `--fs-xs 12` `--fs-sm 13` `--fs-md 14` `--fs-lg 16` `--fs-xl 20` | 行高随档位固定 |
| 阴影 | `--sh-sm` `--sh-md` `--sh-modal` | |
| 动效 | `--dur-fast 120ms` `--dur-base 180ms` `--ease` | |

具体数值由 P0 PR 从 v2 换算填写，并在 PR 中附对照表。

### 3.4 语义色映射（全站唯一，写死在 `ui.js` 的 `UI.TONE`）

| 含义 | tone | 来源 |
|---|---|---|
| 协议 chat / messages / responses | `info` / `violet` / `teal` | v2 README 配色约定 |
| Key 来源 vault（中枢）/ local / 免 Key | `info` / `neutral` / `sky` | 同上 |
| Key 状态 正常 / 未调用 / 限流 / 异常 / 欠费 | `success` / `neutral` / `warning` / `danger` / `danger` | 同上，与概览 429/5xx 一致 |
| 运行模式 agent / kb | `primary` / `teal` | 本文新增 |

任何页面**禁止**自行决定这些含义的颜色，只能调用 `UI.toneOf(kind, value)`。

### 3.5 工具类

只允许以下工具类，新增需改本文：`.mono` `.tnum` `.muted` `.truncate` `.is-hidden` `.sr-only` `.stack-{1..6}`（纵向间距）`.row-{1..6}`（横向间距）。

---

## 4. 组件层 `shared/admin/js/ui.js`

### 4.1 加载

- 新文件 `shared/admin/js/ui.js`，在 `admin.html` 中放在 `host.js` 之后、`settings-form.js` 之前，带同样的 `?v=` 版本参数（G1）。
- 暴露唯一全局 `window.UI`，不得新增其他全局。
- 现有 `esc()`、`toast()`、`openModal()`、`closeModal()`（core.js）**签名不变**：P0 把实现搬入 `UI`，core.js 中保留同名薄包装，调用方零改动。

### 4.2 API 形态

为与现有 `innerHTML` 模板兼容，组件是**返回 HTML 字符串的纯函数**，所有文本参数在内部经 `UI.esc`；需要原样插入 HTML 的参数必须以 `html` 结尾命名（如 `bodyHtml`），评审时逐个检查来源。

```js
UI.esc(s)                                   // 唯一转义函数
UI.button({ label, variant, size, icon, iconOnly, title, attrs })
  // variant: 'primary' | 'secondary' | 'ghost' | 'danger'      （默认 secondary）
  // size:    'sm' | 'md'                                        （默认 md）
  // iconOnly 时 title 必填，自动输出 aria-label
UI.badge({ text, tone, mono })              // tone 见 3.4 + 'neutral' | 'primary'
UI.dot(tone)                                // 状态圆点
UI.capsule({ label, origin, status, locked, actionsHtml })  // Key 胶囊，供应商与模型绑定共用
UI.card({ title, subtitle, actionsHtml, bodyHtml, tone })
UI.pageHeader({ title, desc, actionsHtml })
UI.field({ label, hint, error, controlHtml, required })
UI.input / UI.select / UI.textarea / UI.switch / UI.segmented   // 表单控件
UI.table({ columns, rowsHtml, empty })
UI.empty({ icon, title, desc, actionHtml })
UI.icon(name, size)                         // 内置图标，见 4.4
UI.toneOf(kind, value)                      // 语义色查询，见 3.4
UI.toast(msg, type)  UI.openModal(id)  UI.closeModal(id)  UI.confirm({ title, desc, danger }) -> Promise<boolean>
```

### 4.3 CSS 类（闭集）

组件只产出下列类；页面代码**禁止**手写这些类名的其他组合：

- 按钮：`.btn` + `.btn--primary|--secondary|--ghost|--danger` + `.btn--sm` + `.btn--icon`
- 徽章：`.badge` + `.badge--{tone}`
- 其余：`.capsule` `.card` `.page-header` `.field` `.input` `.select` `.textarea` `.switch` `.segmented` `.table` `.empty` `.modal` `.toast`

旧类（`btn-primary`、`btn-sm`、`btn-xs`、`btn-warn`、`btn-warning`、`btn-secondary-danger`、`badge-success`、`badge-warn`、`badge-error`、`badge-purple` …）在 §7 Legacy 中映射到新样式，保证未迁移页面外观同步更新；P6 删除。

### 4.4 图标

- 只用 Lucide 线性图标，以 SVG path 内联在 `ui.js` 的 `ICONS` 表中，按需收录（预计 ≤ 25 个）。
- 尺寸只有 14（行内）/ 16（导航、关闭）/ 20（空状态）。
- 同一动作全站同一图标：编辑 `pencil`、删除 `trash-2`、探测 `activity`、复制 `copy`、拉取 `download`、升级 `arrow-up-circle`、锁定 `lock`、排序 `grip-vertical`。

### 4.5 显隐与动态样式

- 显隐统一用 `hidden` 属性或 `.is-hidden`，**禁止**新增 `el.style.display = …`。
- 唯一允许的内联样式：数据驱动的宽度/百分比（进度条、占比条），且必须写成 `style="--w:NN%"` 由 CSS 消费。

---

## 5. 页面规范（视觉依据：v2 设计规范 §4–§6）

- **页面骨架**：`pageHeader`（标题 + 一句说明 + 主操作，主操作每页最多 1 个 primary）→ 内容卡片 → 辅助说明；危险操作集中在卡片底部或独立「危险区」卡片。
- **按钮层级**：每个视图区域最多 1 个 primary；破坏性动作用 danger 且必须走 `UI.confirm`。
- **Key 胶囊**：供应商页与模型绑定处是同一个 `UI.capsule`；vault Key 在 VM 端显示 `lock` 且无编辑/删除。
- **表格**：数字列右对齐 + `.tnum`；空态用 `UI.empty`，不得留空白表格。
- **表单**：label 在上，hint 在下，错误态替换 hint；必填用星号，不用颜色区分。
- **响应式**：≥ 360px 宽不出现横向滚动（沿用 `test_ui_no_horizontal_overflow.py`）。
- **无障碍**：纯图标按钮必须有 `title` + `aria-label`；焦点环全站一致；颜色不是唯一信息载体（状态徽章必须带文字）。

---

## 6. 分期（每期一个 PR，顺序执行，前一期合并后才开下一期）

| 期 | 范围 | 页面外观变化 | 关键产出 |
|---|---|---|---|
| **P0 地基** | admin.css 分段 + 新 token；`ui.js` 全部组件；§7 Legacy 别名；守卫测试 `tests/test_ui_standard.py`（见 §7）以当前计数为基线 | 全站换色板/圆角/字号（由 token 驱动），结构不变 | token 对照表、组件演示截图 |
| **P1 外壳** | 登录页、顶栏、导航、各页 `pageHeader`、toast、modal 外框 | 骨架统一 | |
| **P2 供应商** | 供应商卡片、Key 胶囊、Key 弹窗、供应商弹窗、vault 拉取与规则升级 | 供应商页完成 | 之后可开 OAuth UI |
| **P3 模型及路由** | Agent 模型卡与绑定表、KB 四类候选、探测弹窗、排序 | | |
| **P4 系统设置** | `settings-form.js` 改用 `UI.field` 等控件渲染（仍读 schema）、运维、备份、底层 JSON | | |
| **P5 概览** | 网关卡、Agent/KB 统计、错误日志表 | | |
| **P6 收尾** | 删除 §7 Legacy；内联样式、`.style.` 赋值、硬编码色清零（允许清单除外）；守卫阈值收紧到 0；处理 `design-system/` | 无 | 最终体积报告 |

每期 PR 只能触碰本期范围内的页面代码；跨期顺手修改一律拆出去。

---

## 7. 守卫测试 `tests/test_ui_standard.py`（P0 新增，纳入 contract 层）

采用**棘轮**：P0 记录基线，之后每期只许下降，P6 降到 0。

| 检查 | 规则 | P0 基线 → P6 目标 |
|---|---|---|
| 字面颜色 | `admin.css` §1 之外、`js/*.js`、`admin.html` 中的 `#hex` / `rgb(` / `hsl(` | 当前计数 → 0 |
| 内联样式 | `style="` 与 `style=`（JS 模板）| 338 → 仅 `--w:` 形式 |
| 动态样式 | `.style.xxx =` | 68 → 0 |
| 按钮类 | 出现在 HTML/JS 中的 `btn` 类组合必须属于 4.3 闭集 + §7 别名 | P6 只剩闭集 |
| 徽章类 | 同上 | 同上 |
| 图标按钮 | `btn--icon` 必须带 `aria-label` | 0 违规（P0 起即强制） |
| 全局 | `ui.js` 只新增 `window.UI` | 0 违规 |
| 体积 | `edge-functions/admin.js`：raw ≤ 340 KB、gzip ≤ 85 KB（当前 321 KB / 80 KB）| 每期报告 |

基线数值写在测试文件顶部常量里，**只允许调小**；调大必须在 PR 标题中注明并获用户同意。

---

## 8. 每个 PR 的验收清单（PR 描述中逐项勾选）

- [ ] 只改了本期范围；未触碰 §2 列出的行为代码（附 diff 范围说明）
- [ ] `npm test`（symbols + ui smoke + `run_tests.py --layer=all`）全绿
- [ ] `npm run build:admin` 通过，G1~G6 全绿，`test_vm_static_sync.py` 通过
- [ ] `test_admin_ui_static_contract.py`、`test_key_capsules.cjs`、`test_unified_ui.cjs`、`test_browser_full_matrix.cjs`、`test_ui_no_horizontal_overflow.py` 通过
- [ ] `test_ui_standard.py` 通过且基线数值未上调
- [ ] 截图：VM（agent / kb 各一）与 EdgeOne，本期页面迁移前/后对照，并与 v2 原型同页对照
- [ ] 360px 窄屏截图无横向滚动
- [ ] 体积报告（raw / gzip）
- [ ] 版本号与 CHANGELOG 按 `docs/RELEASE_SPEC.md` 同步（如本期发版）
- [ ] **未合并**，等待用户确认

---

## 9. 明确不做

- 不引入 React / Preact / Tailwind / 任何构建期转译。
- 不新增页面、不加搜索/趋势图等 v2 原型里也没有接口的东西。
- 不改设置项、接口、字段名、存储方式。
- 不做暗色模式（token 结构已允许以后加，本次不实现）。

---

## 10. 附：给 coding agent 的执行提示

1. 先在本地跑 v2 原型（`git checkout feat/console-v2 && cd design/console-v2 && pnpm i && pnpm dev`）截全页图作为参照，再切回 main 工作。
2. 每期第一步先跑一次全量测试拿到绿色基线；每改一个页面区块就跑 `npm run build:admin` + 对应 UI 测试，不要攒到最后。
3. 遇到「为了好看需要改行为」的情况：停下，在 PR 描述里提出，不要自行改。
4. 任何测试需要修改断言（例如旧类名断言）：只允许把旧类名断言替换成等价新类名，且在 PR 描述中逐条列出。
