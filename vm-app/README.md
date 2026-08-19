# OCRProxy VM 版 — 统一大模型中转与故障自动切换服务

提供 **Chat / Embedding / Reranker / OCR** 四类标准大模型能力的统一中转接口，支持多 Key 轮询、自动故障切换、熔断保护。同时提供 **Agent 模式**——Agent 直接使用真实模型名调用标准 OpenAI 接口，429/500 自动切换到同一模型的其他供应商。专为低配 VM（2 核 / 1.6 GB）设计，在突发高并发入库场景下保持内存安全。

## 核心特性

### 双模式路由

本服务支持两种路由模式，共用同一组 `/v1/*` 接口：

| 模式 | 触发方式 | 行为 |
|------|----------|------|
| **KB 入库模式** | `model` 为虚拟别名（`chat`/`embedding`/`reranker`/`ocr`） | 使用 `candidates` 中对应类型的全部候选轮询，chat 禁用思考，**始终快速**（非流式 + 短超时，写死无需配置） |
| **Agent 模式** | `model` 为真实模型名（如 `deepseek-v4-flash`） | 从**模型为主的 `agent_models` 字典**取该模型的 Key 列表按序调用，429/500 自动切换下一个 Key；支持 `upstream_model` 上游 ID 重写 |

- **Agent 模式完全透明**：不修改请求体，Agent 发什么就传什么（tools、reasoning_effort、stream 等全部原样传递）。仅对极少数上游不兼容的字段值做规范化（如 StepFun 不接受 `reasoning_effort="none"` → 自动降级为 `"low"`；TokenRhythm 不接受对象形式 `tool_choice` → 自动转为 `"auto"`），避免 400 错误
- **Agent 模式故障切换**：同一模型在 `agent_models` 配置多个供应商/Key 时，429/500 自动切换到下一个
- **独立管理**：`agent_models`（Agent 中转）与 `candidates`（知识库 4 个虚拟模型）完全分离，管理面板有独立「Agent 模型」Tab
- **`/v1/models` 只返回 `agent_models` 的真实模型**，不包含 4 个虚拟别名（知识库工具的示例代码直接写死虚拟名，无需从列表获取）
- **KB 入库模式**：chat 始终禁用思考（按上游机制注入对应参数：SenseNova/TokenRhythm → `reasoning_effort=none`、StepFun → `reasoning_effort=low`、Agnes → `chat_template_kwargs={enable_thinking:false}`）且**始终快速**（强制非流式 + `chat_fast_timeout` 短超时）——批量入库无需交互式流式与推理，已写死、无开关

### 路由与故障转移

- **统一接口**：`/v1/chat/completions`、`/v1/embeddings`、`/v1/rerank`、`/v1/ocr` 标准 API，兼容 OpenAI SDK
- **多 Key 轮询**：按候选序列轮询多个上游 Key，支持拖拽调整优先级
- **故障自动切换**：429 冷却 60s、403 鉴权失败冷却 10min（403 额度耗尽智能缩短为 60s）、5xx 冷却 30s；400 智能区分 Key/账户问题（冷却 10s 并切换）与请求级错误（参数/格式/内容审核等，立即短路退出不冷却、不来回无意义重试），连续失败 3 次触发熔断（300s）
- **请求级 400 精准短路**：当上游返回请求级 400（参数不受支持、上下文超长、内容审核等）时，直接原样返回响应并终止重试，彻底杜绝在同供应商内部（如 `自己 -> 小号`）来回切换浪费网络开销与延时
- **Per-Type 状态分离**：同一 Key 用于 chat 和 OCR 时，后台状态统计按模型类型独立记录，互不覆盖
- **预算自适应**：故障转移总预算随候选数量自动扩展，确保至少 3 次切换尝试
- **延迟感知路由**（可选）：根据历史延迟自动排序候选节点，默认关闭以保持与 UI 配置顺序一致

