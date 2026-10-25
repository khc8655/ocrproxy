# 《OCRProxy EdgeOne 官方运行时与超时架构规范》

> **状态**：正式发布（Normative Standard）  
> **制定基准**：严格以腾讯云 EdgeOne 官方权威文档为唯一真理源：
> 1. [Runtime APIs - Fetch (文档 81897)](https://cloud.tencent.com/document/product/1552/81897)
> 2. [edgeone.json 配置规范 (文档 127389)](https://cloud.tencent.com/document/product/1552/127389)
> 3. [Makers Functions 概览 (文档 127415)](https://cloud.tencent.com/document/product/1552/127415)
> 4. [日志分析 (文档 127413)](https://cloud.tencent.com/document/product/1552/127413)
>
> 所有外部文档链接统一登记在 [`docs/EXTERNAL_REFERENCES.md`](EXTERNAL_REFERENCES.md)。

---

## 一、官方超时标准与分层模型

### 1. 边缘出站超时标准 (Edge Functions Fetch)
根据官方文档 81897：
- **默认超时时间**：15 秒（未显式传递 `timeoutSetting` 时平台默认截断）；
- **最大配置上限**：**300 秒**（通过 `requestInit.eo.timeoutSetting` 精确控制）；
- **配置语法**：
  ```javascript
  eo: {
    timeoutSetting: {
      connectTimeout: 10000, // 建立连接超时 (ms)
      readTimeout: 300000,   // 读取响应超时 (ms)，最大 300s
      writeTimeout: 30000,  // 发送数据超时 (ms)
    }
  }
  ```
- **官方硬限制**：
  - 单次运行请求总次数上限：**64 次**（超出抛出运行时异常）；
  - 单次运行请求最大并发数：**8**（超出部分被平台延迟挂起）。

### 2. 客户端保活心跳机制的职责边界
- **RFC 8895 SSE 保活心跳**（每 20 秒发送一次 `: ping\n\n`）的唯一职责是：
  * **防止下游断开**：维持终端客户端（如 ChatGPT Web / NextChat / Cursor）、移动网络运营商 NAT 状态表、以及用户自建反向代理的 TCP 连接活跃；
  * **杜绝误区**：EdgeOne 本身在出站侧原生支持 300 秒等待，心跳保活面向的是**下游客户端链路**，而非绕过边缘网关自身的限制。严禁任何“破除 EdgeOne 25 秒断开限制”等已证伪的历史误导性文案。

### 3. 云端函数与 Agent 超时规格 (Cloud Functions & Agents)
根据官方文档 127389 与 127415：
- **Cloud Functions (`cloud-functions/v1.py`)**：
  * 单次最大运行时长：**10 ~ 120 秒**（默认 30 秒）；
  * 必须在 `edgeone.json` 显式配置：`"cloudFunctions": { "python": { "maxDuration": 120 } }`；
  * 适用场景：大请求体（> 1MB）或长文本数据处理的云端兜底。
- **Agents**：
  * 单次任务执行最大秒数：**30 ~ 3600 秒**；
  * 沙箱存活时长：**300 ~ 3600 秒**。

---

## 一.5 日志与可观测性（官方归属）

- EdgeOne 的日志统一在 **腾讯云 Makers 控制台 → 日志分析** 查看，**不在 OCRProxy 管理 UI**；不要在 EdgeOne 控制台新增"最近错误日志"页面。
- 官方日志来源当前为 **SSR / Cloud Functions / Agents**；官方文档注明 **Edge Functions（`edge-functions/`）日志正在规划中**（文档 127413，最近更新 2026-06-12）。EdgeOne 侧代码按平台规范输出结构化 `console.log` / `console.error`，由平台统一收集。
- VM 的 `stats.error_logs` / "最近错误日志"仅属于 VM 运行时；EdgeOne 不复制该页面。
- 本仓库外部文档索引见 [`docs/EXTERNAL_REFERENCES.md`](EXTERNAL_REFERENCES.md)。

---

## 二、`edgeone.json` 官方字段与路径匹配红线

### 1. 允许声明的标准字段
严格只允许出现官方 127389 文档支持的字段：
`buildCommand`, `installCommand`, `outputDirectory`, `nodeVersion`, `redirects`, `rewrites`, `headers`, `cloudFunctions`, `schedules`, `agents`。
**严禁添加** `build`, `functions`, `routes`, `kv`, `env` 等非官方臆造字段。

### 2. 网关 Headers 的 `source` 路径匹配规范
根据官方规范：
- `source` 仅支持**精确路径**（如 `/admin`）、**占位符**（如 `:id`）与**单个 `*` 通配符**（如 `/v1/*`）；
- `source` 中最多包含一个 `*`；
- **严禁使用正则表达式语法**（如 `(/.*)?`、`(api|v1)`、`?` 等），否则规则无法在 CDN 边缘层命中。

标准响应头声明：
```json
"headers": [
  { "source": "/v1/*", "headers": [{ "key": "Cache-Control", "value": "no-store" }, { "key": "X-Accel-Buffering", "value": "no" }] },
  { "source": "/api/*", "headers": [{ "key": "Cache-Control", "value": "no-store" }, { "key": "X-Accel-Buffering", "value": "no" }] },
  { "source": "/admin", "headers": [{ "key": "Cache-Control", "value": "no-cache" }] },
  { "source": "/admin/*", "headers": [{ "key": "Cache-Control", "value": "no-cache" }] },
  { "source": "/*.html", "headers": [{ "key": "Cache-Control", "value": "no-cache" }] }
]
```

---

## 三、出站 Fetch 防降级与重定向规范 (`redirect: 'manual'`)

### 1. 自动跟随重定向的严重危害
根据官方文档 81897，Web APIs `fetch` 默认 `redirect: 'follow'`。遇到 301/302 时，WHATWG 标准规定：
- **POST 会被静默转换为 GET，且 Body 请求体被完全丢弃**；
- 导致大模型请求变成一个空 Body 的 GET 请求发往目标服务器，直接报错 404/405；
- 每次重定向均计入 64 次 fetch 上限；
- 存在将包含管理员或上游私钥的 `Authorization` 头泄露给跨域重定向目标的风险。

### 2. 防重定向降级铁律
所有代理转发的大模型出站请求，必须显式指定 `redirect: 'manual'`：
```javascript
upstreamResp = await fetch(url, {
  method: 'POST',
  headers: upstreamHeaders,
  body: bodyBytes,
  redirect: 'manual', // 严禁自动跟随重定向
  eo: {
    timeoutSetting: {
      connectTimeout: 10000,
      readTimeout: upstreamTimeoutMs,
      writeTimeout: 30000,
    },
  },
});
```

### 3. 遇到 3xx 重定向的处置原则
当上游响应状态码处于 `300 <= status < 400` 时：
1. **不进行 Failover**：因为同提供商下所有 Key 均会受同一 Base URL 影响；
2. **不触发 Key 级冷却**：Key 本身有效，系 Base URL 误填（如缺少 `https://` 或末尾路径有误）；
3. **即刻向客户端报告错误**：返回 HTTP 502，明确提示 `"Base URL 配置错误: 上游返回 HTTP 3xx 重定向，请检查 Base URL 是否正确"`。

---

## 四、并发度与请求次数治理

### 1. 并发度约束
- 官方单请求并发上限为 8。
- 批量探活（如 `api/test.js`）必须使用固定并发度的 Worker Pool，并发数严格限制为 `6`（预留 2 个并发缓冲）；
- 探活延迟（`latency_ms`）必须在 Worker 执行真正的 `fetch` 前瞬间打点，剔除队列排队等待时间。

### 2. 请求次数约束
- 官方单请求上限为 64 次 fetch。
- 单次批量探测入参必须严格截断至最多 `60` 项（预留 4 次余量）；超出部分由前端分页请求。
