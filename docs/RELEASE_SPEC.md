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

## 二、四层分层门禁 (Tiered Quality Gates)

所有发版红线仍固化为可执行代码，但按**成本与覆盖范围**拆成 4 层：日常迭代跑便宜层，正式发版才跑满（且并行执行）。旧版每次发版固定串行跑全套浏览器矩阵 ≈ 60s，现在发版全套 ≈ **20s**，纯逻辑迭代 ≈ **0.5s**。

| 层级 | 内容 | 命令 | 耗时（本机实测） | 何时必跑 |
| :--- | :--- | :--- | :---: | :--- |
| **T0 静态门禁** | G1~G5：版本号 7 处一致 / EdgeOne 身份 / install.sh 零漂移 / SSOT 同步 / 零明文密钥 | `npm run check:release` | ~0.2s | **任何变更**（含纯文档） |
| **T1 逻辑层** | 199 ESM 单元、CoW 安全、Agent 统计口径、API 路由与 Vault 拉取规约、SSOT 镜像 | `npm run test:fast` | ~0.5s | 逻辑 / 后端 / 预设 / 测试 |
| **T2 契约层** | 真实 VM + EdgeOne 服务 + Chromium：S1~S7 / U1~U3 双端契约、中枢 vs 本地 Key 权限矩阵 | `npm run test:contract` | ~16s | 后端 / 契约 / 共享 UI / 权限 |
| **T3 矩阵层** | 窄屏 0 溢出（VM + EdgeOne × 3 视口 × 4 Tab）、全矩阵 Playwright E2E 76 项 | `npm run test:matrix` | ~18s | UI / 布局 / 发版 |

### 变更范围 → 层级映射（`npm run test:auto` 自动判断）

| 改动范围 | 必跑层级 | 参考耗时 |
| :--- | :--- | :---: |
| 仅文档（`*.md` / `docs/` / `README` / `CHANGELOG`） | T0 | ~0.2s |
| 预设适配（`shared/presets/`）、纯测试 / 脚本 | T0 + T1 | ~0.7s |
| 后端逻辑 / 协议 / 契约（`vm-app/app/`、`shared/contracts/`、EdgeOne `api/`） | T0 + T1 + T2 | ~17s |
| 共享 UI / 控制台产物 / 发版元数据（`shared/admin/`、`vm-app/static/`、`admin.js`、`version.json`、`install.sh`） | T0 + T1 + T2 + T3（= 发版全套） | ~20s |

> `python3 tests/run_tests.py --layer=auto` 会读取工作区改动 + `origin/main...HEAD` 的 diff 自动选层并打印依据；无法归类的改动自动回退到发版全套。`--layer=all --parallel` 为正式发版命令，T1/T2/T3 各检查通过独立进程并行执行（各自使用空闲端口与临时目录，互不干扰，失败时输出对应检查的完整日志）。

### T0 门禁断言清单（~0.2s，永久保留）：
- **[PASS] G1: Version parity verified across all 7 targets**（7 处版本号强一致比对）
- **[PASS] G2: EdgeOne exclusive identity & Vault Hub guard verified**（EdgeOne Title/Badge/宿主标记/供应商面板强断言）
- **[PASS] G3: Install scripts zero-drift verified**（安装脚本 100% 字节一致性）
- **[PASS] G4: SSOT assets synchronization verified**（`shared/admin/` 与 `vm-app/static/` 同步校验）
- **[PASS] G5: Zero plaintext secret leakage verified**（代码与配置零明文 Key 泄漏审计）

> **门禁阻断机制**：任何一层失败立即以红色高亮指出具体层级/检查与失败输出，并以非 0 退出码阻断提交与部署；正式发版**不允许**降级跳过 T1~T3（文档-only 提交除外，且其不升版本、不触发发版）。

---

## 三、三步极简发版 SOP (3-Step Release SOP)

任何开发者或 AI 智能体在发版时，严格执行以下 3 步闭环：

### Step 1: 升级版本元数据
修改 `version.json` 中的 `version` 字段，并在 `CHANGELOG.md` 顶部记录本次版本的新增与修复项。

### Step 2: 执行一键打包构建（~0.3s）
```bash
npm run build:admin
```
构建脚本会自动：
- 自动同步 `shared/admin/` 至 `vm-app/static/`，并自动注入最新版本号；
- 自动为 EdgeOne 边缘函数注入专属 Title、Badge、`__HOST_KIND__` 并内联编译；
- **自动触发 T0 G1~G5 极简发版硬门禁**，校验未通过立即 `exit(1)` 中断。

### Step 3: 分层全量验证并提交推送（~20s）
```bash
# 正式发版：T1 + T2 + T3 全套并行（199 单元 + S1~S7/U1~U3 契约 + 76 项 E2E）
npm run test:full

# 日常迭代（不发版）：按改动自动选层，文档-only 只需 T0
npm run test:auto

# 校验通过后提交并推送至 GitHub，自动触发 EdgeOne 边缘部署
git commit -m "feat(release): bump version to vYYYY.MM.DD-NN ..."
git push origin main
```
