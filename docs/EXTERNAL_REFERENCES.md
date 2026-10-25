# 外部权威文档索引 (External References)

> 本文件集中存放腾讯云 EdgeOne 官方文档、各厂商 API 文档和项目依赖的第三方规范，避免每次重复在聊天里发链接。
>
> **更新规则**：
> 1. 收到新的官方链接、或官方文档改版时，先更新本表（主题 / 链接 / 核对日期 / 影响的本仓库文档），再按需修改 `EDGEONE_RUNTIME_SPEC.md`、`SYSTEM_DESIGN_SPEC.md`、`ADMIN_UI_BACKEND_CONTRACT.md`；
> 2. 平台行为以官方文档为准；本仓库的可执行契约（schema / runtime / tests）高于过期的项目文档；
> 3. 文档更新属于零发版维护，不递增版本号、不打 tag；
> 4. 链接失效时保留标题并标注"已失效，待替换"，不要直接删除历史。

最后核对：2026-10-25

## 一、EdgeOne（腾讯云边缘安全加速平台 EO / Makers）

| 主题 | 官方链接 | 本仓库落点 | 核对日期 |
|---|---|---|---|
| Makers 概览 | https://cloud.tencent.com/document/product/1552/127415 | `docs/EDGEONE_RUNTIME_SPEC.md` | 2026-10-25 |
| 边缘函数 Runtime APIs · Fetch（出站超时/并发/64 次限制） | https://cloud.tencent.com/document/product/1552/81897 | `docs/EDGEONE_RUNTIME_SPEC.md` §一、§三、§四 | 2026-10-25 |
| `edgeone.json` 配置规范 | https://cloud.tencent.com/document/product/1552/127389 | `docs/EDGEONE_RUNTIME_SPEC.md` §二 | 2026-10-25 |
| 日志分析（Makers 控制台统一日志） | https://cloud.tencent.com/document/product/1552/127413 | `docs/EDGEONE_RUNTIME_SPEC.md` §五；本文件 §四 | 2026-10-25 |
| 可观测性（日志/监控入口） | https://cloud.tencent.com/document/product/1552/127410 | `docs/EDGEONE_RUNTIME_SPEC.md` §五 | 2026-10-25 |
| Makers 文档首页 | https://cloud.tencent.com/document/product/1552/127365 | 本文件 | 2026-10-25 |

**EdgeOne 日志重要结论（2026-10-25 核对）**：

- EdgeOne 的日志在 **腾讯云 Makers 控制台 → 日志分析** 查看，**不在 OCRProxy 自己的管理 UI**；
- 官方当前日志来源为 **SSR / Cloud Functions / Agents**；官方文档注明 **Edge Functions（`edge-functions/`）来源的日志正在规划中**（文档最近更新 2026-06-12）；
- 因此 OCRProxy EdgeOne 管理端**不提供"最近错误日志"页面**，也不应把 VM 的 `stats.error_logs` 搬到 EdgeOne；EdgeOne 侧只负责按平台规范输出结构化日志（`console.log` / `console.error`），由平台统一收集；
- VM 的"最近错误日志"是 VM 本地 `stats.error_logs`，仅适用于 VM 运行时。

## 二、厂商适配与协议文档

> 适配规则落地在 `shared/presets/<provider>.json`；本表只记录官方 API/协议入口，具体字段映射以预设 JSON 为准。

| 厂商 / 协议 | 官方文档 | 预设文件 |
|---|---|---|
| OpenAI 兼容协议 | https://platform.openai.com/docs/api-reference | `shared/presets/openai.json` |
| Anthropic Messages | https://docs.anthropic.com/en/api | `shared/presets/`（按厂商） |
| Google Gemini | https://ai.google.dev/gemini-api/docs | `shared/presets/google.json` |
| Google Vertex AI | https://cloud.google.com/vertex-ai/generative-ai/docs | `shared/presets/vertex.json` |
| DeepSeek | https://api-docs.deepseek.com/ | `shared/presets/deepseek.json` |
| StepFun 阶跃星辰 | https://platform.stepfun.com/docs | `shared/presets/stepfun.json` |
| 硅基流动 SiliconFlow | https://docs.siliconflow.cn/ | `shared/presets/siliconflow.json` |
| MiniMax | https://platform.minimaxi.com/document | `shared/presets/minimax.json` |
| 商汤 SenseNova | https://platform.sensenova.cn/doc | `shared/presets/sensenova.json` |
| NVIDIA NIM | https://docs.api.nvidia.com/nim/ | `shared/presets/nvidia.json` |
| OpenRouter | https://openrouter.ai/docs | `shared/presets/openrouter.json` |

以下预设为项目内部/聚合入口，无统一公开 API 文档，后续补充官方链接时在此登记：

`agnes`、`amd`、`bai`、`cline`、`opencode`、`tokenrhythm`。

## 三、项目内部权威文档

| 文档 | 职责 |
|---|---|
| [`ARCHITECTURE_STANDARDS.md`](../ARCHITECTURE_STANDARDS.md) | 最高架构原则与历史事故铁律 |
| [`docs/SYSTEM_DESIGN_SPEC.md`](SYSTEM_DESIGN_SPEC.md) | 系统设计、调度、数据 Schema |
| [`docs/ADMIN_UI_BACKEND_CONTRACT.md`](ADMIN_UI_BACKEND_CONTRACT.md) | 前端/后端契约、设置项生效契约 |
| [`docs/EDGEONE_RUNTIME_SPEC.md`](EDGEONE_RUNTIME_SPEC.md) | EdgeOne 运行时与超时规范 |
| [`docs/RELEASE_SPEC.md`](RELEASE_SPEC.md) | 发版节奏与门禁 |
| [`CLAUDE.md`](../CLAUDE.md) | AI 代理入口与冲突优先级 |

## 四、日志归属速查

| 运行端 | 日志在哪里 | 管理 UI 是否展示 |
|---|---|---|
| VM（FastAPI） | `journalctl -u ocrproxy` + `stats.error_logs` | VM 控制台"最近错误日志"展示 |
| EdgeOne（`edge-functions/`） | 腾讯云 Makers 控制台 → 日志分析（按官方当前支持的来源） | **不展示**；EdgeOne 控制台不提供错误日志页 |
| EdgeOne Cloud Functions / Agents | Makers 控制台 → 日志分析 → 对应来源 | 不展示 |
