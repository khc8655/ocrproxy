# OCRProxy 官方安全架构规范与红线标准 (Security Specification)

> **版本**：v1.0.0 (起效基线：v2026.10.09-10)  
> **适用范围**：OCRProxy 全架构与全平台版本（EdgeOne 边缘版、VM 服务端版、Shared 核心组件）  
> **执行原则**：本文档为 OCRProxy 系统的**最高安全准则**。任何特性迭代、代码重构、配置变更或发版上线必须 100% 符合本规范，安全防线零妥协。

---

## 目录
1. [安全愿景与核心架构基石](#1-安全愿景与核心架构基石)
2. [物理级三权分立鉴权矩阵 (Three-Role Privilege Separation)](#2-物理级三权分立鉴权矩阵)
3. [默认拒绝基线与防裸奔规范 (Fail-Closed Baseline)](#3-默认拒绝基线与防裸奔规范)
4. [网络边界防御与 SSRF 防护规范 (SSRF Protection)](#4-网络边界防御与-ssrf-防护规范)
5. [凭据脱敏与反脱敏保真机制 (Fail-Safe Secret Guard)](#5-凭据脱敏与反脱敏保真机制)
6. [密码学与接口防御标准 (Defensive Hardening)](#6-密码学与接口防御标准)
7. [代码库零秘钥铁律 (Zero-Secret Repository Policy)](#7-代码库零秘钥铁律)
8. [安全测试自动化门禁与审计 SOP](#8-安全测试自动化门禁与审计-sop)

---

## 1. 安全愿景与核心架构基石

OCRProxy 作为企业级大模型中转调度与凭据托管枢纽，承载大量昂贵的第三方大模型 API Key（OpenAI, Anthropic, Google, 阶跃, MiniMax 等）及高频核心推理业务。系统确立四大安全基石：

- **零信任 (Zero-Trust)**：系统不对网络内外部边界做任何隐式信任假定，每个接口、每个请求必须显式鉴权并校验最小权限。
- **物理级最小权限 (Principle of Least Privilege)**：彻底废除“一个密码通行所有接口”的粗暴模式，实施物理级三权分立。
- **默认拒绝 (Fail-Closed Baseline)**：当关键安全环境变量缺失或未就绪时，服务绝不默认裸奔放行，必须立即返回明确错误阻断访问。
- **纵深防御 (Defense in Depth)**：从入口鉴权、SSRF 过滤、时序攻击防御、接口脱敏、存储加密到 CI 门禁，构建多层独立安全防护网。

---

## 2. 物理级三权分立鉴权矩阵

系统严格实行**物理级三权分立**，将调用者权限彻底划分为三个互不重叠、互不包容的独立身份领域：

### 2.1 角色定义与权限矩阵

| 鉴权主体 | 对应环境变量 | 允许访问的路由与作用域 | 严禁越权的领域 (越权必 401/403) |
| :--- | :--- | :--- | :--- |
| **客户端代理金钥**<br>`Client Proxy Key` | `PROXY_API_KEY` | • `/v1/chat/completions`<br>• `/v1/models`<br>• `/v1/messages` (仅 Agent 模式)<br>• `/v1/embeddings`<br>• `/v1/rerank`<br>• `/health` (无敏感信息) | ❌ 严禁访问 Web 控制台登录<br>❌ 严禁访问 `/api/admin/*`<br>❌ 严禁访问 `/api/config`<br>❌ **绝对禁止访问 `/api/vault/*` 提取或同步凭据** |
| **系统管理员密码**<br>`Admin Password` | `ADMIN_PASSWORD` | • Web 控制台登录 (`/` 与 `/admin`)<br>• 系统设置与参数调优 (`/api/admin/settings`)<br>• 日志审计与服务重启 (`/api/admin/restart`)<br>• 模型路由与本地供应商增删改查 | ❌ **彻底剥离金库明文提取权限**：禁止用于从 EdgeOne 批量提取上游明文 Key (`/api/vault/fetch`)，防管理员密码泄露导致全网 Key 被脱库 |
| **凭据金库专钥**<br>`Vault Access Token` | `VAULT_ACCESS_TOKEN` | • `/api/vault/manifest` (读取中枢脱敏供应商清单)<br>• `/api/vault/fetch` (VM 节点按需提取加密凭据)<br>• `/api/vault/credentials` (按需获取模型授权) | ❌ 严禁访问客户端 `/v1/*` 代理端点<br>❌ 严禁访问管理控制台管理接口 |

### 2.2 防提权与越权拦截铁律
1. **严禁凭据平权**：后端代码中**绝对禁止**出现 `token == ADMIN_PASSWORD or token == PROXY_API_KEY` 式的平权放行逻辑；
2. **防金库提权**：客户端即使持有合法的 `PROXY_API_KEY`，一旦请求 `/api/vault/*` 或 `/api/admin/*`，必须直接返回 `401 Unauthorized`，严禁让客户端 Key 窃取全网金库资产。

---

## 3. 默认拒绝基线与防裸奔规范 (Fail-Closed Baseline)

历史系统若遇到管理员未设置密码或未配置 Key 时，极易产生“空密码默认放行”的灾难性缺陷。

### 3.1 强制默认拒绝规范
1. **环境变量未设必拒**：当系统中未配置 `PROXY_API_KEY` 时，所有 `/v1/*` 代理请求直接以 `401 Unauthorized`（报错 `proxy_key_unconfigured`）拦截；
2. **管理员密码未设必拒**：当未配置 `ADMIN_PASSWORD` 时，所有管理接口直接以 `503 Service Unavailable`（报错 `admin_password_unconfigured`）拦截，绝不允许空密码登录控制台；
3. **金库专钥未设必拒**：当未配置 `VAULT_ACCESS_TOKEN` 时，所有 `/api/vault/*` 接口直接以 `503 Service Unavailable`（报错 `vault_unconfigured`）拦截，绝不向未授权请求开放资产下发。

---

## 4. 网络边界防御与 SSRF 防护规范 (SSRF Protection)

系统具备向外部发起请求的能力（如模型探活、自定义供应商验证、拉取预设规则）。为防止恶意构造 `base_url` 攻击内网基础设施，实施严格的 SSRF 深度过滤体系。

### 4.1 URL 安全校验标准 (`validateUpstreamUrl`)
所有外部请求在执行 `fetch` 或 `httpx.get/post` 之前，必须且只能通过内置的深度校验函数：

1. **协议白名单**：严格仅允许 `http:` 与 `https:` 协议；拦截 `file:`, `gopher:`, `ftp:`, `data:` 等危险协议；
2. **私有网络阻断 (RFC 1918)**：
   - `10.0.0.0/8`
   - `172.16.0.0/12`
   - `192.168.0.0/16`
3. **本地环回地址阻断**：
   - `127.0.0.0/8` (含 `127.0.0.1`)
   - `localhost`
   - IPv6 环回 `::1`, `[::1]`
4. **链路本地与多播阻断 (RFC 3927)**：
   - `169.254.0.0/16`
   - `224.0.0.0/4`
5. **云厂商元数据服务阻断 (Cloud Metadata Service)**：
   - 严禁访问 `169.254.169.254`（AWS, Azure, GCP, 腾讯云, 阿里云实例元数据接口），彻底消除云服务器 IAM 角色凭证失窃风险。

---

## 5. 凭据脱敏与反脱敏保真机制 (Fail-Safe Secret Guard)

为保护上游 Key 在前端传输与展示过程中的安全性，同时兼顾保存时的稳定性，系统实行全链路凭据保真防御机制：

### 5.1 界面反显静态脱敏
- 控制台在向前端返回已存储的 API Key 时，必须强制执行掩码脱敏（如只保留首尾：`rc-20e7***fcb3` 或纯占位符 `******`）；
- 严禁在浏览器端页面源码或普通 GET 请求中暴露未掩码的明文 Secret。

### 5.2 反脱敏保真防护 (Fail-Safe Secret Guard)
- **痛点**：当用户在 Web 控制台仅修改了模型名称或超时时间并点击“保存”时，表单会将已脱敏的占位符（如 `sk-***`）原样提交到服务端；如果服务端粗暴覆盖，会导致磁盘中的真实 Key 被永久篡改为废字符串；
- **双重拦截还原机制**：
  1. **接口层拦截**：管理接口在反序列化提交配置时，检测到包含 `***` 的掩码 Key，自动保留磁盘现存的有效明文；
  2. **加密内核拦截**：底层加密存储模块在落盘前执行保真审计，杜绝任何掩码占位符写入物理持久化介质。

### 5.3 物理磁盘存储加密
- VM 端的持久化文件 `proxy_config.enc` 必须使用 **AES-128-CBC + HMAC-SHA256 (Fernet 规范)** 进行对称加密；
- 解密密钥由系统初始化时自动生成并在本地 `.env`（`FERNET_SECRET_KEY`）严格以 `600` 权限独立存放，确保物理文件防拷贝脱库。

---

## 6. 密码学与接口防御标准 (Defensive Hardening)

### 6.1 恒定时间密码比对 (Constant-Time Verification)
- 鉴权函数中比较密钥或密码时，**严禁使用常规运算符 `===` 或 `==`**（字符逐位比对会导致微秒级时序泄漏）；
- 必须统一采用恒定时间比对算法（Node.js 端采用 `crypto.timingSafeEqual` 或自研等长掩码异或比对；Python 端采用 `secrets.compare_digest`），从密码学上彻底杜绝 Timing Attack 爆破攻击。

### 6.2 CORS 跨域分层收敛
- **客户端代理接口 (`/v1/*`)**：开放标准跨域头 (`Access-Control-Allow-Origin: *`)，供 Web 端 AI 工具调用；
- **管理与金库接口 (`/api/*`)**：**彻底移除全局通配跨域头**，遵循严格同源策略或仅允许授权 Origin，防御 CSRF 与跨域劫持。

### 6.3 接口暴露收敛与指纹伪装
- **彻底废除危险探测端点**：下线历史遗留的 `/check-ip` 裸奔接口（返回 404）；
- **调试接口深度脱敏**：`/api/debug` 强制要求管理员密码鉴权，且必须在响应中物理剥离 `env_keys` 及敏感环境变量；
- **服务端响应头加固与伪装**：
  - 强制注入 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: strict-origin-when-cross-origin`；
  - 强制擦除 `Server: uvicorn` 指纹，统一伪装为标准 `Server: webserver`。

---

## 7. 代码库零秘钥铁律 (Zero-Secret Repository Policy)

> [!CAUTION]
> **开源与公网托管铁律：任何真实的生产 API Key、服务器私钥、管理员密码绝对禁止以任何形式提交至 Git 版本库！**

1. **`.gitignore` 严格阻断**：
   - 必须将 `.env`、`*.enc`、`proxy_config`、`*.pem`、`*.key`、`*.install_secrets.json` 纳入忽略；
   - 必须将包含本地真实测试密钥的测试用例（`tests/`、`scratch/`）在开源推送中严格阻断。
2. **示例文件强制虚拟化**：
   - 仓库中的 `.env.example` 或测试配置必须使用显式虚构占位符（如 `rc-your-amd-key-here`、`sk-ocrproxy-demo-key`），绝对禁止写入个人真实 Key。
3. **历史泄露应急处置规约 (Zero-Tolerance Purge SOP)**：
   - 一旦发现历史提交包含任何真实凭据，**严禁使用 `git revert` 掩耳盗铃**；
   - 必须立即执行标准两步法：
     - ① **立即吊销并更换所有已泄露的上游 API Key 与管理员密码**；
     - ② **在本地完成冷备份后，使用 `git-filter-repo` 对 Git 树进行全量物理深度擦除并强推覆盖**。

---

## 8. 安全测试自动化门禁与审计 SOP

系统确立了“代码未经安全自动化测试，绝对禁止宣布交付或发版”的铁性门禁：

### 8.1 必经安全门禁命令
在任何发版前，必须在本地完整运行全量安全断言测试并确保 **100% PASS**：

```bash
# 1. 运行核心安全防御自动化测试 (6 项专项防御断言)
node tests/test_security_hardening.mjs

# 2. 运行凭据反脱敏保真与密钥安全回归测试
python3 tests/test_secret_preservation.py

# 3. 运行多源网络与版本安全检测测试
python3 -m unittest tests/test_check_update_multi_source.py

# 4. 运行全平台发版硬性门禁测试套件
python3 tests/test_phase3_phase4_audit.py
```

### 8.2 安全门禁 Checklist (五项必达)
- [ ] 1. 三权分立生效验证：使用 `PROXY_API_KEY` 访问 `/api/vault/fetch` 与 `/api/admin/config` 必须被 401 拦截。
- [ ] 2. 默认拒绝生效验证：清空环境变量时访问接口必须返回 503 明确报错，无任何静默放行。
- [ ] 3. SSRF 防线验证：测试探活 `http://127.0.0.1:8787` 与 `http://169.254.169.254` 必须被物理阻断。
- [ ] 4. 反脱敏保真验证：提交带 `***` 占位符的表单后，磁盘中的原始有效密钥 100% 保持完整。
- [ ] 5. 源码审计验证：使用 `git diff` 检查所有即将提交的代码，确认 0 真实密钥泄露。
