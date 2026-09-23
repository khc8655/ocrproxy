# OCRProxy EdgeOne 边缘函数版本 (`agent-edgeone`)

> 部署于 **EdgeOne Makers (Pages / Edge Functions)** 的无服务器大模型中转代理。
> 依托 EdgeOne 全球 3200+ 边缘节点实现零冷启动、弹性伸缩、IP 轮询池与全球 Anycast 加速。

---

## 🌟 核心特性与架构对齐

本版本与 `vm-app` 核心 Agent 模式能力 **100% 同构对齐**：

1. **智能分流策略 (`agent_routing_strategy`)**：
   - **`sticky_failover` (粘性故障转移 - 默认推荐)**：固定使用当前 Key，遭遇 429/5xx 顺延切换并**长期驻留新 Key**，杜绝多轮对话的 Key 抖动；
   - **`round_robin` (轮询负载均衡)**：按请求原子轮询各可用 Key；
   - **`priority_fallback` (优先级优先)**：按配置顺序优先使用高优先级 Key。
2. **上游参数自适应与清洗 (`normalize.js` & 流式过滤管道)**：
   - **AMD Radeon Cloud**：默认开启思考，自动将上游 SSE 流式中非标的 `choices[0].delta.reasoning` 实时转译为业界标准的 `reasoning_content`，将非标的 `event: done\ndata: [DONE]` 规整为标准 `data: [DONE]`，保证打字机流畅输出，杜绝思考阶段屏幕卡死；
   - **StepFun**：`reasoning_effort="none"` 自动转为 `"low"`，并自动注入 `reasoning_format="deepseek-style"`（以 `reasoning_content` 透传思考链）；
   - **TokenRhythm**：对象形式的 `tool_choice` 自动转为字符串 `"auto"`；
   - **Google Gemini (2.5 / 3 / 3.5+)**：自动映射 `reasoning_effort` 到 `extra_body.google.thinking_config`，并递归清洗 Tool Schema 中的 `$schema` 非标字段；
   - **CORS 浏览器预检**：支持 `/v1/chat/completions` 与 `/v1/messages` 的 `OPTIONS` 204 无鉴权预检请求，使网页端应用（如 Web 版 NextChat、LibreChat 等）无缝直连。
3. **管理后台 UI (单文件 Web App & 极简高密设计 · v2026.09.19)**：
   - **完全解耦 GitHub 规则源**：彻底抛弃依赖 GitHub 动态获取规则更新的机制，所有 15 家模型提供商及 Key 全部固化入 EdgeOne KV；
   - **首页网关直通条**：替换原有的冗长表格，首页直观呈现日期版本号 (`v2026.09.19`)、已纳管供应商数 (`15 家 (可全量下发至 VM)`)、Base URL、Client Key 及可用模型芯片，支持一键点击复制；
   - **Key 列表紧凑流式芯片 (Chip Grid)**：彻底废除整行大列表及巨大空白卡片，改为高密度流式芯片布局；当 0 个 Key 时仅显示紧凑浅灰单行提示；
   - **供应商表单三协议解耦**：添加/编辑供应商时拆分为三个独立的 Base URL（OpenAI Chat、Anthropic Messages、OpenAI Responses），输入即启用、留空即关闭，不进行任何自动补齐；
   - **协议标准命名统一**：全站规整为 `openai`、`message`、`responses`，并双向兼容底层旧字段；
   - **添加模型动态联动与专属隔离**：选择供应商时无默认项，未选时 Key 区域显示引导提示；选中某厂商后仅动态渲染该厂商名下的 Key，彻底消除跨厂商 Key 堆砌，并移除了推荐建议填入按钮；
   - **卡片移除探测与更新按钮**：供应商卡片头部移除“探测模型”按钮，顶部彻底移除“检查规则更新”按钮；
   - **彻底物理删除强提醒**：删除供应商将从 EdgeOne KV 中永久物理销毁，弹出高危二次确认弹窗并展示名下 Key、关联 Agent 模型及 Candidate 节点，级联安全解绑；
   - **全站 100% 矢量 SVG 图标**：全端彻底禁止 Emoji 表情符号（0 Emoji 审计），全面采用轻量内联 SVG 图标；
   - **配置数据无损导入/导出**：与 VM 版配置 Schema 100% 互通。

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
* `UPSTREAM_TIMEOUT_MS`: 上游读取超时时间（推荐 `30000`）。

---

## 🧪 本地开发与单元测试

```bash
cd agent-edgeone

# 1. 安装依赖
npm install

# 2. 执行 154 项自动化单元测试
npm test

# 3. 构建单文件管理后台
npm run build:admin
```
