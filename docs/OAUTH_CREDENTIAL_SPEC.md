# OAuth 订阅凭据规格（SYSTEM_DESIGN_SPEC §3 补充，草案 v0.2）

> 状态：草案，未实现。目标：在**不改变现有二元凭据架构**（§3：中枢下发规则、本地 Key 不出机）的前提下，让 VM 端支持"用厂商账号 OAuth 登录"代替粘贴 API Key。一次定型，后续新增厂商只加 preset JSON。
>
> 说明：OAuth 引擎是通用的；具体厂商只由独立 preset 的 `auth` 块声明，主代码不内置任何厂商。当前仓库不内置任何厂商适配。

---

## 0.1 非目标（v0.2 明确）

本项目**只借鉴 OAuth 认证方式**，不做以下事情：

- 不集成 magpie，不运行 Bun 插件宿主，不引入其调度/路由/账号池；
- 不集成 Antigravity、WorkBuddy 等非官方订阅/私有协议客户端；
- 不实现非官方 client id/endpoint、不逆向私有 API、不做多账号自动轮换；
- P1 只做官方 OAuth 设备码；具体厂商由独立 preset 的 `auth` 块声明，主代码不内置任何厂商；后续只接厂商官方公开的 OAuth 授权流程（如 Google/GPT 的官方订阅认证），并逐家评审；
- 非标准私有协议如果需要，单独做 sidecar/独立服务，不进入 OCRProxy 核心。

## 0. 一句话架构

**分发"怎么登录"，不分发"登录本身"。**

| OAuth 的组成 | 归类 | 存放 | 走哪条现有通道 |
|---|---|---|---|
| 登录配方（授权端点、client_id、scope、请求头） | 适配规则 | `shared/presets/<id>.json` 的 `auth` 块 | §1.3 日期驱动差量同步 / `vault/sync`（只更新规则） |
| 登录产物（access / refresh token） | 凭据 | `providers[id].keys[label]`，`kind: "oauth"`，`origin: "local"` | 无。永不下发、永不回传（§3.1 本地凭据规则） |

不新增层；EdgeOne、vault 接口、同步协议、调度器、统计、冷却、KB 管线**均不改语义**。

---

## 1. 硬性不变量（实现与测试都以此为准）

- **I1 一个登录 = 一台 VM。** OAuth 凭据只在完成登录的那台 VM 上存在。多台 VM 用同一账号 = 各自登录一次。
- **I2 `kind=oauth` ⇒ `origin=local`。** 后端写入时强制；`resolveKeySource` 遇到 `kind=oauth` 直接返回 `local`；`/api/vault/manifest`、`/api/vault/fetch` 对其一律剔除（现有 local 过滤已覆盖，需加断言）。
- **I3 EdgeOne 不执行登录。** EO 可以存/下发带 `auth` 块的 preset（它只是规则），但不提供登录入口、不保存 OAuth 凭据。由 HOST 能力位 `oauth_login`（VM=true，EO=false）控制，不写进 UI 分支、不塞进 runtime-profiles（遵守 runtime_profile.py 头部约定：能力有无走能力位）。
- **I4 请求路径只有一个触点。** 调度器取 Key 值处统一调用 `resolve_auth()`；适配器、`auth_header/auth_format`、`inject_headers` 照旧工作，对它们来说 OAuth 只是"另一种 Key 值"。
- **I5 轮换后的 refresh token 先落盘再使用。** 防止进程崩溃丢失唯一有效的 refresh token。
- **I6 只有明确的"登录失效"才判登出。** 仅 token 端点返回 `invalid_grant`（HTTP 400）或配方声明的等价错误时，Key 置为 `needs_relogin`；网络错误、5xx、超时一律保留登录、稍后重试。
- **I7 旧数据零迁移。** 无 `kind` 字段的 Key 一律视为 `api_key`，行为与现在完全一致。

---

## 2. 数据形状

### 2.1 preset 新增可选 `auth` 块

