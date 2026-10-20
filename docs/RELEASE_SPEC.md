# OCRProxy 极简发版规约与防遗漏自动化门禁 (Release Specification v2.0)

> **起效版本**：`v2026.10.19-09`（分层门禁自本次工具链分层改造起）  
> **核心原则**：将繁琐臃肿的长篇规则收敛为**“三大发版铁律、四层分层门禁、三步极简 SOP”**，按变更范围只跑必要层级，杜绝规则过长导致 AI 模型与开发者遗漏关键检查，也避免日常迭代被全量浏览器矩阵拖慢。

---

## 一、三大发版铁律 (Three Iron Laws)

### 🛑 铁律一：版本号 7 处全网 100% 强一致 (Version Sync)
每次版本发布（格式：`vYYYY.MM.DD-NN`），以下 7 处目标文件必须强一致：
1. `version.json`：全局权威版本元数据
2. `vm-app/version.json`：VM 端打包元数据
3. `install.sh`：一键安装脚本内置 `SCRIPT_VERSION`
4. `vm-app/install.sh`：VM 离线脚本内置 `SCRIPT_VERSION`
5. `shared/admin/admin.html`：真理源 HTML 顶部 `#topVersionBadge` 与底部 `<script ?v=...>`
6. `vm-app/static/admin.html`：VM 静态 HTML 顶部 `#topVersionBadge` 与脚本缓存戳
7. `agent-edgeone/admin.html` & `edge-functions/admin.js`：EdgeOne 边缘函数内联 HTML 顶部 `#topVersionBadge`

### 🛑 铁律二：EdgeOne 专属身份与金库中枢保全 (EdgeOne Identity & Vault Hub)
**严禁将 EdgeOne 部署或编译成 VM 的 Agent 版本！**
1. **静态标题与 Badge 隔离**：EdgeOne 编译产物必须包含 `<title>OCRProxy EdgeOne 控制台</title>` 与 `<span class="brand-badge badge-edgeone" id="topModeBadge">EdgeOne 边缘版</span>`，首屏即明确宿主身份；
2. **环境硬注入**：打包 EdgeOne JS 必须在首行注入 `window.__HOST_KIND__ = 'edgeone'`，驱动 `host.js` 锁定 `vaultHub: true, vaultClient: false`；
3. **中枢大门常驻**：EdgeOne 作为云端凭据资产中枢，控制台必须永远常驻 `id="panel-providers"`（供应商面板），绝对禁止执行 VM Agent 模式隐藏供应商的逻辑。

### 🛑 铁律三：安装脚本零代码漂移 (Zero Drift)
- `install.sh` 与 `vm-app/install.sh` 必须保持 **100% 字节级一致**；
- 必须包含 Python 3.9+ 环境智能跳过与虚拟环境依赖跳过逻辑，严禁在环境完备时重复执行 `apt-get` 或 `pip install`。

---

## 二、分层门禁与浏览器使用边界 (Tiered Gates & When a Browser Is Required)

### 1. 为什么不再"改个界面就全量跑浏览器"

历史上管理后台由 VM / EdgeOne **两份手写副本**维护，改一处必须用真实浏览器回归，防止两端割裂。该问题已通过**单一真理源编译**（`shared/admin/` → `vm-app/static/` + EdgeOne 内联 bundle）彻底根治：两端现在共享同一份 HTML/CSS/JS，构建产物由 `build:admin` 确定性生成。

因此"两端割裂"不再是浏览器才能发现的风险，而是 T1 的**静态契约**职责（`tests/test_admin_ui_static_contract.py`）：
- 必需 DOM id / 面板存在且唯一、`#topNav` 4 个 Tab 与 `#panel-*` 一一对应；
- HTML 里所有内联 `onclick/onchange` 都能解析到已声明的函数（防止改名漏改）；
- `data-arch` / `data-cap` 取值合法（host 条件渲染不漂移）；
- VM 静态副本 == 单一真理源（忽略版本戳）、EdgeOne bundle 身份标记齐全且无外链；
- CSS 关键布局不变式（arch 隐藏规则、响应式断点、核心布局类）仍在。

**浏览器只在两类风险下才跑**，且按改动范围精确选取，不再默认全量：

| 风险类型 | 触发条件 | 跑的层级 |
| :--- | :--- | :--- |
| **布局 / 视口** | `admin.css` 改动，或 `admin.html` 出现**结构性**改动（增删标签/`id`/`class`/`data-*`/`on*`/样式属性；纯文案改动不算） | T3a `npm run test:contract` 不跑，仅 `npm run test:matrix` 中的 overflow（12s） |
| **运行时 DOM 行为** | 登录生命周期、host 能力位、仪表盘/供应商/Key 徽章的渲染与点击流 | 按模块跑 T2 UI（`core.js` / `host.js` / `providers.js` / `vault.js` / `agent-models-ui.js`）或 T3b E2E（`app.js` / `settings*.js` / `models.js`） |
| **后端 / 协议 / 契约** | `vm-app/app/`、`shared/contracts/`、EdgeOne `api/` | T2a **无浏览器** `npm run test:contract:api`（6.7s，S1~S7） |
| **其余（文案/预设/测试/发版元数据）** | 纯文案 HTML、`shared/presets/`、`tests/`、`version.json` / `install.sh` | **不启动浏览器**：T1 静态契约 + 单元/API 层（0.5~1s） |

