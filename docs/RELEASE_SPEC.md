# OCRProxy 官方迭代发版规范与红线标准 (Release Specification)

> **版本**：v1.0.0 (起效版本：v2026.10.07-01)  
> **适用范围**：OCRProxy 全平台代码库（EdgeOne 边缘版、Azure/腾讯云/各 Linux VM 部署版、本地测试版）  
> **执行原则**：任何版本发布、特性迭代或紧急热更，必须 100% 遵守本规范，杜绝“改了代码漏了脚本、升了版本漏了测试”。

---

## 目录
1. [版本号全网联动矩阵 (Version Sync Matrix)](#1-版本号全网联动矩阵)
2. [VM 安装与升级脚本规范 (Install & Upgrade Spec)](#2-vm-安装与升级脚本规范)
3. [依赖智能检测与跳过原则 (Dependency Skip Rule)](#3-依赖智能检测与跳过原则)
4. [自动化测试硬性门禁 (CI & Test Guardrails)](#4-自动化测试硬性门禁)
5. [发版 Checklist 操作 SOP (五步闭环)](#5-发版-checklist-操作-sop)

---

## 1. 版本号全网联动矩阵

每次版本迭代（格式：`vYYYY.MM.DD-NN`，如 `v2026.10.07-01`），**必须同时同步修改以下 6 处文件**，禁止出现单边滞后：

| 序号 | 文件路径 | 对应字段 / 标签 | 作用说明 |
| :--- | :--- | :--- | :--- |
| **1** | `version.json` | `"version": "vYYYY.MM.DD-NN"` | 根目录全局权威版本号元数据 |
| **2** | `vm-app/version.json` | `"version": "vYYYY.MM.DD-NN"` | VM 端应用打包版本元数据 |
| **3** | `install.sh` | `SCRIPT_VERSION="vYYYY.MM.DD-NN"` | 根目录权威一键安装/升级脚本内置版本 |
| **4** | `vm-app/install.sh` | `SCRIPT_VERSION="vYYYY.MM.DD-NN"` | VM 子目录离线安装脚本内置版本（与根目录严格一致） |
| **5** | `vm-app/static/admin.html` | ① 顶部 `#topVersionBadge`<br>② 底部所有 `<script src="/static/js/*.js?v=...">` | 保证浏览器加载最新前端逻辑，强行击穿客户端 HTTP 脚本强缓存 |
| **6** | `shared/admin/admin.html` | ① 顶部 `#topVersionBadge`<br>② 底部所有 `<script src="/static/js/*.js?v=...">` | 保证多环境共享前端版本完全统一 |

---

## 2. VM 安装与升级脚本规范

### 2.1 单一真实源 (Single Source of Truth)
- 项目根目录下的 `install.sh` 为全网一键安装脚本的权威源码。
- `vm-app/install.sh` 必须与根目录 `install.sh` 保持 **100% 同步一致**。
- 测试套件中已加入严格的比对断言，若两者存在任何代码漂移，自动化测试将直接报错阻断。

### 2.2 资产清单与新增文件审计
- 凡在迭代中新增了生产运行所需的目录或文件（例如 `shared/presets/` 规则库、静态资源、脚本等）：
  - 必须确保在 `install.sh` 的 `prepare_source_code` 与部署 `cp` 指令中已显式包含；
  - 必须确保在 `--upgrade` 平滑升级函数中已包含，避免存量升级机器缺少新文件。

### 2.3 平滑升级兼容性规范
- `--upgrade` 模式绝对禁止破坏 `${INSTALL_DIR}/config/` 下的用户既有配置文件和密钥；
- 新增环境变量配置项时，必须提供自适应默认值（Fallback），确保老配置平滑继承。

---

## 3. 依赖智能检测与跳过原则

> **核心原则**：现代 Linux 系统大多已自带 Python 3.9+、venv、curl 与 tar。**安装脚本必须优先检测系统环境，若已满足要求则直接跳过，严禁无谓触发 `apt-get update`、`apt-get install` 或重复 `pip install`。**

### 3.1 系统级依赖检测跳过逻辑
1. **基础工具链检测**：
   - 检查系统是否已具备 `curl` 与 `tar`；
2. **Python 环境检测**：
   - 检查 `python3` 是否存在且版本 `>= 3.9`；
   - 检查是否具备直接构建虚拟环境与 pip 的能力：
     `python3 -c "import sys, venv, ensurepip; exit(0 if sys.version_info >= (3, 9) else 1)"`
3. **跳过准则**：
   - 上述两项均通过时，直接输出 `[✓] 系统级基础依赖已满足 (Python 3.x, venv, curl, tar)，跳过系统包管理器安装流程`；
   - **完全不执行 `apt-get update` 与 `apt-get install`**；
   - 仅在确实缺少上述关键工具时，才精准补全缺失的包。

### 3.2 Python 虚拟环境依赖跳过逻辑
1. **轻量 Import 探测**：
   - 在已存在的 venv 中（重新安装或 `--upgrade` 升级时），执行轻量模块导入校验：
     `venv/bin/python -c "import fastapi, uvicorn, httpx, pydantic, pydantic_settings, cryptography, dotenv"`
2. **跳过准则**：
   - 导入完全成功时，直接输出 `[✓] Python 虚拟环境依赖已就绪且完整，跳过重复 pip 安装`；
   - **完全不连接 PyPI 镜像源**，将安装/升级流程压缩至秒级完成；
   - 仅在导入报错或缺少特定依赖时，才调用 pip 进行增量安装与修复。

---

## 4. 自动化测试硬性门禁

在发版前，必须运行本地自动化测试套件（含安全防御专项）：
```bash
# 1. 核心安全防御与三权分立自动化测试 (6 项专项防御断言)
node tests/test_security_hardening.mjs

# 2. 规则隔离与端到端发版门禁测试
python3 tests/test_phase3_phase4_audit.py
node agent-edgeone/scripts/test-units.mjs

# 3. 多源网络与更新检测专项测试
python3 -m unittest tests/test_check_update_multi_source.py
```

### 4.1 核心断言项（缺失即失败）
1. `version.json["version"] == vm-app/version.json["version"] == install.sh SCRIPT_VERSION == vm-app/install.sh SCRIPT_VERSION`；
2. `vm-app/static/admin.html` 底部所有 script 标签的 `?v=` 查询串必须匹配当前版本号；
3. `install.sh` 与 `vm-app/install.sh` 核心逻辑 100% 同步；
4. `install.sh` 包含系统依赖智能跳过与 Python 依赖智能跳过检测点；
5. `install.sh` 包含完整资产部署拷贝清单（`app`, `static`, `scripts`, `shared`, `requirements.txt`, `version.json`）；
6. **EdgeOne 与 VM 前端双轨强一致性断言**：`agent-edgeone/admin.html` 与 `shared/admin/admin.html` 的超时输入范围（`max >= 300`）必须对齐，严禁出现已过时的“20~25s”历史残留文案与 `Math.min(30)` 硬编码截断；
7. **全链路安全防护硬门禁**：三权分立权限校验、Fail-Closed 默认拒绝、SSRF 深度拦截、恒定时间比对、反脱敏保真必须 100% PASS。

---

## 5. 全平台双轨 UI 对齐与前后端能力一致性三大红线

> **红线背景**：历史迭代曾发生底层已升级支持 300s 深度思考长超时，但 EdgeOne 控制台界面漏改、提示文案仍写 20~25s、JS 保存时被 `Math.min(30)` 截断的严重缺陷。为杜绝此类问题，确立以下不可逾越的红线：

### 🛑 红线 1：双端 Web UI 唯一真理源开发红线 (Single-Source UI SSOT)
- 严禁直接手动修改 `vm-app/static/` 或 `agent-edgeone/admin.*` 编译产物；
- 所有前端改动必须且只能在 `shared/admin/` 源码中完成，统一由 `node agent-edgeone/scripts/build-admin.mjs` 构建脚本编译分发至各端；
- **首页三行网关卡片、按钮样式、Key 胶囊必须两端 100% 对齐**，凡涉及功能特性、超时阈值、调度策略、配置参数的增删改，必须在 `shared/admin/` 中完成并重新执行打包构建。

### 🛑 红线 2：前端表单与底层内核能力严格一致红线 (UI-Engine Capability Alignment)
- **严禁前端表单限制落后于后端实际能力**：底层已支持 300s 出站长连接与 SSE 保活，前端输入框必须设定 `min="5" max="300"`，严禁前端卡在旧上限（如 120s 或 25s）；
- **严禁暗藏截断逻辑**：JS 脚本保存配置时，总调度预算必须动态自适应推导（`Math.min(600, Math.max(upTimeout, upTimeout * retries))`），绝对禁止暗中执行 `Math.min(30, upTimeout)` 等硬编码截断；
- **严禁残留误导文案**：所有提示与 Label 文案必须与系统当前版本能力严格相符，彻底清除任何陈旧的误导性建议（如“EdgeOne 建议 20~25s”）。

### 🛑 红线 3：自动化 CI 门禁与编译静态断言强卡点 (Automated Guardrails)
- 在 `agent-edgeone/scripts/build-admin.mjs` 中设置编译卡点：检测到旧文案残留、`max < 300`、`Math.min(30)` 或核心运行时函数缺失必须立即 `process.exit(1)` 抛出致命错误，阻断打包；
- 异步操作按钮（如 Key 探活「测」按钮）必须包含 `try-finally` 强制复原兜底，严禁让按钮在任何情况下消失或变成空白方框；
- 全局共享变量严禁触发 ES6 TDZ（暂存死区），统一使用全局 `window` 声明提升；
- 在 `tests/test_phase3_phase4_audit.py` 中设置测试门禁：静态扫描双端 HTML 与 JS，任何参数或文案脱节直接判为测试失败，禁止发版合入。

---

## 6. 发版 Checklist 操作 SOP (七步闭环)

每次发布新版本时，必须按顺序逐项核对：

- [ ] **Step 1: 代码自测与语法检查**
  - Python 语法检查：`python3 -m py_compile vm-app/app/*.py`
  - JS 单元测试：`node agent-edgeone/scripts/test-units.mjs`
  - 凭据安全与反脱敏测试：`python3 tests/test_secret_preservation.py`
  - 核心安全防御自动化测试：`node tests/test_security_hardening.mjs`
- [ ] **Step 2: 源码与提交零凭据审计 (Zero-Secret Audit)**
  - 使用 `git diff` 严格审计即将提交的所有变更，确认 **0 真实 API Key、0 管理员密码、0 私钥凭证** 泄漏；
  - 确保真实配置文件与本地测试套件已被 `.gitignore` 阻断。
- [ ] **Step 3: 单真理源 UI 构建与能力对齐走查 (红线核对)**
  - 前端修改必须在 `shared/admin/` 完成，运行打包构建：`node agent-edgeone/scripts/build-admin.mjs`；
  - 确保 `vm-app/static/` 与 `edge-functions/` 产物全量同步更新；
  - 检查构建输出，确保零未内联标签、核心函数完备；
  - 检查 Key 测按钮具有 `finally` 兜底，CSS 包含 `.spinner` 旋转动画。
- [ ] **Step 4: 版本矩阵统一提升 (当前版次递增)**
  - 同步递增 `version.json`, `vm-app/version.json`, `install.sh`, `vm-app/install.sh`, `shared/admin/admin.html`；
  - 重新执行 `node agent-edgeone/scripts/build-admin.mjs`，确保动态版本号注入各端。
- [ ] **Step 5: 安装脚本依赖与资产完整性核对**
  - 核对是否有新增依赖写入 `requirements.txt`；
  - 核对依赖智能跳过逻辑依然生效。
- [ ] **Step 6: 运行自动化测试硬门禁**
  - 运行 `python3 tests/test_phase3_phase4_audit.py` 与 `npm test`，确保所有断言（包括双轨 UI 对齐门禁与安全防御）ALL TESTS PASSED。
- [ ] **Step 7: 真实环境验证与文档同步**
  - 提交代码触发 GitHub Actions / EdgeOne 自动部署；
  - 生产/测试环境执行部署或升级，验证 API 200 OK 正常出字；
  - 访问管理控制台页面，确认版本号徽章更新、三行网关卡片渲染正常、测按钮正常工作；
  - 更新 `README.md` 与 `walkthrough.md` 详细记录变更。
