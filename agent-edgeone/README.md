# OCRProxy EdgeOne 边缘函数版本 (`agent-edgeone`)

> 部署于 **腾讯云 EdgeOne Makers (Pages / Edge Functions)** 的无服务器大模型中转代理。
> 依托 EdgeOne 全球 3200+ 边缘节点实现零冷启动、弹性伸缩、IP 轮询池与全球 Anycast 加速。

---

## 🌟 核心特性与架构对齐

本版本与 `vm-app` 核心 Agent 模式能力 **100% 同构对齐**：

1. **智能分流策略 (`agent_routing_strategy`)**：
   - **`sticky_failover` (粘性故障转移 - 默认推荐)**：固定使用当前 Key，遭遇 429/5xx 顺延切换并**长期驻留新 Key**，杜绝多轮对话的 Key 抖动；
   - **`round_robin` (轮询负载均衡)**：按请求原子轮询各可用 Key；
   - **`priority_fallback` (优先级优先)**：按配置顺序优先使用高优先级 Key。
2. **上游参数自适应与清洗 (`normalize.js`)**：
   - **StepFun**：`reasoning_effort="none"` 自动转为 `"low"`，并自动注入 `reasoning_format="deepseek-style"`（以 `reasoning_content` 透传思考链）；
   - **TokenRhythm**：对象形式的 `tool_choice` 自动转为字符串 `"auto"`；
   - **Google Gemini (2.5 / 3 / 3.5+)**：自动映射 `reasoning_effort` 到 `extra_body.google.thinking_config`，并递归清洗 Tool Schema 中的 `$schema` 非标字段。
3. **管理后台 UI (单文件 Web App)**：
   - **Key 重命名自动联动**：修改 Key 别名时自动级联更新所有 `agent_models` 绑定；
   - **模型二次编辑与回显**：支持在模型列表中随时二次编辑绑定的 Key 与上游别名；
   - **一键并行全 Key 探活**：在 Agent 模型卡片上一键发起所有绑定 Key 的并行请求测速；
   - **配置数据无损导入/导出**：与 VM 版配置 Schema 100% 互通。
4. **共享预设 (`shared/presets/`)**：
   - 统一引用 7 大官方预设（Google、OpenAI、SenseNova、StepFun、SiliconFlow、TokenRhythm、DeepSeek）。

---

## 🚀 EdgeOne Makers 单仓库一键部署指南

由于项目已预置经过深度调优的 `edgeone.json` 配置文件，EdgeOne Makers 将**自动读取构建命令、安装命令、Node 20 版本及 API/控制台零缓存网络规则**：

### 1. EdgeOne 控制台创建项目
在 [腾讯云 EdgeOne 控制台](https://console.cloud.tencent.com/edgeone) 创建 Makers 项目：
* **Git 仓库**：选择 `https://github.com/khc8655/ocrprox`
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

# 2. 执行 109 项自动化单元测试
npm test

# 3. 构建单文件管理后台
npm run build:admin
```