> 若纯文案改动涉及多语言长文案、换行或 390px 窄屏风险，可手动补一次 `npm run test:matrix`；这属于人工判断，不再是默认强制项。

### 2. 四层检查清单与耗时（本机实测）

| 层级 | 内容 | 命令 | 耗时 | 浏览器 |
| :--- | :--- | :--- | :---: | :---: |
| **T0 静态门禁** | G1~G5：版本 7 处一致 / EdgeOne 身份 / install.sh 零漂移 / SSOT / 零明文密钥 | `npm run check:release` | ~0.2s | 否 |
| **T1 逻辑层** | 199 ESM 单元、CoW 安全、Agent 统计、API/Vault 规约、SSOT 镜像、**静态 UI 契约** | `npm run test:fast` | ~0.5s | 否 |
| **T2a API 契约** | 真服务 + Mock 上游，S1~S7（U1~U4 SKIP） | `npm run test:contract:api` | ~6.7s | 否 |
| **T2b UI 契约** | S1~S7 + U1~U4（真 Chromium：登录、能力位、首页卡片）+ Key 权限矩阵 | `npm run test:contract` | ~16s | 是 |
| **T3a 布局矩阵** | VM + EdgeOne × 1280/768/390 视口 × 4 Tab 零横向溢出 | `npm run test:matrix` 的一部分 | ~12s | 是 |
| **T3b E2E** | 全矩阵 Playwright E2E 76 项（登录、设置保存、模型/Key、KB 模式） | `npm run test:matrix` 的一部分 | ~16s | 是 |
| **全套** | T1 + T2b + T3（并行） | `npm run test:full` | **~20s** | 是 |

### 3. 变更范围 → 层级映射（`npm run test:auto` 自动判断）

| 改动范围 | 自动选择的层级 | 参考耗时 | 浏览器 |
| :--- | :--- | :---: | :---: |
| 仅文档（`*.md` / `docs/` / `README` / `CHANGELOG`） | T0 | ~0.2s | 否 |
| 预设适配、纯测试/脚本、`version.json` / `install.sh` 等发版元数据 | T0 + T1 | ~0.6s | 否 |
| `shared/admin/admin.html` 纯文案改动（结构签名不变） | T0 + T1 | ~0.6s | 否 |
| `shared/admin/admin.html` 结构性改动 | T0 + T1 + T2b + T3a | ~17s | 是（布局 + UI） |
| `admin.css` 布局/样式 | T0 + T1 + T3a | ~13s | 是（仅布局） |
| `core.js` / `host.js` | T0 + T1 + T2b | ~14s | 是（UI 行为） |
| `providers.js` / `vault.js` / `agent-models-ui.js` | T0 + T1 + T2b + Key 权限矩阵 | ~17s | 是（UI 行为） |
| `app.js` / `settings*.js` / `models.js` | T0 + T1 + T3b | ~18s | 是（完整点击流） |
| 后端 / 协议 / 契约 | T0 + T1 + T2a | ~8s | **否** |
| 无法归类 | 发版全套（保守回退） | ~20s | 是 |

> 实现：`python3 tests/run_tests.py --layer=auto` 读取工作区 + `origin/main` 的 diff（含未提交/未跟踪文件），对 `admin.html` 用"结构签名"区分文案改动与结构改动，并打印选择依据；`npm run test:auto` 并行执行。切换层级用 `--base=<ref>`。

### 4. T0 门禁断言清单（~0.2s，永久保留）
- **[PASS] G1: Version parity verified across all 7 targets**（7 处版本号强一致比对）
- **[PASS] G2: EdgeOne exclusive identity & Vault Hub guard verified**（EdgeOne Title/Badge/宿主标记/供应商面板强断言）
- **[PASS] G3: Install scripts zero-drift verified**（安装脚本 100% 字节一致性）
- **[PASS] G4: SSOT assets synchronization verified**（`shared/admin/` 与 `vm-app/static/` 同步校验）
- **[PASS] G5: Zero plaintext secret leakage verified**（代码与配置零明文 Key 泄漏审计）

> **门禁阻断机制**：所选层级任一失败即红色高亮并输出该检查完整日志，非 0 退出码阻断提交与部署。正式发版必须跑 T0 + `test:auto` 判定的全部层级；只有文档-only 提交（不升版本、不触发发版）可只跑 T0。若发版同时包含大范围 UI/交互改动，建议额外跑一次 `npm run test:full` 作为保险。

---

## 三、三步极简发版 SOP (3-Step Release SOP)

### Step 1: 升级版本元数据
修改 `version.json` 中的 `version` 字段，并在 `CHANGELOG.md` 顶部记录本次版本的新增与修复项。

### Step 2: 执行一键打包构建（~0.3s）
```bash
npm run build:admin
```
构建脚本会自动同步 `shared/admin/` → `vm-app/static/`、注入版本号、编译 EdgeOne bundle，并**自动触发 T0 G1~G5**，失败立即 `exit(1)`。

### Step 3: 按改动分层验证并提交推送（0.6~20s）
```bash
# 正式发版默认命令：自动读取 diff 选择必要层级（本次没碰布局/交互就不启动浏览器）
npm run test:auto

# 如果本次发版确实改了 UI 行为/布局，或想保守跑满：
npm run test:full

# 校验通过后提交并推送至 GitHub，自动触发 EdgeOne 边缘部署
git commit -m "feat(release): bump version to vYYYY.MM.DD-NN ..."
git push origin main
```