### 并发与内存安全

- **全局并发背压**：整个进程最多 30 个在途上游请求，超出自动排队（不丢请求、不 OOM）
- **Per-Key 并发限制**：每个 Key 独立并发限制（默认 5），防止打崩上游配额
- **OCR 内存优化**：base64 图片只构建一次 data-URL，原始请求体提前释放，内存拷贝从 3 份降至 1 份
- **全响应资源释放**：所有上游响应（成功/失败/流式/非流式）在不再需要时立即调用 `resp.aclose()` 归还连接池，防止高并发下的连接泄漏
- **请求体大小限制**：chat/embedding/rerank 端点 10MB 硬上限，OCR 端点 20MB（base64 图片固有更大），在解析 JSON 前即拒绝超大请求体
- **malloc_trim 回收**：OCR 完成后主动调用 `gc.collect()` + `libc.malloc_trim(0)` 归还堆页给内核
- **MALLOC_ARENA_MAX=2**：从源头消除 glibc ptmalloc2 多 arena 碎片问题

### 运维与安全

- **假死自动恢复**：每 60s 健康检查，10s 无响应自动重启
- **每日定时重启**：凌晨 04:00 自动重启释放累积堆内存
- **systemd 内存限制**：MemoryHigh=768M 触发回收压力，MemoryMax=1024M 硬上限防 OOM 全机挂
- **加密存储**：配置文件使用 Fernet 对称加密，密钥不落盘明文
- **配置导入与导出**：支持一键导出带时间戳的完整配置 JSON 备份；导入支持“完全覆盖”与“增量合并”双模式，导入前自动生成 `.bak` 快照并严格校验 Schema
- **角色权限隔离**：`/api/admin/*` 管理端严格限制为 `ADMIN_PASSWORD`，普通 `PROXY_API_KEY` 无法访问管理接口，防止凭证泄露与越权
- **安全加固**：systemd 沙箱隔离、SSRF 防护（DNS Rebinding 校验与 302 重定向拦截）、常量时间密钥比较
- **Web 管理面板**：可视化配置供应商、Key、路由优先级，实时统计监控

## 快速部署

### 1. 上传到 VM

```bash
scp -r vm-app/ root@your-server:/tmp/ocrproxy-install
```

### 2. 一键安装

```bash
ssh root@your-server
cd /tmp/ocrproxy-install
sudo bash install.sh
```

安装脚本自动完成：
- 创建专用系统用户 `ocrproxy`
- 创建 Python 虚拟环境并安装依赖
- 生成 Fernet 加密密钥、`PROXY_API_KEY`、`ADMIN_PASSWORD`
- 创建加密的配置文件
- 配置 systemd 服务 + 健康检查定时器 + 每日重启定时器
- 设置严格的文件权限

### 3. 配置 Caddy 反向代理

```
your-domain.com {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
}
```

```bash
sudo systemctl reload caddy
```

### 4. 访问管理面板

打开 `https://your-domain.com/`，使用安装时生成的 `ADMIN_PASSWORD` 登录。

### 更新已部署的 VM（从本机发布）

代码通过 rsync 发布到 VM（保留 `config/`、`.env`、`venv/`），随后更新 systemd 单元并重启：

```bash
KEY=~/path/to/key.pem
VM=ubuntu@your-server

# 1. 同步代码到暂存目录并安装（排除运行时数据）
rsync -az -e "ssh -i $KEY" --exclude __pycache__ \
  app scripts static requirements.txt README.md install.sh \
  ocrproxy*.service ocrproxy*.timer Caddyfile.example client \
  $VM:/tmp/deploy-staging/
ssh -i $KEY $VM '
  sudo rsync -a --delete --exclude venv --exclude .env --exclude config \
       /tmp/deploy-staging/ /opt/ocrproxy/
  sudo chown -R ocrproxy:ocrproxy /opt/ocrproxy
  sudo cp /tmp/deploy-staging/ocrproxy.service /etc/systemd/system/ocrproxy.service
  sudo systemctl daemon-reload && sudo systemctl restart ocrproxy
  curl -sf http://127.0.0.1:8787/health'
```

