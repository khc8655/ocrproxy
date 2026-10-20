# OCRProxy 极简发版规约与防遗漏自动化门禁 (Release Specification v2.0)

> **起效版本**：`v2026.10.19-09`  
> **核心原则**：将繁琐臃肿的长篇规则收敛为**“三大发版铁律、一个秒级门禁命令、三步极简 SOP”**，杜绝规则过长导致 AI 模型与开发者遗漏关键检查。

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

## 二、秒级自动化硬门禁 (Automated Gatekeeper)

本项目将所有发版红线固化为可执行代码，**无需人工翻阅冗长文档**，发版前只需运行单条指令：

```bash
npm run check:release
# 等价于: python3 tests/verify_release_gate.py
```

### 门禁断言清单（0.3 秒极速校验）：
- **[PASS] G1: Version parity verified across all 7 targets**（7 处版本号强一致比对）
- **[PASS] G2: EdgeOne exclusive identity & Vault Hub guard verified**（EdgeOne Title/Badge/宿主标记/供应商面板强断言）
- **[PASS] G3: Install scripts zero-drift verified**（安装脚本 100% 字节一致性）
- **[PASS] G4: SSOT assets synchronization verified**（`shared/admin/` 与 `vm-app/static/` 同步校验）
- **[PASS] G5: Zero plaintext secret leakage verified**（代码与配置零明文 Key 泄漏审计）

> **门禁阻断机制**：任何一项失败，脚本立即以红色高亮指出具体不匹配的文件与内容，并阻断构建与部署。

---

## 三、三步极简发版 SOP (3-Step Release SOP)

任何开发者或 AI 智能体在发版时，严格执行以下 3 步闭环：

### Step 1: 升级版本元数据
修改 `version.json` 中的 `version` 字段，并在 `CHANGELOG.md` 顶部记录本次版本的新增与修复项。

### Step 2: 执行一键打包构建
```bash
npm run build:admin
```
构建脚本会自动：
- 自动同步 `shared/admin/` 至 `vm-app/static/`，并自动注入最新版本号；
- 自动为 EdgeOne 边缘函数注入专属 Title、Badge、`__HOST_KIND__` 并内联编译；
- **自动触发 G1~G5 极简发版硬门禁**，校验未通过立即 `exit(1)` 中断。

### Step 3: 全层级测试验证并提交推送
```bash
# 运行四层全量测试（Layer 1~4，199 单元测试 + S1~S7 契约 + 76 项 E2E 浏览器渲染）
python3 tests/run_tests.py --layer=all

# 校验通过后提交并推送至 GitHub，自动触发 EdgeOne 边缘部署
git commit -m "feat(release): bump version to vYYYY.MM.DD-NN ..."
git push origin main
```
