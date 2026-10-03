# OCRProxy 配置规范 (Configuration Schema)

本项目支持两种运行形态的配置，均采用统一的加密存储与解析规范。

---

## 1. Agent 模式配置规范 (`agent-edgeone` & `agent-vm`)

Agent 模式用于向 Cursor / Cline / OpenClaw / Hermes 等智能体工具提供标准 OpenAI 兼容接口，按真实模型名（如 `deepseek-v4-flash`, `gemini-2.5-flash`）做 Key 轮换与跨厂商故障转移。

```json
{
  "providers": {
    "sensenova": {
      "base_url": "https://api.sensenova.cn",
      "keys": {
        "KeyA": "sk-xxxx",
        "KeyB": "sk-yyyy"
      }
    },
    "google": {
      "base_url": "https://generativelanguage.googleapis.com",
      "keys": {
        "KeyMain": "AIzaSy..."
      }
    },
    "vertex": {
      "preset_id": "vertex",
      "base_url": "https://aiplatform.googleapis.com/v1beta1/projects/{project_id}/locations/global/endpoints/openapi",
      "keys": {
        "MyGCP": {
          "key": "AIzaSy...",
          "project_id": "my-gcp-project-123",
          "location": "global",
          "base_url": "https://aiplatform.googleapis.com/v1beta1/projects/my-gcp-project-123/locations/global/endpoints/openapi"
        }
      }
    }
  },
  "agent_models": {
    "deepseek-v4-flash": {
      "upstream_model": "DeepSeek-V3-Flash",
      "keys": [
        { "provider": "sensenova", "key": "KeyA" },
        { "provider": "sensenova", "key": "KeyB" }
      ]
    },
    "gemini-2.5-flash": {
      "upstream_model": "gemini-2.5-flash",
      "keys": [
        { "provider": "google", "key": "KeyMain" }
      ]
    },
    "gemini-3.8-flash": {
      "upstream_model": "google/gemini-3.8-flash",
      "keys": [
        { "provider": "vertex", "key": "MyGCP" }
      ]
    }
  }
}
```

> **注意 (Vertex AI Key 级元数据绑定)**：
> Google Cloud Vertex AI 每个 Key 可独立绑定 `project_id`、`location`（默认 `global`）和渲染后的具体 `base_url`。
> 当请求发往 Vertex AI 端点时：
> 1. 采用 Key 自带的 `base_url` 路由；
> 2. 鉴权头自动注入专属 `x-goog-api-key: <KEY>`（非 Bearer 格式）；
> 3. 模型名自动规范化补齐 `google/` 前缀；
> 4. URL 拼接严格规整，严禁拼接多余的 `/v1/`。


---

## 2. KB 模式配置规范 (`kb-vm`)

KB 模式用于向知识库系统（如 Dify / FastGPT / Ragflow）提供 4 大虚拟聚合模型：
- `chat`：聚合对话模型（默认禁用思考/推理，高并发低延迟）
- `embedding`：向量化模型
- `reranker`：重排序模型
- `ocr`：图片文字识别提取模型

```json
{
  "providers": {
    "siliconflow": {
      "base_url": "https://api.siliconflow.cn",
      "keys": {
        "KeyA": "sk-xxxx"
      }
    }
  },
  "candidates": {
    "chat": [
      { "provider": "siliconflow", "key": "KeyA", "model": "deepseek-ai/DeepSeek-V3" }
    ],
    "embedding": [
      { "provider": "siliconflow", "key": "KeyA", "model": "BAAI/bge-m3" }
    ],
    "reranker": [
      { "provider": "siliconflow", "key": "KeyA", "model": "BAAI/bge-reranker-v2-m3" }
    ],
    "ocr": [
      { "provider": "siliconflow", "key": "KeyA", "model": "Qwen/Qwen2.5-VL-72B-Instruct" }
    ]
  }
}
```