```jsonc
{
  "id": "example-oauth",
  "protocol": "anthropic",
  "anthropic_base_url": "https://agent.minimax.cn/mavis/api/v1/llm/v1",
  "auth": {
    "type": "oauth_device",            // none(默认) | oauth_device | oauth_paste，预留扩展
    "client_id": "mcode-public",
    "scope": "agent.default",
    "audience": "agent-backend",       // 可选，原样加到授权与刷新表单
    "pkce": "S256",                    // S256 | none
    "device_endpoint": "https://account.minimax.cn/oauth2/device/code",
    "token_endpoint":  "https://account.minimax.cn/oauth2/token",
    "authorize_endpoint": null,        // oauth_paste 用
    "redirect_uri": null,              // oauth_paste 用，通常是 http://localhost:<port>/callback
    "refresh_lead_sec": 600,           // 距过期多久开始提前刷新
    "refresh_rotates": true,           // refresh token 是否可能一次性（决定加锁与落盘严格度）
    "signed_out_errors": ["invalid_grant"],
    "account_claims": { "subject": "sub", "account_id": "account_id" }, // 从 access JWT 读展示用身份，可选
    "device_quirks": ["expired_in_ms_or_epoch", "interval_ms", "status_field", "poll_by_user_code"]
  },
  "adapter_rules": {
    "auth_header": "Authorization",
    "auth_format": "Bearer {key}",
    "inject_headers": {
      "User-Agent": "MiniMaxAgent",
      "X-Mavis-Agent-Id": "main",
      "X-Mavis-Session-Id": "${random_session_id}",
      "x-api-key": "sk-xxx",
      "anthropic-version": "2023-06-01"
    }
  }
}
```

说明：
- 每个厂商独立 preset；删除 preset 不应要求改 OAuth 主代码。
- `device_quirks` 用于容纳非标准实现（MiniMax 设备码响应可能用 `expired_in`（秒/毫秒/绝对时间戳）、`interval` 毫秒、返回体 `status` 字段代替标准 error、无 `device_code` 时用 `user_code` 轮询）。默认按 RFC 8628 标准解析，quirk 只放宽不改语义。
- 请求头复用现有 `inject_headers` 与 `${random_session_id}` 占位符，**无需新机制**。

### 2.2 Key 新增 `kind` 与 `oauth` 子对象

```jsonc
"providers": {
  "example-oauth": {
    "keys": {
      "me@example.com": {
        "kind": "oauth",              // 缺省 = "api_key"
        "origin": "local", "is_local": true,
        "key": "",                    // 始终为空，避免旧代码误用
        "oauth": {
          "access": "<enc>", "refresh": "<enc>",
          "expires_at": 1761580000000,          // ms
          "refresh_expires_at": null,           // 厂商给了就存
          "subject": "...", "account_id": "...",
          "status": "active",                   // active | needs_relogin
          "last_refresh_at": 0, "last_error": null
        }
      }
    }
  }
}
```

- 整体随 `proxy_config.enc`（Fernet）加密，与 API Key 同等保护。
- 管理端 GET 时 `access/refresh` 按现有 `is_masked_secret` 规则脱敏；PUT 回写时脱敏值保留原值（沿用 `test_secret_preservation` 语义）。
- Key 标签默认用账号身份（邮箱 / subject），用户可改名。

---

## 3. 生命周期

```
            start            用户在网页确认             临期 / 401
 (无) ───────────▶ pending ───────────────▶ active ─────────────▶ refreshing
                     │ 超时/拒绝                ▲                    │ 成功
                     ▼                          └────────────────────┘
                  (丢弃)                     invalid_grant ─▶ needs_relogin ──(重新登录)──▶ active
```

- `pending` 只存在于内存（TTL = 厂商给的过期时间，缺省 10 分钟），PKCE verifier 与 device_code 永不写盘、永不出后端。
- `needs_relogin` 的 Key 调度器直接跳过（同冷宫的跳过路径，但不计入失败统计），UI 显示"需重新登录"。

---

## 4. 请求路径（唯一触点）