> systemd 单元变更（如 `--limit-concurrency`）必须先 `daemon-reload` 再 restart；Caddyfile 的 `request_body max_size` 等站点变更需 `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`。改完配置后可执行 `sudo -u ocrproxy /opt/ocrproxy/venv/bin/python scripts/load_test.py` 在 VM 上跑完整回归（9 项行为 + 内存验证），也可运行 `scripts/agent_test.py`（27 项 Agent 中转）和 `scripts/stability_test.py`（17 项稳定性/加固）。

## 接口调用

### Chat — KB 入库模式（虚拟别名）

适用于知识库批量入库。禁用思考（按上游机制注入对应参数），**始终**强制非流式 + 短超时（`chat_fast_timeout`，默认 30s）——已写死，无需任何开关：

```bash
curl -X POST https://your-domain.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "chat", "messages": [{"role": "user", "content": "你好"}]}'
```

### Chat — Agent 模式（真实模型名）

Agent 直接使用配置的真实模型名，完全透明，429/500 自动切换：

```bash
curl -X POST https://your-domain.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek-ai/DeepSeek-V3", "messages": [{"role": "user", "content": "你好"}], "stream": true}'
```

### 查看可用模型

```bash
curl https://your-domain.com/v1/models \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY"
```

返回所有真实模型名（Agent 模式用）+ 虚拟别名（KB 模式用）。

### Embedding 向量

```bash
curl -X POST https://your-domain.com/v1/embeddings \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "embedding", "input": "需要向量化的文本"}'
```

### Reranker 重排

```bash
curl -X POST https://your-domain.com/v1/rerank \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "reranker", "query": "查询文本", "documents": ["文档1", "文档2"]}'
```

### OCR 识别

```bash
# 方式一：base64 图片
curl -X POST https://your-domain.com/v1/ocr \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"image_base64": "iVBORw0KGgo...", "prompt": "请识别图片中的所有文字内容"}'

# 方式二：图片 URL
curl -X POST https://your-domain.com/v1/ocr \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"image_url": "https://example.com/image.jpg", "prompt": "识别文字"}'
```

### Python SDK (OpenAI 兼容)

```python
from openai import OpenAI

client = OpenAI(
    api_key="your_proxy_api_key",
    base_url="https://your-domain.com/v1"
)

completion = client.chat.completions.create(
    model="chat",
    messages=[{"role": "user", "content": "你好"}],
    stream=True
)
for chunk in completion:
    print(chunk.choices[0].delta.content, end="")
```

## 运维管理

### 常用命令

```bash
systemctl status ocrproxy              # 服务状态
journalctl -u ocrproxy -f              # 实时日志
systemctl restart ocrproxy             # 重启服务
curl http://127.0.0.1:8787/health      # 健康检查
systemctl list-timers ocrproxy-*       # 查看所有定时器
```

### systemd 组件一览

安装脚本会创建 3 个 systemd 单元：

| 单元 | 类型 | 说明 |
|------|------|------|
| `ocrproxy.service` | service | 主服务进程（uvicorn） |
| `ocrproxy-health.timer` | timer | 每 60s 健康检查，假死自动重启 |
| `ocrproxy-restart.timer` | timer | 每日 04:00 定时重启 |

### 冷却与熔断策略

调度器根据上游响应状态码执行差异化冷却，避免对正常 Key 的误判和过度惩罚：

