# 🔁 LLM Proxy — 统一国内大模型中转服务

多 Key 轮询 · 自动故障切换 · OpenAI 兼容 · Web 管理面板

## 功能

| 功能 | 说明 |
|------|------|
| **四类模型统一代理** | OCR / Embedding / Reranker / Chat，agent 一次配置即可使用 |
| **多 Key 轮询** | 同一供应商挂多个 Key，按候选序列依次尝试 |
| **自动故障切换** | 429→冷却60s切下一个，403→冷却10min切下一个 |
| **熔断机制** | 连续3次失败→该Key熔断5分钟，面板可手动解冻 |
| **OpenAI 兼容** | 响应原样透传上游，支持 stream，agent 无需改代码 |
| **响应路由头** | `X-Routed-Via: siliconflow/key1` 标记实际走的供应商 |
| **Fallback 链追踪** | 记录"依次尝试了A→B→C才成功"的完整链路 |
| **Web 管理面板** | 供应商/Key/端点/候选管理 + 四类统计 + 错误日志 |
| **Key 加密存储** | Fernet 对称加密存库，面板只显示掩码 |
| **管理API鉴权** | Cookie 会话 + 中间件保护，未登录无法访问任何管理数据 |

## 快速开始

### 环境变量（必须设置）

```bash
# 生成加密密钥（只执行一次）
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

# 生成代理密钥（agent调用时带）
python -c "import secrets; print(secrets.token_urlsafe(32))"

# 设置环境变量
export ENCRYPT_KEY="上面生成的Fernet密钥"
export PROXY_API_KEY="上面生成的代理密钥"
export ADMIN_PASSWORD="你的面板密码"
```

### 本地运行

```bash
git clone https://github.com/khc8655/ocrproxy.git
cd ocrproxy
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 7860
```

浏览器打开 `http://localhost:7860`，输入 `ADMIN_PASSWORD` 登录面板。

### Docker 运行

```bash
docker build -t llm-proxy .
docker run -d -p 7860:7860 \
  -v ./data:/app/data \
  -e ENCRYPT_KEY="你的密钥" \
  -e PROXY_API_KEY="你的代理密钥" \
  -e ADMIN_PASSWORD="你的面板密码" \
  llm-proxy
```

## 配置流程

1. **供应商** → 新增供应商（如 `siliconflow`，填 API 地址）
2. **Key** → 在供应商下添加 API Key（加密存储，面板只显示掩码）
3. **模型端点** → 配置模型类型 + 上游模型 ID（候选自动生成）
4. **候选序列** → 按 seq 排序，越小越优先（可⬆️⬇️调整）

## Agent 调用方式

| 端点 | 说明 |
|------|------|
| `POST /v1/chat/completions` | Chat（支持 stream） |
| `POST /v1/embeddings` | Embedding |
| `POST /v1/rerank` | Reranker（SiliconFlow 风格） |
| `POST /v1/ocr` | OCR（接受 `image_base64` 或 `image_url`） |
| `GET /v1/models` | 模型列表 |

**请求必须带 `Authorization: Bearer <PROXY_API_KEY>`**

### 示例

```python
import openai

client = openai.OpenAI(
    base_url="http://your-host:7860/v1",
    api_key="your-proxy-api-key",
)

# Chat
resp = client.chat.completions.create(
    model="chat",
    messages=[{"role": "user", "content": "你好"}],
)

# Embedding
resp = client.embeddings.create(model="embedding", input="需要向量化的文本")
```

```python
import httpx

# OCR (base64)
httpx.post("http://your-host:7860/v1/ocr", headers={"Authorization": "Bearer <key>"},
    json={"model": "ocr", "image_base64": "..."})

# OCR (URL)
httpx.post("http://your-host:7860/v1/ocr", headers={"Authorization": "Bearer <key>"},
    json={"model": "ocr", "image_url": "https://..."})

# Reranker
httpx.post("http://your-host:7860/v1/rerank", headers={"Authorization": "Bearer <key>"},
    json={"model": "reranker", "query": "问题", "documents": ["文档1", "文档2"]})
```

## 调度策略

```
候选序列 (按 seq 升序):
  OCR:   seq=1 siliconflow/key1 → seq=2 siliconflow/key2 → seq=3 step/key1
  Embed: seq=1 siliconflow/key1
  ...

请求进来 → 按 seq 顺序尝试:
  1. 命中 seq=1 → 成功? 返回 : 失败?
  2. 429 → 该Key冷却60s, 切seq=2
  3. 403 → 该Key冷却10min, 切seq=2
  4. 连续3次失败 → 该Key熔断5min
  5. 所有候选失败 → 返回503
```

## 魔搭创空间部署

项目已包含 `Dockerfile` 和 `.modelspace/app.yaml`，在魔搭创空间创建应用时选择 Docker 部署即可。

**必须在创空间的环境变量中设置：**

| 变量 | 说明 | 必填 |
|------|------|------|
| `ENCRYPT_KEY` | Fernet 加密密钥（保护数据库中的Key） | ✅ |
| `PROXY_API_KEY` | 代理API密钥（agent调用时带） | ✅ |
| `ADMIN_PASSWORD` | 管理面板登录密码 | ✅ |

## 安全设计

- 管理API全部受Cookie会话+中间件保护，未登录返回401
- 上游Key用Fernet加密存SQLite，面板只显示掩码
- 代理API必须带PROXY_API_KEY，否则401
- 无宽松CORS，无路径穿越
- ENCRYPT_KEY/PROXY_API_KEY/ADMIN_PASSWORD 均从环境变量读取，不硬编码

## 项目结构

```
app/
├── main.py              # FastAPI 入口 + 鉴权中间件
├── core/
│   ├── config.py        # 环境变量配置
│   ├── crypto.py        # Fernet 加解密
│   └── scheduler.py     # 调度引擎 + 候选自动生成
├── db/
│   ├── database.py      # SQLAlchemy + SQLite
│   └── models.py        # Provider / Key / Endpoint / Candidate / UsageLog
├── routers/
│   ├── proxy.py         # OpenAI 兼容代理 (含 stream + 路由头)
│   ├── admin.py         # 管理 CRUD
│   └── stats.py         # 统计 + Fallback 链
└── templates/
    └── index.html       # Web 管理面板
```

## License

MIT
