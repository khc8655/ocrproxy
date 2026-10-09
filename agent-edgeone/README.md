# OCRProxy EdgeOne 边缘函数版本 (`agent-edgeone`)

> 部署于 **腾讯云 EdgeOne Makers (Pages / Edge Functions)** 的无服务器大模型中转代理。  
> 依托 EdgeOne 全球 3200+ 边缘节点实现零冷启动、弹性伸缩、IP 轮询池与全球 Anycast 极速网络加速。  
> 当前版本：**`v2026.10.09-06`**

---

## 🌟 核心特性与架构对齐

本版本与 `vm-app` 核心 Agent 模式能力 **100% 同构对齐**：

### 1. 智能分流策略 (`agent_routing_strategy`)
- **`sticky_failover` (粘性故障转移 - 默认推荐)**：固定使用当前可用 Key，遭遇 429/5xx 顺延切换并**长期驻留新 Key**，杜绝多轮对话的 Key 频繁抖动；
- **`round_robin` (轮询负载均衡)**：按请求原子轮询各可用 Key，均匀打散并发压力；
- **`priority_fallback` (优先级优先)**：按配置顺序优先使用高优先级 Key。

### 2. OpenAI & Anthropic 零拷贝极速透传与长思考 300s 超时破除 (v2026.10.08)
- **两阶段流式竞速预握手 (Two-Phase Race Peek + Pre-Keepalive Pipeline)**：
  * **快速竞速窗口 (1500ms)**：当上游在 1.5 秒内极速返回首个 chunk 或快速报错（400/401/429/空流）时，保持原汁原味快速错误侦测与 Key Failover 机制；
  * **长思考自适应长连接握手 (> 1500ms)**：若上游大模型正在进行长时间思考（如 DeepSeek-R1、Claude 3.7 Thinking、超长文档 Prefill），1.5 秒立即向客户端返回 `HTTP 200 OK`，握手时间（TTFB）严格压在 1.5 秒；
  * **前置标准 SSE 注释心跳 (`: keep-alive\n\n`)**：每 5 秒在管道中向客户端注入一次 RFC 8895 标准注释行，持续刷新 EdgeOne 入口网关的空闲检测定时器，彻底破除 25 秒断开限制；
  * **官方 300 秒 Fetch 超时全额支持**：出站 fetch 显式配置 `readTimeout: 300,000ms`（5 分钟），模型生成第一个 token 以及后续 token 时无缝通过管道流入客户端；
  * **100% 保持全球 Anycast 边缘多 IP 特性**：完全由 EdgeOne 全球 3200+ 分布式节点直接发起公网请求，无需挂靠任何固定服务器机房 IP。
- **非流式响应零序列化 (`rawBytes` 直通)**：
  * 上游响应直接以底层原始字节 `rawBytes` 透传给客户端，彻底消除在边缘节点反序列化 `resp.json()` 与二次 `JSON.stringify()` 的 CPU 与内存开销；
- **流式 SSE 纯字节透传**：
  * 彻底铲除流式数据包正则拦截器与 chunk 字符替换，原始 SSE 字节流直达客户端，极大降低边缘计算资源消耗并消除打字机卡顿；
- **除 Gemini 外思考等级不转化原则**：
  * 彻底清除 MiniMax、StepFun、AMD、B.AI、Agnes 的思考等级篡改逻辑，所有厂商原汁原味透传；
  * **唯一例外保留**：严格仅针对 Google AI Studio 与 Vertex AI 保持 Thinking Config 思考等级矩阵映射以及 Tool Schema `$schema` 深度清洗；
- **Tool Choice 结构化原生支持**：
  * 全面禁用 `normalize_choice_to_string`，完美支持现代 Agent（Cursor, Cline, Claude Code）传入特定对象级函数调用规范；
- **CORS 浏览器预检**：
  * 支持 `/v1/chat/completions` 与 `/v1/messages` 的 `OPTIONS` 204 无鉴权预检请求，网页端应用（如 Web 版 NextChat、LibreChat 等）无缝直连。

