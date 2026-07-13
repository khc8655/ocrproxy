# OCRProxy — 统一大模型中转与故障自动切换服务

提供 **Chat / Embedding / Reranker / OCR** 四类标准大模型能力的统一中转接口，支持多 Key 轮询、自动故障切换、熔断保护。部署在独立 VM 上，通过 Caddy 提供 HTTPS 入口。

## 核心特性

- **统一接口**：`/v1/chat/completions`、`/v1/embeddings`、`/v1/rerank`、`/v1/ocr` 标准 API，兼容 OpenAI SDK
- **多 Key 轮询**：按候选序列轮询多个上游 Key，支持优先级排序与拖拽调整
- **故障自动切换**：429 冷却 60s、403 冷却 10min、5xx 冷却 30s，连续失败 3 次触发熔断
- **并发控制**：每个 Key 独立并发限制（默认 5），防止打崩上游配额
- **超时预算**：单次请求超时 + 总调度预算，避免级联超时
- **Chat 快速模式**：自动禁用推理思考、强制非流式，单次请求从 30-60s 降至 2-5s
- **延迟感知路由**（可选）：根据历史延迟自动排序候选节点
- **Web 管理面板**：可视化配置供应商、Key、路由优先级，实时统计监控
- **加密存储**：配置文件使用 Fernet 对称加密，密钥不落盘明文
- **安全加固**：systemd 沙箱隔离、SSRF 防护、常量时间密钥比较

## 项目结构

```
ocrproxy/
├── vm-app/                        # VM 部署版本（生产环境）
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py                # FastAPI 应用入口
│   │   ├── scheduler.py           # 故障转移调度器
│   │   ├── config_store.py        # 加密配置存储
│   │   ├── stats.py               # 内存统计模块
│   │   ├── auth.py                # 鉴权工具
│   │   ├── proxy_routes.py        # 代理路由 /v1/*
│   │   └── admin_routes.py        # 管理路由 /api/admin/*
│   ├── static/
│   │   └── admin.html             # 管理面板（SPA）
│   ├── client/
│   │   ├── proxy_client.py        # Python 客户端封装
│   │   └── example.py             # 使用示例
│   ├── config/
│   │   └── proxy_config.enc       # 加密配置文件（运行时生成）
│   ├── scripts/
│   │   └── init_config.py         # 配置初始化脚本
│   ├── install.sh                 # 一键安装脚本
│   ├── ocrproxy.service           # systemd 服务模板
│   ├── Caddyfile.example          # Caddy 反向代理配置示例
│   ├── requirements.txt
│   └── README.md                  # 详细部署文档
├── .gitignore
└── README.md                      # 本文件
```

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

安装脚本自动完成：创建系统用户、Python 虚拟环境、生成加密密钥、配置 systemd 服务并启动。

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

## 接口调用

### Chat 对话
```bash
curl -X POST https://your-domain.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "chat", "messages": [{"role": "user", "content": "你好"}]}'
```

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
curl -X POST https://your-domain.com/v1/ocr \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"image_base64": "iVBORw0KGgo...", "prompt": "请识别图片中的所有文字内容"}'
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

```bash
systemctl status ocrproxy       # 查看服务状态
journalctl -u ocrproxy -f       # 实时日志
systemctl restart ocrproxy      # 重启服务
curl http://127.0.0.1:8787/health  # 健康检查
```

## 配置 JSON 结构

管理面板保存的配置 JSON 结构：

```json
{
  "upstream_timeout": 12,
  "upstream_timeout_chat": 120,
  "upstream_timeout_ocr": 60,
  "schedule_total_budget": 15,
  "max_concurrency_per_key": 5,
  "cooldown_duration": 30,
  "cooldown_429_sec": 60,
  "cooldown_403_sec": 600,
  "chat_fast_mode": false,
  "chat_fast_timeout": 30,
  "latency_based_routing": false,
  "providers": {
    "siliconflow": {
      "base_url": "https://api.siliconflow.cn",
      "keys": { "KeyA": "sk-xxxx" }
    }
  },
  "candidates": {
    "chat": [{"provider": "siliconflow", "key": "KeyA", "model": "deepseek-ai/DeepSeek-V3"}],
    "embedding": [{"provider": "siliconflow", "key": "KeyA", "model": "BAAI/bge-m3"}],
    "reranker": [{"provider": "siliconflow", "key": "KeyA", "model": "BAAI/bge-reranker-v2-m3"}],
    "ocr": [{"provider": "siliconflow", "key": "KeyA", "model": "deepseek-ai/DeepSeek-OCR"}]
  }
}
```

更多细节请参考 [vm-app/README.md](vm-app/README.md)。