| 状态码 | 场景 | 冷却时间 | 说明 |
|--------|------|----------|------|
| 429 | 限流 | 60s | 配置项 `cooldown_429_sec` |
| 403 | 鉴权失败 | 600s | 配置项 `cooldown_403_sec` |
| 5xx | 服务端错误 | 30s | 配置项 `cooldown_duration` |
| 200 + 空流 | 上游返回 200 但不发任何字节 | 5s | 判定为故障，自动切换下一候选 |
| 400（Key 问题） | 订阅过期、余额不足、Key 无效 | 10s | 通过错误体关键词识别（subscription/billing/quota 等） |
| 400（内容审核） | 敏感图片、违规内容 | 不冷却 | 请求级问题，不惩罚 Key；且**提前退出**不再尝试其他候选（仅匹配明确信号：content_filter / data_inspection / moderation / 中文"审核/敏感/违规"等） |
| 404 / 422 | 请求格式错误 | 不冷却 | 请求级问题 |
| ReadTimeout | 模型推理慢 | 2s | 不计入熔断，保持 Key 可用（stats 记为 599） |
| ConnectTimeout | 网络问题 | 5s | 短冷却 + 延迟降权（stats 记为 598） |

连续失败达到 `circuit_break_threshold`（默认 3 次）触发熔断，冷却时间提升至 `circuit_cooldown_sec`（默认 300s）。

其他调度行为（v3.1）：

- **全局过载快速失败**：全局并发上限 30 饱和时，新请求最多排队 2s，超限返回 `503 + Retry-After`（`code=server_overloaded`），不会无限排队占用内存。
- **排队时间计入预算**：在 Key 信号量上的排队等待消耗故障切换总预算，预算耗尽的请求不再发往上游。
- **预算封顶 180s**：agent 模式的故障切换总预算硬上限 180s（显式配置的 `schedule_total_budget` 优先）。
- **embedding / rerank 独立超时**：`upstream_timeout_embedding`（默认 60s）、`upstream_timeout_rerank`（默认 30s），并按候选数扩展预算 —— 修复了此前沿用全局 12s 超时导致一次超时就耗尽 15s 预算、其余 Key 永远轮不到的问题。
- **配置热更新即时生效**：管理面板修改 `max_concurrency_per_key` 或增删 Key 后立即生效（无需重启）；配置变化时自动清理已删除 Key 的冷却/熔断/延迟状态。`POST /v1/reload` 会额外清空全部运行时状态。

### 内存管理机制

本服务针对 2 核 / 1.6 GB 低配 VM 优化，采用多层内存安全策略：

```
请求进入
  → Caddy request_body max_size(25MB)  # 解析前拒绝超大请求
  → uvicorn --limit-concurrency 150     # 连接层背压
  → 全局 semaphore(30, 2s 快速失败)    # 背压：最多 30 个并发上游请求，超限 503+Retry-After
  → per-key semaphore(5)               # 单 Key 限流（排队时间计入预算）
  → OCR 完成后 del body/img_b64        # 立即释放原始请求体
  → gc.collect() + malloc_trim         # 归还堆页给内核
  → MALLOC_ARENA_MAX=2                 # 源头消除 glibc 碎片
  → MemoryHigh=768M                    # 内核回收压力
  → MemoryMax=1024M                    # 硬上限 OOM Kill
  → health-check (60s)                 # 假死自动重启
  → daily restart (04:00)              # 兜底清零
```

### 资源占用参考

在 2 核 / 1.6 GB VM 上的实测数据：

| 指标 | 数值 |
|------|------|
| 空闲 RSS | ~65 MB |
| 20 并发 OCR 后 RSS | ~70 MB |
| 日均 ~3000 请求（含 672 OCR） | 稳定不涨 |
| 系统可用内存 | ~1000 MB |

## 安全说明