位置：`vm-app/app/scheduler.py` 取 Key 值处（现约 L1656–1666 `api_key_raw` 分支）。

```python
api_key, base_url = await credentials.resolve_auth(provider_name, key_label, api_key_raw, provider)
```

- `kind=api_key`：原样返回，零开销。
- `kind=oauth`：
  1. `status=needs_relogin` → 返回跳过信号；
  2. 距 `expires_at` 小于 `refresh_lead_sec` → 走 §5 刷新（单飞）；
  3. 返回 access token，后续交给现有 `auth_header/auth_format/inject_headers`。

**401 处理（必须改的第二处）**：现在 401 直接进 24h 冷宫（scheduler.py L626–629、L2195–2208）。对 `kind=oauth`：
- 首次 401 → 强制刷新一次 → 同 Key 立即重试一次（不消耗 `max_retries`，复用"同 Key 重试"计数路径）；
- 刷新后仍 401，或刷新得到 `invalid_grant` → 置 `needs_relogin`，**不进冷宫**（冷宫会掩盖"需要人去重新登录"这一事实）；
- 403 / 配额关键字 → 与 API Key 完全相同的冷却逻辑。

---

## 5. 刷新

- **单飞**：每个 `provider:key` 一把 `asyncio.Lock`；拿到锁后**先重读配置**，若已被别人刷新（`expires_at` 已更新）直接用新值。
- **跨进程防御**：VM 现为单进程 uvicorn，但沿用 `mode_scheduler` 的 `fcntl.flock` 模式加一把 `.oauth_refresh.lock`，防止将来多 worker 时并发使用一次性 refresh token。
- **落盘顺序（I5）**：拿到新 token → `config_store.update_config` 原子写入 → 再返回给请求。
- **后台保活**：由持有 leader 锁的实例每 N 分钟扫描一次 OAuth Key，对"即将过期且近期没被请求刷新过"的做提前刷新；`refresh_expires_at` 临近时在 UI 提示。**不随 KB/Agent 时段切换停止**，否则夜间 KB 时段过后白天 Agent 可能整体掉线。
- **错误分类（I6）**：`signed_out_errors` 命中 → `needs_relogin`；其他 → 记 `last_error`，保留 token，指数退避。
- 日志只记固定文本 + HTTP 状态码，绝不记表单、URL 查询串、token（参照 MiniMax 插件做法）。

---

## 6. 管理接口（VM 独有，EO 不实现）

| 接口 | 作用 |
|---|---|
| `POST /api/admin/oauth/start` `{provider, label?}` | 按 preset.auth 发起；`oauth_device` 返回 `{session, user_code, verification_url, expires_in, interval}`；`oauth_paste` 返回 `{session, authorize_url}` |
| `POST /api/admin/oauth/poll` `{session}` | 设备码轮询（后端代轮询，前端只问结果）：`pending / done / denied / expired` |
| `POST /api/admin/oauth/complete` `{session, callback_url}` | 粘贴回跳地址：解析 `code`+`state`，校验 state，换 token |
| `POST /api/admin/oauth/relogin` `{provider, label}` | 对已有 Key 重新发起，成功后原位替换 token，保持标签、RPM、模型绑定不变 |
| `GET  /api/admin/oauth/status` | 各 OAuth Key 的状态、身份、过期时间（脱敏） |

- 鉴权与现有管理面一致（§3.5.y 管理面安全基线）。
- token/device/authorize 端点地址走现有 SSRF 守卫：必须是公网 https，元数据地址永远拒绝。
- 登录完成 = 写入一个 `kind=oauth, origin=local` 的 Key；之后模型绑定、探活、统计全部复用现有流程。

---

## 7. 中枢 / 同步交互

- `vault/sync` 更新规则时，`auth` 块随 preset 一起更新（厂商改端点时可远程修复），**不触碰任何 Key**（现有规则）。
- `vault/manifest`、`vault/fetch` 对 `kind=oauth` 再加一层显式过滤 + 测试断言（即使将来误标 origin 也不外泄）。
- EO 控制台的供应商列表可以显示"此供应商支持 OAuth 登录（仅 VM）"，但不出现登录按钮（能力位 `oauth_login=false`）。

