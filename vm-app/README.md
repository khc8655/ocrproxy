# OCRProxy VM 版 — 统一大模型中转与故障自动切换服务

基于 EdgeOne Makers 版本移植的独立 VM 部署版本，提供 **Chat / Embedding / Reranker / OCR** 四类标准大模型能力的统一中转接口，支持多 Key 轮询、自动故障切换、熔断保护。

## 核心特性

- **统一接口**：提供 `/v1/chat/completions`、`/v1/embeddings`、`/v1/rerank`、`/v1/ocr` 标准 API
- **多 Key 轮询**：自动按候选序列轮询多个上游 Key，支持优先级排序
- **故障自动切换**：429 冷却 60s、403 冷却 10min、5xx 冷却 30s，连续失败 3 次触发熔断
- **并发控制**：每个 Key 独立并发限制（默认 5），防止打崩上游配额
- **超时预算**：单次请求 12s 超时，总调度预算 15s，避免级联超时
- **Web 管理面板**：可视化配置供应商、Key、路由优先级，实时统计监控
- **加密存储**：配置文件使用 Fernet 对称加密，密钥不落盘明文
- **安全加固**：systemd 沙箱隔离、SSRF 防护、常量时间密钥比较

## 快速部署

### 1. 上传到 VM

```bash
# 将 vm-app 目录上传到服务器
scp -r vm-app/ root@your-server:/tmp/ocrproxy-install
```

### 2. 一键安装

```bash
# 登录服务器
ssh root@your-server

# 执行安装
cd /tmp/ocrproxy-install
sudo bash install.sh
```

安装脚本会自动完成：
- 创建专用系统用户 `ocrproxy`
- 创建 Python 虚拟环境并安装依赖
- 生成 Fernet 加密密钥
- 生成 `PROXY_API_KEY` 和 `ADMIN_PASSWORD`
- 创建加密的配置文件
- 配置 systemd 服务并启动
- 设置严格的文件权限

### 3. 配置 Caddy 反向代理

在你的 Caddyfile 中添加：

```
your-domain.com {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
}
```

重新加载 Caddy：
```bash
sudo systemctl reload caddy
```

### 4. 访问管理面板

打开浏览器访问 `https://your-domain.com/`，使用安装时生成的 `ADMIN_PASSWORD` 登录。

## 接口调用

### Chat 对话
```bash
curl -X POST https://your-domain.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chat",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### Embedding 向量
```bash
curl -X POST https://your-domain.com/v1/embeddings \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "embedding",
    "input": "需要向量化的文本"
  }'
```

### Reranker 重排
```bash
curl -X POST https://your-domain.com/v1/rerank \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "reranker",
    "query": "查询文本",
    "documents": ["文档1", "文档2", "文档3"]
  }'
```

### OCR 识别
```bash
curl -X POST https://your-domain.com/v1/ocr \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "image_base64": "iVBORw0KGgo...",
    "prompt": "请识别图片中的所有文字内容"
  }'
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
# 查看服务状态
systemctl status ocrproxy

# 查看实时日志
journalctl -u ocrproxy -f

# 重启服务
systemctl restart ocrproxy

# 停止服务
systemctl stop ocrproxy

# 修改密钥/配置
nano /opt/ocrproxy/.env
systemctl restart ocrproxy

# 健康检查
curl http://127.0.0.1:8787/health
```

## 安全说明

| 安全措施 | 说明 |
|---------|------|
| 配置加密 | 所有 API Key 使用 Fernet 对称加密存储，磁盘上无明文 |
| 文件权限 | `.env` 和配置文件权限 600，仅服务用户可读 |
| 系统用户 | 服务运行在专用 `ocrproxy` 系统用户下，无登录权限 |
| systemd 沙箱 | 启用 NoNewPrivileges、ProtectSystem、ProtectHome 等加固 |
| SSRF 防护 | Key 验证接口阻止访问内网/本地/元数据地址 |
| 时序攻击防护 | 密钥比较使用 `hmac.compare_digest` 常量时间比较 |
| 仅本地监听 | 服务监听 127.0.0.1，外部访问必须经过 Caddy (HTTPS) |

## 目录结构

```
/opt/ocrproxy/
├── app/
│   ├── __init__.py
│   ├── main.py           # FastAPI 应用入口
│   ├── scheduler.py       # 故障转移调度器
│   ├── config_store.py    # 加密配置存储
│   ├── stats.py           # 内存统计模块
│   ├── auth.py            # 鉴权工具
│   ├── proxy_routes.py    # 代理路由 /v1/*
│   └── admin_routes.py    # 管理路由 /api/admin/*
├── static/
│   └── admin.html         # 管理面板
├── config/
│   └── proxy_config.enc   # 加密配置文件
├── venv/                   # Python 虚拟环境
├── .env                    # 环境变量（密钥）
└── requirements.txt
```

## 配置 JSON 结构

管理面板保存的配置 JSON 结构如下：

```json
{
  "upstream_timeout": 12,
  "schedule_total_budget": 15,
  "max_concurrency_per_key": 5,
  "cooldown_429_sec": 60,
  "cooldown_403_sec": 600,
  "providers": {
    "siliconflow": {
      "base_url": "https://api.siliconflow.cn",
      "keys": {
        "KeyA": "sk-xxxx",
        "KeyB": "sk-yyyy"
      }
    }
  },
  "candidates": {
    "embedding": [
      {"provider": "siliconflow", "key": "KeyA", "model": "BAAI/bge-m3"}
    ],
    "ocr": [
      {"provider": "siliconflow", "key": "KeyA", "model": "deepseek-ai/DeepSeek-OCR"}
    ],
    "reranker": [
      {"provider": "siliconflow", "key": "KeyA", "model": "BAAI/bge-reranker-v2-m3"}
    ],
    "chat": [
      {"provider": "siliconflow", "key": "KeyA", "model": "deepseek-ai/DeepSeek-V3"}
    ]
  }
}
```

## 从 EdgeOne 版迁移

如果你已有 EdgeOne 版本的 `proxy_config` 文件，安装脚本会自动检测并提供导入选项。也可以手动导入：

```bash
# 将 proxy_config 文件上传到服务器
scp proxy_config root@your-server:/tmp/

# 运行安装脚本，选择导入
sudo bash install.sh
# 当提示 "检测到 proxy_config 文件，是否导入？" 时选择 Y
```

## 故障排查

### 服务无法启动
```bash
# 查看详细错误日志
journalctl -u ocrproxy --no-pager -n 50
```

### 配置文件解密失败
```bash
# 检查 .env 中的 ENCRYPT_KEY 是否正确
cat /opt/ocrproxy/.env | grep ENCRYPT_KEY

# 如果需要重新生成配置
sudo -u ocrproxy /opt/ocrproxy/venv/bin/python /opt/ocrproxy/scripts/init_config.py
```

### 端口被占用
```bash
# 修改 .env 中的 APP_PORT
nano /opt/ocrproxy/.env
systemctl restart ocrproxy
```