| 安全措施 | 说明 |
|---------|------|
| 配置加密 | 所有 API Key 使用 Fernet 对称加密存储，磁盘上无明文；写入带 fsync 原子落盘 |
| 文件权限 | `.env` 和配置文件权限 600，仅服务用户可读 |
| 系统用户 | 服务运行在专用 `ocrproxy` 系统用户下，无登录权限 |
| systemd 沙箱 | NoNewPrivileges、ProtectSystem、ProtectHome 等 |
| SSRF 防护 | Key 验证接口阻止访问内网/本地/元数据地址 |
| 时序攻击防护 | 密钥比较使用 `hmac.compare_digest` 常量时间比较 |
| 仅本地监听 | 服务监听 127.0.0.1，外部访问必须经过 Caddy |
| 请求体大小限制 | Caddy `request_body max_size 25MB` + 应用层 chat/embedding/rerank 10MB + OCR 20MB + uvicorn `--limit-concurrency 150` |

> ⚠️ 若 9090 端口以明文 HTTP 直接暴露公网，`PROXY_API_KEY` 会以明文传输。建议：绑定域名启用 TLS（见 Caddyfile.example）、安全组限制来源 IP、或全部流量走 EdgeOne HTTPS 回源。

### 本地 / 线上测试套件

`scripts/mock_upstream.py` 提供可控的模拟上游（按 API key / 请求体切换 429、空流、内容审核、工具调用、SSE 回显等行为），两套测试基于它运行：

**`scripts/agent_test.py` — Agent 中转专项（27 项）**：`/v1/models` 仅含 agent_models；KB 模式强制禁思考+非流式；未知模型 404；**思考等级全量参数透传**（reasoning_effort / enable_thinking / chat_template_kwargs / thinking / temperature / top_p / seed / stop / logprobs 等逐字段比对）；工具调用（JSON + 流式 tool_calls 增量）；流式 SSE 与直连上游**逐字节一致**（含 reasoning_content）；429 / 空流故障切换；**upstream_model 公共名→上游 ID 重写**；**v3.2→v3.3 配置自动迁移**；**中转效率基准**（RTT 开销、TTFB 开销、30 并发流保真）；**Provider 规范化**（StepFun reasoning_effort="none"→"low" + reasoning_format 注入、TokenRhythm tool_choice 对象→"auto"、Agnes KB 模式 chat_template_kwargs 注入）。

**`scripts/load_test.py` — KB 调度回归（9 项）**：429 切换、空流切换、内容审核早退（仅 1 次上游调用）、KB 注入、过载快速失败（503+Retry-After）、配置热更新、状态清理、3 轮大并发 OCR 内存验证。

**`scripts/stability_test.py` — 稳定性/加固测试（17 项）**：畸形请求（无效 JSON/空 body/超深嵌套）安全处理；超大请求体（5MB）不 OOM；200 次顺序请求 fd 无泄漏；5 轮 × 50 并发 OCR RSS 收敛验证（r4→5 增量 < r1→2 增量）；500 次请求连接池稳定；上游 500 故障切换；上游超时优雅 503；客户端中途断开流式连接无 fd 泄漏；200 并发混合成功/失败不崩溃；100 个独立客户端快速连接/断开无 fd 泄漏。

```bash
python -m venv venv && venv/bin/pip install -r requirements.txt
venv/bin/python scripts/agent_test.py       # Agent 中转专项
venv/bin/python scripts/load_test.py        # KB 调度回归
venv/bin/python scripts/stability_test.py   # 稳定性/加固
# VM 线上运行（测试实例使用独立端口与隔离配置，不影响生产）：
sudo -u ocrproxy /opt/ocrproxy/venv/bin/python scripts/agent_test.py
```

参考实测（腾讯云 VM，2026-08）：Agent 套件 27/27、KB 套件 9/9、稳定性套件 17/17 全部通过（共 53 项）；中转开销 RTT p50 ≈ 3ms、流式首字节开销 ≈ 3ms；3 轮 120 并发大 OCR 后 RSS 稳定 70MB（无泄漏）；5 轮 50 并发 OCR RSS 收敛（r1→2 增 55MB，r4→5 仅增 16MB）；畸形请求、超大 body、上游 500/超时、客户端断连均不崩溃、不泄漏 fd。