### 3. 双层存储职责分离：静态预设内联 vs KV 私有状态
- **公共适配预设 (`lib/presets/index.js`)**：
  * 由 `shared/presets/*.json` 在构建阶段通过 `npm run build:presets` 编译生成静态常量；
  * 内联打包进边缘函数代码包，运行时直接从内存读取，**完全不读写 KV**，零延迟、零 KV 读写计费；
- **EdgeOne KV 存储 (`agent_kv`)**：
  * **仅用于存储用户私有数据**：包含管理员保存的真实上游 API Keys、自定义模型路由表、全局超时与中枢配置；
  * 存储运行时动态状态：如 Key 连续失败计数与熔断冷却标记（`cd_*`, `fails_*`）；
  * **保护机制**：Git 提交绝对不会自动覆写 KV，防止用户的生产私有密钥和路由被误冲毁。

### 4. 单真理源管理后台 UI (SSOT · v2026.10.09-06)
- **唯一真理源开发与自动构建**：前端源码以 `shared/admin/` 为唯一样式与视图中心，通过 `node scripts/build-admin.mjs` 自动化内联编译输出至单文件边缘函数，杜绝维护两套 UI 代码；
- **首页三行网关卡片与 VM 100% 对齐**：Base URL（含一键复制）、Client Key（含一键复制）与可用模型胶囊（点击模型名即刻复制全部与单个）完全一致；
- **探活与连通性健壮性防护**：消除 ES6 TDZ（暂存死区）异常，补齐旋转动画 `.spinner` 样式，在 `finally` 块中加入强制复原兜底，确保测试按钮永不消失；
- 详见 [单真理源设计规范说明](file:///Users/xk/Documents/ocrprox/shared/docs/ui-single-source-design.md) 与 [核心架构铁律十](file:///Users/xk/Documents/ocrprox/ARCHITECTURE_STANDARDS.md)。

---

## 🚀 EdgeOne Makers 单仓库一键部署指南

由于项目已预置经过深度调优的 `edgeone.json` 配置文件，EdgeOne Makers 将**自动读取构建命令、安装命令、Node 20 版本及 API/控制台零缓存网络规则**：

### 1. EdgeOne 控制台创建项目
在 [EdgeOne 控制台](https://console.cloud.tencent.com/edgeone) 创建 Makers 项目：
* **Git 仓库**：选择 `https://github.com/khc8655/ocrproxy`
* **根目录 (Root Directory)**：填写 **`agent-edgeone`**
* **构建与运行设置**：系统将自动读取 `edgeone.json`（已内嵌 `npm run build:admin`、Node 20、禁用 API 缓存、开启 SSE 流式直通 `X-Accel-Buffering: no` 与全域 CORS）。

### 2. KV 命名空间绑定
* 在 EdgeOne 控制台「KV 存储」中创建一个名为 **`agent_kv`** 的命名空间；
* 在项目设置的「KV 绑定」中，将变量名 `agent_kv` 绑定到该命名空间。

### 3. 环境变量配置
在项目环境变量中配置：
* `PROXY_API_KEY`: 客户端调用 `/v1/*` 接口所需的 Bearer Token；
* `ADMIN_PASSWORD`: Web 管理后台登录密码；
* `UPSTREAM_TIMEOUT_MS`: 上游读取超时时间（默认为 `300000`，即 5 分钟，支持深度思考大模型）。

---

## 🧪 本地开发与构建命令速查

```bash
cd agent-edgeone

# 1. 安装开发依赖
npm install

# 2. 编译模型厂商预设 (从 shared/presets/*.json 编译为内置常量)
npm run build:presets

# 3. 编译管理后台单文件 (从 shared/admin/ 编译为 admin.html)
npm run build:admin

# 4. 执行 EdgeOne 适配器 10 项单元测试 (在仓库根目录下运行)
node ../tests/test_edgeone_normalize.mjs

# 5. 执行 EdgeOne 内置单元测试套件
npm test
```