---

## 8. UI 契约（shared/admin 单一真理源）

- 供应商卡片「+ Key」：若 preset `auth.type != none` 且 HOST 能力位 `oauth_login=true`，在原有"粘贴 Key"旁多一个「账号登录」胶囊。
- 设备码：弹窗显示 `user_code`（大字、可复制）+ 打开链接按钮，前端每 `interval` 调一次 poll。
- 粘贴回调：弹窗给授权链接 + 一个"粘贴浏览器最终地址"输入框。
- Key 行徽章：`[本地·OAuth]` + 账号身份 + 状态（正常 / 即将过期 / 需重新登录），"需重新登录"行提供「重新登录」按钮。
- 不新增页面、不新增 subtab；差异全部由 preset.auth + 能力位驱动，EO 与 VM 共用同一份 JS。

---

## 9. 运行模式

- OAuth Key 用于 Agent 模式的 `agent_models`；KB 四个虚拟模型池默认不纳入 OAuth Key（订阅类凭据多为对话额度，且 KB 强制关思考/高并发易触发风控）。是否允许由 `settings.schema.json` 模式隔离字段声明，不写死在代码里。
- 刷新与保活与 run_mode 无关，始终运行（§5）。

---

## 10. 测试清单（并入 verify_release_gate）

1. 无 `kind` 的旧配置加载、调度、脱敏回写行为不变（I7）。
2. `kind=oauth` 写入时 origin 被强制为 local；manifest/fetch 不含 OAuth Key（I2）。
3. EO 构建产物中无登录入口；能力位为 false 时 UI 不渲染登录胶囊（I3）。
4. 并发 20 个请求同时遇到临期 → 只发生 1 次刷新（单飞）。
5. 刷新返回新 refresh → 先落盘再返回；模拟落盘后崩溃，重启后可继续刷新（I5）。
6. 401 → 刷新 → 重试成功；刷新 invalid_grant → needs_relogin 且不进冷宫、不计失败。
7. 网络错误/5xx 刷新失败 → 保留登录（I6）。
8. 设备码 quirks：`expired_in` 为秒/毫秒/绝对时间戳、`interval` 毫秒、`status` 字段、`user_code` 轮询均能正确解析。
9. 粘贴回调 state 不匹配拒绝；session 过期拒绝。
10. 日志与错误日志中不出现 token、code、verifier（grep 断言）。
11. KB/Agent 时段切换前后，后台保活持续运行。

---

## 11. 分期

| 期 | 内容 | 验收 |
|---|---|---|
| P1 | 凭据层（kind/oauth 字段、resolve_auth、401 路径、刷新单飞与落盘、保活）+ `oauth_device` + 独立厂商 preset + UI 登录胶囊 | 官方 OAuth 账号在 VM-Agent 下可登录、对话、自动续期、失效提示 |
| P2 | `oauth_paste`（授权码 + PKCE + 粘贴回调）通用实现；仅接官方公开 OAuth 流程 | 标准 OAuth 厂商只加 preset 即可接入；不做非官方/私有协议 |
| P3 | **不做** magpie / Antigravity / WorkBuddy / 非官方插件适配 | 如未来确需，另立独立 sidecar 项目评审 |

## 12. 明确不做

- 不在 EdgeOne 执行登录、不在中枢存放或分发 OAuth 凭据、不跨 VM 共享登录。
- 不引入 magpie 或其他侧车（另行决定）。
- 不做多账号自动轮换之外的新调度策略：OAuth Key 进入现有 sticky_failover / round_robin，与 API Key 平等。

## 13. 风险提示

- 使用厂商客户端的公开 client_id 登录属于灰色地带，厂商可随时调整或封禁；建议用非主力账号，preset 的 `update_notes` 标注风险。
- 订阅额度与 API 计费不同，冷却与配额关键字需按厂商实测补充到 preset `error_rules`。