## 目录结构

```
vm-app/
├── app/
│   ├── __init__.py
│   ├── main.py              # FastAPI 应用入口
│   ├── scheduler.py          # 故障转移调度器（含全局并发控制、内存回收）
│   ├── config_store.py       # 加密配置存储（带版本号，供状态清理）
│   ├── stats.py              # 内存统计模块
│   ├── auth.py               # 鉴权工具
│   ├── upstream.py           # 上游 URL 拼接（共享工具）
│   ├── proxy_routes.py       # 代理路由 /v1/*
│   └── admin_routes.py       # 管理路由 /api/admin/*
├── static/
│   └── admin.html            # 管理面板（SPA）
├── scripts/
│   ├── init_config.py        # 安装时初始化密钥与配置
│   ├── health-check.sh       # systemd timer 健康检查
│   ├── mock_upstream.py      # 测试用模拟上游（可控故障/SSE/工具调用回显）
│   ├── agent_test.py         # Agent 中转专项测试（透传/工具/流式/效率）
│   ├── load_test.py          # KB 调度回归 + 内存压测
│   └── stability_test.py     # 稳定性/加固测试（畸形请求/fd泄漏/RSS收敛/并发崩溃）
├── client/
│   ├── proxy_client.py       # Python 客户端封装
│   └── example.py            # 使用示例
├── config/
│   └── proxy_config.enc      # 加密配置文件（运行时生成）
├── install.sh                # 一键安装脚本
├── ocrproxy.service          # systemd 服务模板
├── ocrproxy-health.service   # 健康检查服务
├── ocrproxy-health.timer     # 健康检查定时器（60s）
├── ocrproxy-restart.service  # 定时重启服务
├── ocrproxy-restart.timer    # 每日重启定时器（04:00）
├── Caddyfile.example         # Caddy 反向代理配置示例
├── requirements.txt
└── README.md                 # 本文件
```

## 配置 JSON 结构

管理面板保存的配置 JSON 结构：

```json
{
  "upstream_timeout": 12,
  "upstream_timeout_chat": 120,
  "upstream_timeout_ocr": 60,
  "upstream_timeout_embedding": 60,
  "upstream_timeout_rerank": 30,
  "schedule_total_budget": 15,
  "max_concurrency_per_key": 5,
  "cooldown_duration": 30,
  "cooldown_429_sec": 60,
  "cooldown_403_sec": 600,
  "circuit_break_threshold": 3,
  "circuit_cooldown_sec": 300,
  "chat_fast_timeout": 30,      # KB 模式写死快速：非流式 + 此超时（无 chat_fast_mode 开关）
  "latency_based_routing": false,
  "providers": {
    "siliconflow": {
      "base_url": "https://api.siliconflow.cn",
      "keys": { "KeyA": "sk-xxxx" }
    }
  },
  "candidates": {
    "chat": [
      {"provider": "siliconflow", "key": "KeyA", "model": "deepseek-ai/DeepSeek-V3"},
      {"provider": "stepfun", "key": "KeyB", "model": "deepseek-ai/DeepSeek-V3"}
    ],
    "embedding": [{"provider": "siliconflow", "key": "KeyA", "model": "BAAI/bge-m3"}],
    "reranker": [{"provider": "siliconflow", "key": "KeyA", "model": "BAAI/bge-reranker-v2-m3"}],
    "ocr": [{"provider": "siliconflow", "key": "KeyA", "model": "deepseek-ai/DeepSeek-OCR"}]
  },
  "agent_models": {
    "deepseek-ai/DeepSeek-V3": {
      "upstream_model": "deepseek-ai/DeepSeek-V3",
      "keys": [
        {"provider": "siliconflow", "key": "KeyA"},
        {"provider": "stepfun", "key": "KeyB"}
      ]
    }
  }
}
```

