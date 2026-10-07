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

在发版前，必须运行本地自动化测试套件：
```bash
python3 tests/test_phase3_phase4_audit.py
```

### 4.1 核心断言项（缺失即失败）
1. `version.json["version"] == vm-app/version.json["version"] == install.sh SCRIPT_VERSION == vm-app/install.sh SCRIPT_VERSION`；
2. `vm-app/static/admin.html` 底部所有 script 标签的 `?v=` 查询串必须匹配当前版本号；
3. `install.sh` 与 `vm-app/install.sh` 核心逻辑 100% 同步；
4. `install.sh` 包含系统依赖智能跳过与 Python 依赖智能跳过检测点；
5. `install.sh` 包含完整资产部署拷贝清单（`app`, `static`, `scripts`, `shared`, `requirements.txt`, `version.json`）。

---

## 5. 发版 Checklist 操作 SOP

每次发布新版本时，必须按顺序逐项核对：

- [ ] **Step 1: 代码自测与语法检查**
  - 使用项目虚拟环境对所有修改文件运行语法与静态检查：
    `python3 -m py_compile vm-app/app/*.py`
- [ ] **Step 2: 版本矩阵 6 处统一提升**
  - 同步递增 `version.json`, `vm-app/version.json`, `install.sh`, `vm-app/install.sh`, `vm-app/static/admin.html`, `shared/admin/admin.html`。
- [ ] **Step 3: 安装脚本依赖与资产完整性核对**
  - 核对是否有新增依赖写入 `requirements.txt`；
  - 核对依赖智能跳过逻辑依然生效。
- [ ] **Step 4: 运行自动化测试硬门禁**
  - `python3 tests/test_phase3_phase4_audit.py`，确保 ALL TESTS PASSED。
- [ ] **Step 5: 真实环境验证与截图存证**
  - 生产/测试环境执行部署或升级，验证 API 200 OK 正常出字；
  - 使用无头浏览器验证控制台，确保 Console 0 报错；
  - 更新 `README.md` 与 `walkthrough.md` 详细记录变更。
