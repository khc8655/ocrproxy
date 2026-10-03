# MCP Server 与外部微服务专用凭据拉取 API 规范

## 1. 概述与设计原则

OCRProxy 边缘中枢（EdgeOne Vault Hub）不仅负责调度网关集群的凭据分发，还向外部生态（如 MCP Server、自主 Agent 微服务、自动化脚本）提供大模型上游凭据托管与按需拉取能力。

### 核心安全与解耦原则
1. **最小权限与信息隐藏 (Least Privilege & Information Hiding)**：
   - MCP Server 自身通常集成官方大模型 SDK（如 Google GenAI SDK、OpenAI SDK 等），仅需上游 API 端点（`base_url`）与访问密钥（`api_key`）；
   - 网关内部的私有适配规则（`adapter_rules`，如思考链映射矩阵、请求头覆盖、Tools 清洗逻辑）属于 OCRProxy 代理层内部调度机密，**绝对不下发给外部消费方**；
2. **纯净零解析心智 (Zero Overhead Integration)**：
   - 外部调用者无需理解复杂的网关 Schema，开箱即取平铺的 `base_url` 与 `key`。

---

## 2. 接口定义

支持两种调用方式，均要求 Bearer 鉴权（中枢环境变量 `PROXY_API_KEY`）：

### 方式 A：专用轻量端点 `POST /api/vault/credentials`（强烈推荐）
语义清晰，专为 MCP Server 与外部微服务设计，默认且强制只下发纯凭据，**绝不下发适配规则**。

### 方式 B：通用拉取端点 `POST /api/vault/fetch`（附加 `credentials_only: true`）
在原有中枢端点中传入过滤参数：`credentials_only: true` 或 `include_rules: false`。

---

## 3. 请求参数说明

- **接口地址**：`POST https://<YOUR_EDGEONE_DOMAIN>/api/vault/credentials` 或 `/api/vault/fetch`
- **请求头**：
  ```http
  Authorization: Bearer <YOUR_PROXY_API_KEY>
  Content-Type: application/json
  ```
- **请求体 (JSON)**：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `provider` | `string` | **是** | - | 供应商唯一标识（如 `vertex`, `amd`, `google`, `minimax` 等） |
| `key_label` | `string` | 否 | `null` | 指定拉取单个 Key 别名（如 `jjb`, `default`），若不填则返回该厂商下所有可用 Key |
| `keys` | `string[]` | 否 | `null` | 批量指定拉取的 Key 别名数组 |
| `credentials_only` | `boolean` | 否 | `true` (方式A) / `false` (方式B) | 设置为 `true` 时，中枢严格剔除 `adapter_rules` 等网关私有属性 |
| `include_rules` | `boolean` | 否 | `false` (方式A) / `true` (方式B) | 设置为 `false` 时不下发规则文件 |

---

## 4. 响应格式说明

### 4.1 指定单 Key 拉取（带便捷平铺字段）
当请求中指定了 `key_label: "jjb"` 时，响应最外层会直接平铺 `key`、`base_url` 与专属元数据，供下游 SDK 直接初始化：

```json
{
  "ok": true,
  "provider": "vertex",
  "key_label": "jjb",
  "key": "AQ.Ab8RN6LvZOoCDo...",
  "base_url": "https://aiplatform.googleapis.com/v1beta1/projects/jjb111/locations/global/endpoints/openapi",
  "project_id": "jjb111",
  "location": "global",
  "keys": {
    "jjb": {
      "key": "AQ.Ab8RN6LvZOoCDo...",
      "project_id": "jjb111",
      "location": "global",
      "base_url": "https://aiplatform.googleapis.com/v1beta1/projects/jjb111/locations/global/endpoints/openapi"
    }
  }
}
```

### 4.2 未指定 Key（批量拉取厂商全部凭据）
当请求未指定 `key_label` 时，返回该厂商下全部 Key 的凭据字典，同样剔除任何 `adapter_rules`：

```json
{
  "ok": true,
  "provider": "vertex",
  "base_url": "https://aiplatform.googleapis.com/v1beta1/projects/{project_id}/locations/global/endpoints/openapi",
  "keys": {
    "jjb": {
      "key": "AQ.Ab8RN6LvZOoCDo...",
      "project_id": "jjb111",
      "location": "global",
      "base_url": "https://aiplatform.googleapis.com/v1beta1/projects/jjb111/locations/global/endpoints/openapi"
    },
    "backup_key": {
      "key": "AQ.XyZ123...",
      "project_id": "my-second-project",
      "location": "us-central1",
      "base_url": "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/my-second-project/locations/us-central1/endpoints/openapi"
    }
  }
}
```

---

## 5. 对比：全量模式 vs 凭据纯净模式

| 字段 / 属性 | 普通 VM 全量同步 (`include_rules=true`) | MCP 纯凭据拉取 (`credentials_only=true`) |
| :--- | :--- | :--- |
| `ok`, `provider` | ✅ 包含 | ✅ 包含 |
| `base_url` | ✅ 包含 | ✅ 包含 |
| `keys` (密钥与元数据) | ✅ 包含 | ✅ 包含 |
| `key`, `project_id`, `location` (单 Key 快捷平铺) | ❌ 无平铺 | ✅ 自动平铺外层 |
| `adapter_rules` (网关适配规则) | ✅ **包含完整清洗规则** | ❌ **严格屏蔽不下发** |
| `protocols` (协议分类) | ✅ 包含 | ❌ **严格屏蔽不下发** |
| `cached_models` (推荐模型列表) | ✅ 包含 | ❌ **严格屏蔽不下发** |

---

## 6. MCP Server 客户端调用代码示例 (Node.js / TypeScript)

```typescript
import axios from 'axios';

interface OcrProxyCredentials {
  ok: boolean;
  provider: string;
  key: string;
  base_url: string;
  project_id?: string;
  location?: string;
}

/**
 * 从 OCRProxy EdgeOne 中枢纯净拉取大模型调用凭据
 */
async function fetchProviderCredentials(
  hubUrl: string,
  hubToken: string,
  provider: string,
  keyLabel?: string
): Promise<OcrProxyCredentials> {
  const endpoint = `${hubUrl.replace(/\/+$/, '')}/api/vault/credentials`;
  const response = await axios.post<OcrProxyCredentials>(
    endpoint,
    {
      provider,
      key_label: keyLabel,
      credentials_only: true // 严格声明仅索取凭据，不下发适配文件
    },
    {
      headers: {
        Authorization: `Bearer ${hubToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!response.data.ok) {
    throw new Error(`Failed to fetch credentials for ${provider}`);
  }

  return response.data;
}

// 使用示例：初始化下游 OpenAI / Vertex SDK
async function initMcpClient() {
  const creds = await fetchProviderCredentials(
    'https://api.khc6.cn',
    process.env.OCRPROXY_HUB_TOKEN!,
    'vertex',
    'jjb'
  );

  console.log(`[MCP] 成功拉取 ${creds.provider} 凭据: BaseURL=${creds.base_url}`);
  // 零繁琐解析，直接用于 SDK 初始化
  // const client = new OpenAI({ baseURL: creds.base_url, apiKey: creds.key });
}
```