> **v3.3 起为模型为主（model-centric）结构**：模型名是字典键（即 agent 调用时填写的 `model`），Key 绑定列表是它的属性——「创建一个模型，绑定哪些 Key」。`upstream_model` 可选（默认同模型名），用于对外模型名与上游实际 ID 不同的场景。旧的扁平列表（`[{"provider","key","model"}]`）在配置加载时**自动迁移并持久化**，无需手工处理。`candidates`（知识库 4 类）保持按类型的扁平有序池——KB 语义就是「该类任务的可用节点池，池内故意混用不同模型」。

### 配置项说明

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `upstream_timeout` | 12 | 通用上游超时（秒） |
| `upstream_timeout_chat` | 120 | Chat 模型超时（秒），推理模型需要更长时间 |
| `upstream_timeout_ocr` | 60 | OCR / 视觉模型超时（秒） |
| `upstream_timeout_embedding` | 60 | Embedding 超时（秒），大批量文档入库需要更长时间 |
| `upstream_timeout_rerank` | 30 | Reranker 超时（秒），长候选列表重排需要更长时间 |
| `schedule_total_budget` | 15 | 总故障转移预算（秒），超时后停止尝试更多候选。实际值会随候选数量自适应扩展（至少保证 3 次切换尝试，硬上限 180s；排队等待同样计入预算） |
| `max_concurrency_per_key` | 5 | 每个 Key 的最大并发请求数 |
| `cooldown_duration` | 30 | 5xx 及其他错误冷却时间（秒） |
| `cooldown_429_sec` | 60 | 429 限流冷却时间（秒） |
| `cooldown_403_sec` | 600 | 403 鉴权失败冷却时间（秒） |
| `circuit_break_threshold` | 3 | 连续失败次数阈值，触发熔断 |
| `circuit_cooldown_sec` | 300 | 熔断冷却时间（秒） |
| `chat_fast_timeout` | 30 | KB chat 模式超时（秒）。KB 模式**始终**非流式 + 此超时（写死，无 `chat_fast_mode` 开关）；Agent 模式不受影响 |
| `latency_based_routing` | false | 延迟感知路由：按历史延迟自动排序候选 |

## 故障排查

### 服务无法启动

```bash
journalctl -u ocrproxy --no-pager -n 50
```

### 配置文件解密失败

```bash
cat /opt/ocrproxy/.env | grep ENCRYPT_KEY
# 如需重新生成配置
sudo -u ocrproxy /opt/ocrproxy/venv/bin/python /opt/ocrproxy/scripts/init_config.py
```

### 候选状态显示异常（同一 Key chat/OCR 状态互相覆盖）

已修复：统计 Key 格式为 `provider:key:type`，同一 Key 在 chat 和 OCR 下的状态独立记录。如果仍出现覆盖，确认部署的是最新代码：

```bash
# 检查 stats.py 中的 node_key 格式
grep node_key /opt/ocrproxy/app/stats.py
# 应输出: node_key = f"{provider}:{key}:{type_name}"
```

### 内存持续增长

正常情况下内存应稳定在 70-100 MB。如果持续增长：

```bash
# 1. 确认 MALLOC_ARENA_MAX 生效
systemctl show ocrproxy.service --property=Environment

# 2. 查看 RSS 趋势
watch -n 5 'ps -o pid,rss,%mem -p $(pgrep -f uvicorn)'

# 3. 检查健康检查是否正常
systemctl status ocrproxy-health.timer

# 4. 手动重启
systemctl restart ocrproxy
```

### 服务假死（进程在但不响应）

健康检查定时器会每 60s 自动检测并重启。如需手动确认：

```bash
# 检查健康检查日志
journalctl -u ocrproxy-health.service --no-pager -n 10

# 手动测试
curl -sf http://127.0.0.1:8787/health
```

### 端口被占用

```bash
nano /opt/ocrproxy/.env  # 修改 APP_PORT
systemctl restart ocrproxy
```
