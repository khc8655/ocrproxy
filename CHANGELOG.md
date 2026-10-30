# OCRProxy 变更日志 (Changelog)

本文档记录 OCRProxy 项目全版本生命周期内的所有重要更新、架构重构、功能新增与缺陷修复。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 规范。

## [Unreleased]

## [v20261030-01] - 2026-10-30

### Cline 非流式响应信封解包
- Cline 官方 API 非流式返回 `{"data":{...}}` 信封，网关按 preset `response.unwrap_root` 自动解包为标准 OpenAI ChatCompletion。
- scheduler 在 provider 未显式保存 `adapter_rules` 时按 `preset_id` 读取 response 规则，避免客户端看到无 choices 的响应。
- `cline` preset 升级到 1.1.1。

## [v20261029-01] - 2026-10-29

### 控制台前端结构治理
- 修复批量样式迁移造成的 HTML 结构破损：`rawjson-wrap`/中枢提示缺 `>`、provider 弹窗多余闭合、重复 `class`、文件导入 input 裸露、字母导航 `hidden` 冲突。
- 内联 `style` 迁移为语义 class，修复空属性/残留标签；供应商字母索引恢复正常。
- 新增 `tests/test_html_structure.py`（重复/空属性、标签未闭合/嵌套、内联 style 棘轮），接入 `build:assets` 与测试 runner。
- 未改后端调度/API 语义。

## [v20261028-13] - 2026-10-28

### 移除 minimax-code 适配
- 删除 `shared/presets/minimax-code.json` 及其 catalog/生成的 preset 镜像。
- OAuth 凭据层保持通用，不内置任何厂商；厂商仅通过独立 preset 的 `auth` 块声明。
- 测试改用内联 `auth` 的通用 provider，不再依赖 minimax-code。

## [v20261028-12] - 2026-10-28

### MiniMax Code OAuth 探测与模型修正
- 管理端模型探测/测试端点正确解析 OAuth access token，不再出现 `Bearer ` 空值。
- MiniMax Code 推荐模型修正为 `MiniMax-M3.1-Flash`（Preview 不存在）。

## [v20261028-11] - 2026-10-28

### OAuth 授权链接完整展示
- 授权链接改为可换行、可整体选中的只读文本块，完整显示 `user_code`。
- 保留复制验证码/链接/打开授权页。

## [v20261028-10] - 2026-10-28

### OAuth 设备码完整链接
- 设备码登录优先使用厂商返回的 `verification_uri_complete`；缺失时自动追加 `user_code` 参数，不再只展示裸授权页。
- OAuth 登录不再使用 `alert`，改为可复制验证码/授权链接、可直接打开的自定义弹窗。

### 统一弹窗
- 全站确认/提示统一为 `UI.confirm` / `UI.alert` / `UI.dialog`，替换原生 `alert/confirm`。

## [v20261028-09] - 2026-10-28

### OAuth 入口缓存刷新
- 新增/删除供应商后自动失效 OAuth 入口缓存，无需刷新页面即可看到「账号登录」。

## [v20261028-08] - 2026-10-28

### MiniMax Code OAuth 入口显性化
- 供应商页对带官方 OAuth 配方的供应商显示「账号登录」按钮，按 `/api/admin/oauth/providers` 动态判断。
- 新增供应商弹窗增加 MiniMax Code 填写提示：标识填 `minimax-code`。
- 保留 v07 的表格/下拉/设置分区与 OTA 多源修复。

## [v20261028-07] - 2026-10-28

### OTA 多源取最新
- 系统更新检查改为在 GitHub raw / ghfast / jsDelivr 中取版本号最新的源，避免 raw 缓存滞后误报「已是最新」。

### UI 细节
- 模型排序输入改 text/inputmode=numeric，彻底移除 number 步进残影；设置下拉浅底+强描边。
- 保留 v04 表格字号/行距与设置分区。

## [v20261028-06] - 2026-10-28

### 模型排序输入与下拉对比度
- 模型表排序输入改为 text/inputmode=numeric，彻底移除原生 number 步进残影。
- 设置页下拉增加浅底与更强描边，chevron 更易识别。

## [v20261028-05] - 2026-10-28

### 表格/下拉细节收口
- 彻底隐藏 number input 原生步进按钮，模型表行首不再出现残留点。
- 下拉框统一 38px 高、42px 右侧留白和更明显 chevron。

## [v20261028-04] - 2026-10-28

### 控制台可读性与设置分区
- 模型列表表格字号提升到 14px，行高/内边距加大，供应商与 Key 列加宽，长文本不再挤成省略号。
- 下拉框统一更明显的 chevron、边框、悬停与焦点态。
- 设置页拆分为「EdgeOne 凭据中枢」「系统版本与运维」「底层配置」三张卡片；检查更新与升级/重启分区展示。

## [v20261028-03] - 2026-10-28

### OAuth 入口可见性修复
- OAuth 登录入口只对带官方 OAuth 配方的供应商显示，普通 Key 不再出现误导入口。
- 新增 `GET /api/admin/oauth/providers`，按 preset 的 `auth.type` 返回可用供应商。
- 保留 v20261028-02 的 KB 空表 `.empty:not(td)` 修复。

## [v20261028-02] - 2026-10-28

### 控制台 UI 空态回归修复
- 修复 v20261028-01 中 `.empty` 组件样式与 KB 模型表 `td.empty` 冲突，导致「暂无候选节点」被裁切的问题。
- 空态组件样式限定为 `.empty:not(td)`，表格空态恢复居中显示。
- 其余 token/壳层/pageHeader/OAuth 入口不变。

## [v20261028-01] - 2026-10-28

### OAuth 订阅登录（VM）
- 新增 MiniMax Code 官方 OAuth 设备码登录：设备码申请/轮询、access/refresh token 加密存储、后台续期；OAuth Key 强制 `origin=local`，永不下发中枢。
- 调度器只在取 Key 处增加 `resolve_auth()`；401 先刷新重试同 Key，`invalid_grant` 标记 `needs_relogin` 且不走普通 401 24h 冷宫。
- 管理接口 `POST /api/admin/oauth/start|poll|relogin`、`GET /oauth/status`；EdgeOne 不提供登录。
- 新增 `shared/presets/minimax-code.json`；仅官方 OAuth，不集成 magpie/Antigravity/WorkBuddy。

### 控制台 UI 标准化
- 落地 v2 语义 token（色板/圆角/阴影/间距）、`ui.js` 组件层（button/badge/capsule/card/pageHeader/field/table/empty 等）。
- 登录页、顶栏、导航、四个页面 pageHeader、弹窗/Toast 统一为 v2 视觉；供应商/模型/设置/概览沿用现有数据流与 DOM 契约。
- 保留 OAuth 账号登录入口；EdgeOne 通过 `oauthLogin` 能力位隐藏。
- 新增 `tests/test_ui_standard.py` 地基守卫。

### 回归
- 全量测试通过，G1~G6 通过；EdgeOne 单文件体积仍在预算内。

## [v20261027-01] - 2026-10-27

### 失败统计与错误日志一致性
- 修复 Agent 粘性（manual）上游 4xx/5xx 时 `agent_metrics` 记失败、但 `stats.error_logs` 为空的问题：manual、400/413 提前 abort、读/连接超时等路径在 `raise` 前补写 `stats.record`。
- 全候选冷却（未真正发起请求）时补一条 429 错误日志，避免概览失败数与日志表不一致。
- 连接池耗尽等无候选的网关级失败（`record_gateway_error`）也写入错误日志，不误标具体 Key。
- 新增 `tests/test_failure_logging_consistency.py` 并接入 T1。

### 工程流程
- 发版节奏为**批次发布**：一个 patch 版本聚合一批相关变更，同一天最多 1 个常规版本；只有 P0 线上故障/安全事件才允许 hotfix 立即发版。未到发版点的变更只合并 `main` 并记入本节，`version.json` 保持上一个已发布版本。详见 `docs/RELEASE_SPEC.md` §〇。

### 清空错误日志语义修正
- 管理端「清空错误日志」原来调用 `action=reset`，会把请求计数、成功率、Agent 今日汇总一并清零；现改为 `action=clear_logs`。
- 新增 `stats.clear_error_logs()`：只清 `error_logs`，保留所有统计与今日汇总。
- UI 确认文案明确“统计会保留；如需全部清零请到系统运维重启服务”；显式 `reset` action 保留给运维/测试，不再由该按钮触发。
- 回归：`tests/test_api_layer.py` 断言 clear_logs 后 agent count/success/5xx 不变、error_logs 为空。

### 文档与契约
- 新增 `docs/EXTERNAL_REFERENCES.md`：集中登记 EdgeOne 官方文档（Fetch/edgeone.json/Makers/日志分析）、厂商 API 文档与更新规则。
- 明确 EdgeOne 日志在腾讯云 Makers 控制台查看，不在 OCRProxy UI；Edge Functions 日志来源按官方当前规划处理。
- `CLAUDE.md` 明确冲突优先级：schema + runtime + tests > 近期文档 > 历史架构文档。

---

## [v20261023-04] - 2026-10-23

### 参数精简 v2（PR #25：KB / Agent 按模式开放参数）
- **按模式开放参数**：Agent 手动直通不显示任何参数（固定 300s）；Agent 稳定模式只显示首字节超时（默认 120→**90s**）和冷宫时长；KB 显示 Chat / Embedding·Rerank / OCR 三个超时、单 Key 并发、OCR 队列、429/5xx/熔断和冷宫时长。
- **冷宫**：402、余额不足/欠费关键词、401 Key 无效、403 封禁或无权访问该模型，统一使用 `cooldown_quota_sec`，默认 1800s→**24h**（上限 7 天，设置页按小时填写）。删除 `cooldown_403_sec`。VM 把冷宫写入 `CONFIG_DIR/key_bans.json`，重启后不丢；在模型列表手动测试该 Key 成功即解除，「解除所有冷却」会全部清空。EdgeOne 的 401 原来只冷却 30s，现在同样进冷宫；403 模型/地区限制仍是短冷却（边缘节点地区不固定）。
- **KB 单供应商多 Key**：修复某个 Key 一次 502/503/504 或读超时，就跳过同供应商其余所有 Key 的问题（20 个 Key 只有 1 个供应商时会直接整单失败）。现在只有配置了多个供应商时才跳过；读超时不再触发跳过。删除 `fast_failover_provider_down` 配置。
- **KB 超时拆分**：新增 `kb_chat_timeout_sec`（默认 60s），`upstream_timeout_sec` 只管 Embedding/Rerank（默认 15→20s）。
- **KB 熔断**：只保留 `circuit_cooldown_sec` 一个参数（默认 300→600s），删除 `circuit_escalation_sec`（原来实际冷却取两者最大值，导致前者永远不生效）。
- KB 单 Key 并发默认 16→**4**，Key 多时负载会摊开。
- Agent 模式不再显示 429/5xx/熔断参数（Agent 遇 429 先在当前 Key 上按 Retry-After 等待，最多 20s，再切下一个 Key；5xx 不冷却）；EdgeOne 熔断参数本来就不读配置，也一并隐藏。KB 策略只保留「轮询」和「手动」两个后端实际支持的选项。
- **旧配置迁移**（`_params_rev=2`，VM 和 EdgeOne 一致）：仍停在旧默认值的参数自动换成新默认值，改过的值保持不变；同时删除废弃字段（`max_retries` / `request_total_budget_sec` / `cooldown_403_sec` 等）。
- 测试：新增 `tests/test_param_simplify.py`（已接入 run_tests）。

### 设置项生效契约（UI 参数不生效根因修复）

- 根因一：KB 设置行使用 `data-cap="kb"`，但 `HOST.capabilities` 没有 `kb`；`applyCapabilities()` 会把整行 `hidden`，保存后用户看不到/改不了参数。修复：移除不存在的 `data-cap`，按 schema `modes`/`strategies` 显隐。
- 根因二：EdgeOne UI 写 `agent_first_byte_timeout_sec`，运行时却读 `upstream_timeout_sec`，形成"UI 有、后端不认"的静默漂移。修复：统一 UI 保存键与 runtime 读取键，EdgeOne 真正读取 `agent_first_byte_timeout_sec`。
- 新增 `tests/test_settings_binding_contract.py`：校验所有 `data-cap` 必须来自 `HOST.capabilities`、`data-arch` 合法、已删除配置不得复活、schema 字段必须有运行时读取点；已接入 `run_tests` T1。
- 文档纠偏：`ARCHITECTURE_STANDARDS.md` 的 EdgeOne 25s/30s 预算改为固定 300s；`SYSTEM_DESIGN_SPEC.md` 删除过期的 `request_total_budget_sec`/`max_retries` 和"文档先行"表述，改为契约先行（讨论确认 → 代码+测试 → 文档同批）；新增 `CLAUDE.md` 明确冲突时以 schema + runtime + tests 为准。

---

## [v20261023-03] - 2026-10-23

### 统一超时模型（配置收敛）

- 删除 `request_total_budget_sec`、`max_retries`、`max_attempts_per_provider`：这三个配置会互相截断，出现"4 个 Key 只试 2 个""总预算先到、后面的 Key 永远轮不到"。
- 硬总超时固定 **300s**：EdgeOne 为平台架构上限，VM 为安全上限；只做防挂死，不参与"能试几个 Key"的计算。
- **粘性场景**：固定当前 Key，不轮换；VM 纯中转并保留 300s 安全超时，EdgeOne 到 300s 按超时返回。
- **自动轮换场景**：按候选 Key 逐个尝试，**成功 / 试完所有 Key / 300s 谁先到谁结束**。
- **KB 场景**：正常轮换；全部 429/冷却时立即返回 `429 + Retry-After`，客户端自行重试，服务端不排队等待。
- EdgeOne 修正：真正读取 `agent_first_byte_timeout_sec`（不再拿 `upstream_timeout_sec` 当全局超时）；全冷却不再返回"0 个候选均已尝试 / HTTP 0"，改为 429 + Retry-After。
- 设置页删除总预算 / 最大重试 / 单供应商 Key 上限，UI 只保留实际生效字段。
- 回归：全量测试通过；新增 EdgeOne 超时/全候选轮换契约测试。

---

## [v20261023-02] - 2026-10-23

### EdgeOne 模型列表状态修复
- `/api/test` 的 `/models` 探测路径不再写 `nodestat`：探测只是连通性诊断，之前会把真实调用留下的 429/403 覆盖成 200，导致模型列表显示错误状态。现在列表始终以最近一次真实 chat 请求为准。
- 无 `model` 的纯探测仍返回 `mode: "probe"`，前端 Toast 标注"/models 探测"，不冒充真实请求。
- 回归：单测断言探测不得覆盖最近一次真实状态。
- **部署说明**：EdgeOne 需重新 `npm run deploy` 才生效；VM 升级后 Toast 文案同步，不涉及转发逻辑。

---

## [v20261023-01] - 2026-10-23

### EdgeOne 模型测试修复
- `/api/test` 单 Key + 指定模型时，只以真实 `chat/completions` 请求（`max_tokens=16`）结果为准：失败不再回退到 `/models` 探测并报告成功；成功/失败的 status、latency、time 会写入 `nodestat:*`，模型列表随后刷新即可看到最新状态/耗时。
- 无目标模型的探测路径显式返回 `mode: "probe"`；前端 Toast 区分「真实小请求」与「/models 探测」，不再把探测成功当作真实请求成功。
- 回归：新增 EdgeOne 单测——429 真实请求不得回退成功、失败状态写入列表、成功写 200、探测路径标记 probe。
- **部署说明**：EdgeOne 是独立部署的边缘函数，需要重新 `npm run deploy`（或你们的 EdgeOne 发布流程）才能生效；旧部署会继续显示过时的预设供应商下拉。EdgeOne 仅 Agent 模式且本身是 Hub，因此不显示"从中枢拉取"来源；VM 是 Agent+KB 客户端，才显示该来源与 KB 候选列表——这是能力位差异，不是两套代码。

---

## [v20261022-01] - 2026-10-22

### VM 运行模式时段调度（mode_schedule，PR #23 + #24）
- 系统设置新增「按时段自动切换」：默认关闭；开启后按北京时间在 KB（默认 22:00–08:00）与 Agent 之间自动切换；每个时段只切一次，手动切换保留到下一个边界。
- **切换前等空闲**：`/v1` 无进行中请求且最近 5 分钟无请求结束才切；Agent→KB 最多顺延 15 分钟，KB→Agent 最多顺延 1 小时；强制切换只影响新请求，已开始的请求继续用旧配置。
- **原子写入**：调度器通过 `config_store.update_config()` 在写锁内重新读取最新配置，只改 `run_mode`/`_version`；管理端保存/导入改用 `replace_config(expected_version=...)` 版本 CAS，读到写之间被并发更新时返回 409。不会再出现调度器用旧快照覆盖新 Key/设置、`_version` 倒退或复活已删除 Key 的问题。
- **手动切换优先**：管理端改 `run_mode` 后写入当前 slot 标记；调度器 deferred 窗口内也不会把手动选择改回去；tick 读后到写前发生手动切换时放弃本次自动切换。
- **slot 独立存储**：`CONFIG_DIR/mode_schedule_state.json`；边界时刻不再无意义 bump 版本/生成备份/让管理端误收 409。
- **加固（PR #24）**：`GET /v1/models` 等探活不计入忙碌；`presets/update-rules` 改为在副本上修改、最后 `update_config` 原子写回，拉规则期间发生的模式切换不会被旧 `run_mode` 回写。
- **单实例选主**：`CONFIG_DIR/.mode_scheduler.lock` 文件锁，多 worker 只运行一个调度循环。
- 回归：时段计算、手动优先（含 deferred）、原子写保留并发管理改动、CAS 冲突、KB 1h 强制、探活不算忙碌、preset 并发切换、leader lock、流式 activity 中间件。

### 验证
- `tests/test_mode_scheduler.py`、`run_tests --layer=logic`、全量测试与 T0 G1~G6 全绿。

---

## [v20261021-05] - 2026-10-21

### 管理后台
- 系统设置新增「保存中枢配置」按钮：中枢 URL/Token 走 `/api/admin/vault/config` 单独保存，不参与整包配置版本锁；`cfg_vault_url` / `cfg_vault_token` 输入框回车也走独立保存，修改 Token 不再被其它设置保存的 409 连累。
- 整包保存 409 冲突提示改为可行动文案：明确"本次保存未写入、之前的保存不受影响"，并回填刚输入的 Token（仍不回显），点「保存中枢配置」即可重试；同时说明多窗口并发写配置的成因。

### 数据安全 / 备份
- 滚动配置备份由 20 份改为**只保留 1 份**；删除 Key/供应商保存成功后自动**清理全部滚动备份**，避免 pre-delete 快照长期保留已删除的密钥（加密备份与 `ENCRYPT_KEY` 同机，历史越多可恢复窗口越长）。
- `install.sh` 的安装备份（含 `.env` 与 `config`）只保留最近 1 份，目录权限 700，避免升级备份无限累积。
- 删除供应商/Key 的确认提示补充：**本地删除不会移除中枢中的 Key**，彻底删除需在中枢操作；本地历史备份会一并清理。
- 新增回归：备份只保留 1 份、删除供应商后本地备份清空。

### 验证
- `npm run test:full` 全绿；T0 G1~G6 全绿。

---

## [v20261021-04] - 2026-10-21

### Security（安全热修复续，合并 PR #22 + 补强）
- **Token 与中枢地址绑定**：vault 接口（`test` / `manifest` / `fetch-key` / `add-keys` / `sync`）此前请求体 URL 优先、Token 回退已保存值，仅凭管理密码即可把真 Token 发往任意地址；`/api/admin/config` 也可改 URL 而保留旧 Token。现在已保存 Token 只发往已保存地址，换地址必须带新 Token（v20261021-03 只堵了 `/vault/config` 一条路径）。
- **中枢供应商连接字段后端只读**：`origin=vault` 供应商的 `origin` / `base_url` / `anthropic_base_url` / `adapter_rules` / `protocols` / `protocol` / `anthropic_messages` / `preset_id` 保存时强制还原、合并导入时跳过，防止改 `base_url` 后让转发/探活把中枢 Key 明文发出去；UI 本来就禁用，操作无变化；规则更新仍走 `/vault/sync` 或重新拉取。
- **环境变量 Token 同样绑定地址**：仅依赖 `VAULT_ACCESS_TOKEN` / `EDGEONE_VAULT_TOKEN`（配置里无 Token）的部署，换中枢地址也必须重输 Token，否则 env Token 会被发往新地址（新增回归）。
- **明确不采用**：撤回 PR 中的 `CLIENT_IP_HEADER` / XFF 最右项改动（改变挂 CDN 时限流行为），登录限流保持 v20261021-03 语义；线上无行为变化。
- **回归**：`test_vault_token_never_follows_another_url`、`test_vault_provider_connection_fields_locked`、`test_vault_env_token_not_sent_to_changed_url` 全部通过。

---

## [v20261021-03] - 2026-10-21

### Security（安全热修复，优先发布）
- **导出全掩码**：`GET /api/admin/config/export` 对所有 provider Key 掩码、`edgeone_vault.token` 置空。此前导出是 `copy.deepcopy(config)` 明文全量（含 Token），管理员会话被窃取即可一键拿走全部密钥；现在导出不再含任何明文，导入仍按"掩码保持原值"恢复。
- **中枢 Token 只写不读**：`POST /api/admin/vault/config` 响应只返回 `has_token`，不再返回 Token 明文/前后缀；`/api/admin/config` 继续只给 `has_token`。
- **改中枢地址必须重输 Token**：地址变更且未提供新 Token 直接 400，防止攻击者把中枢指向自己的服务器，借下一次 manifest/fetch 骗取 Bearer Token。
- **中枢地址校验**：仅 http/https、禁止 URL 内嵌账号密码、禁止云厂商元数据/链路本地地址（`/vault/config`、`/vault/test`、`/api/admin/config` 保存均生效）。
- **登录限流抗伪造**：`X-Forwarded-For` / `X-Real-IP` 仅在请求来自回环（同机反代）或显式 `TRUST_PROXY_HEADERS=1` 时可信，避免轮换伪造 IP 绕过 5 次/10 分钟锁定。
- **回归测试**：导出不含明文、Token 不回显、改地址缺 Token 被拒、非法/元数据地址被拒、同地址轮换 Token 成功。
- **范围**：仅收敛管理面攻击面，不改 `/v1` 转发链路，性能与离线可用性零影响；OS/root 被攻破后内存与可解密配置仍可读，属明确接受的残余风险（免费 Key 按轮换处理）。

---

## [v20261021-02] - 2026-10-21

### 管理后台
- 供应商弹窗的协议与端点改为**两行式**：第一行协议开关，第二行整宽地址输入，解决 OpenAI / Anthropic Messages 地址框过短的问题；只读（中枢托管）供应商的全部控件与保存按钮仍禁用。
- 本地 Key 与 EdgeOne 对齐：`/api/admin/config` 仅对中枢 Key（显式 `origin=vault`）掩码，本地 Key 原值下发（管理员登录态），编辑弹窗可直接查看/修改；中枢 Key 保持掩码只读。

### 修复
- **合并 PR #21**：修复 v20261021-01 引入的 P1 问题——`_migrate_string_secrets()` 与 GET 掩码把「无 `origin` 字段的历史供应商」默认当成中枢供应商，导致 VM 上用户本机录入的 Key 被永久迁移为 `origin=vault`（管理端看不到原值，修改后被保存守卫静默还原）。现在与保存守卫、前端 `resolveKeySource()` 使用同一判定：**只有显式 `origin=vault` 的供应商下未标记 Key 才算中枢只读**；无 `origin` 的老供应商按本地处理。EdgeOne 仍默认 `vault`（其本身即中枢）。
- 新增回归：`test_legacy_unmarked_provider_keys_stay_local`（main 上失败、修复后通过）；本地 Key 可见 / 中枢 Key 仍掩码的断言补强。

### 验证
- `npm run test:full` 全绿（E2E 76 项、契约 S1~S7/U1~U4、vault_ui、overflow、runtime_profiles/settings_resolution）；T0 G1~G6 全绿。

---

## [v20261021-01] - 2026-10-21

### 去重收尾
- 请求级内部键 `upstream_timeout` → `request_timeout_sec`（从不持久化），与保存的 `upstream_timeout_sec` 彻底区分，避免再次误读。
- 旧字符串 Key 加载归一化：VM `config_store._migrate_string_secrets()` + EdgeOne `normalizeProviderKeys()` 把 `"KeyA": "sk-xxx"` 转成 `{key, origin, is_local}`（本地供应商→local，中枢供应商→vault），投影/编辑逻辑不再有字符串特例。

### 修复与体验
- **本地 Key 可编辑**：密钥值不回显（留空 = 保留原值，输入新值 = 替换）；Key 弹窗内标注「本地 Key · 可编辑 / 中枢 Key · 只读」。
- **模型列表操作列底色**：修复 sticky 最后一列背景断层，行背景/悬停色覆盖整行。
- **「单个供应商最多尝试 Key 数」**：替换原「单厂商重试 Key 上限」的复杂描述（换 Key 次数，非重试次数）。
- **保存设置按钮**：统一为小尺寸，与「恢复推荐默认值」一致。
- **新增 Agent 模型弹窗**：移除与胶囊选择重复的「当前已选绑定」列表。
- **供应商卡片徽章**：只显示 `规则 v{版本}`，去掉无意义的同步日期。
- **供应商弹窗协议合并**：OpenAI Chat / Anthropic Messages / OpenAI Responses 各自行内开关 + 地址（Messages 可独立端点，Responses 复用 OpenAI 地址）；中枢托管只读供应商的全部输入、协议开关、RPM 与保存按钮均禁用。
- **首页 Top 3**：与统计卡片同宽同高，移除「今天共 N 个活跃模型」；移除「复制全部模型名」按钮。
- **模型列表「测」**：明确为发送一次真实小请求（chat `max_tokens=16`；embedding/rerank 各自最小请求），不是仅连通性校验；按钮提示与 Toast 已改文案。
- **「最近调用」口径**：改为服务端统计唯一来源，删除浏览器 `localStorage` 缓存，升级/重启后不再显示陈旧日期；探活用 `loadData()` 刷新服务端状态。

### 版本与流程
- 版本号按日期规范使用 **v20261021-01**（今天 21 日），并按 §〇 批次节奏一次性发布本批修复。

---



## [v20261020-09] - 2026-10-21

### 三运行时默认值单一真理源 + 独立冷却策略字段
- **`shared/config/runtime-profiles.json`（新增）**：`edgeone` / `vm-agent` / `vm-kb` 三套默认值——路由策略、首包/快速/OCR 超时、429/5xx/403/欠费/404/410 冷却、熔断阈值与升级、并发上限、重试/预算、peek/precommit 窗口。只承载「流程相同、数值不同」的参数；能力有无、控制流、数据形状差异仍由代码分支/能力位表达（判定准则见 `SYSTEM_DESIGN_SPEC` §3.4.x）。
- **VM 侧**：新增 `vm-app/app/runtime_profile.py`。`scheduler` 的 KB 每 Key 并发默认（16）、KB 全局并发闸门（30）、410 冷却（86400）、KB 熔断升级（1800）、失败评估默认值，以及 `proxy_routes` 的 OCR 默认并发（12）/排队超时（30）全部改由 profile 解析；显式配置仍经 `get_setting()` 优先。
- **EdgeOne 侧**：`build-presets.mjs` 构建期生成 `lib/generated/runtime-profile.js`（`DEFAULT_SETTINGS` / `COOLDOWN_DURATIONS` / 熔断阈值），`lib/config.js`、`lib/cooldowns.js` 删除手写默认值与冷却表；顺带修正 `circuit_cooldown_sec` 默认值内部漂移（`config.js` 60 vs `cooldowns.js`/VM 300，现统一 **300**）。
- **schema 独立字段**：新增 `cooldown_quota_sec`(1800)、`cooldown_404_sec`(600)、`cooldown_410_sec`(86400)、`circuit_escalation_sec`(1800, KB-only)、`kb_global_max_concurrency`(30, KB-only)，`hosts=vm`；不再借 `cooldown_403_sec` 别名或代码常量表达不同策略。设置页按 `modes`/`hosts` 自动渲染（VM 可见、EdgeOne 不可见）。
- **测试**：新增 `tests/test_runtime_profiles.py`（T1，0.35s）：校验 profile ↔ schema 字段一一对应、VM 常量确来自 profile、Edge 生成物与 JSON 完全一致、Edge 源码不得复活手写默认值；接入 `logic` 与发版全套 `all` 层。
- **文档**：`SYSTEM_DESIGN_SPEC` §3.4.x 增加「已落地」清单，剩余未收敛项收敛为：请求级超时键重命名、`v1` relay 骨架抽取、字符串 Key 加载归一化、冷却**触发条件**共享策略表、`/api/config` 契约化。
- **验证**：四层全量测试 18.4s 全绿（含 `runtime_profiles` / `settings_resolution`），T0 G1~G6 全绿。

---

## [v20261020-08] - 2026-10-21

### 合并 PR #20：修复去重引入的运行时回归（超时 / 冷却 / 中枢字符串 Key）
v20261020-07 把 `settings.schema.json` 中原本只用于「旧配置迁移 / 设置表单显示」的 `aliases` 直接接入了运行时 `get_setting()`，把不同策略的参数混为一谈。已按 PR #20 逐项修复并补回归：

- **R1 Agent 首包超时**：`agent_first_byte_timeout_sec` 不再从 KB 的 `upstream_timeout_chat` / `upstream_timeout_sec` 别名兜底。新装模板写 `upstream_timeout_chat=45`、KB 模式保存设置写 `15`，此前会把 Agent 首包从 120s 降为 45s/15s，长思考请求被误判超时并切 Key。
- **R2 403 冷却**：`cooldown_403_sec` 不再复用 `cooldown_quota_sec`（欠费/额度冷却）别名；只配欠费 1800s 时，403 不再被冷却 1800s。
- **R3 请求级超时优先**：`scheduler` 先读取本次请求设置的 `upstream_timeout`（如 OCR 60s），再回退到 schema 的全局 `upstream_timeout_sec`（15s），恢复"分类超时优先于全局默认"的既有语义。
- **R4 中枢字符串 Key**：EdgeOne `isVaultExportableKey()` 对**非空字符串** Key 放行（配置文档中的 `"KeyA": "sk-xxx"` 写法），manifest 与 fetch 恢复一致导出；`is_local`/`origin=local` 仍严格隐藏。
- **设置页显示**：Agent 模式的超时输入框不再把 KB 的 `upstream_timeout_sec` 当作默认显示值。
- **测试**：新增 `tests/test_settings_resolution.py`（T1，R1~R4；R3 对真实慢上游跑 `schedule()`，R4 直接跑 EdgeOne 函数）；PR 只将其加入 `logic` 层，本版补入发版全套 `all` 层，确保 `test:full` / 发版必跑。
- **文档**：`SYSTEM_DESIGN_SPEC` §3.4.x 新增「三运行时差异矩阵（EdgeOne / VM-Agent / VM-KB）」与判定准则，并更新遗留项（runtime-profiles、quota/404/410 独立字段、`request_timeout_sec` 重命名、字符串 Key 归一化、relay 骨架抽取、`/api/config` 契约化）。
- **验证**：四层全量测试全绿（含新增 `settings_resolution`），T0 G1~G6 全绿。

---

## [v20261020-07] - 2026-10-21

### 全仓去重与单一实现收敛（行为等价，除一处与既有语义对齐的修正）
- **前端协议词汇唯一化**：`core.js` 新增 `normalizeProtocolList()` / `formatProtocolLabel()`；`providers`/`vault`/`agent-models-ui`/`models` 的协议标签、徽章、预选、provider option 全部委托，删掉 agent-models-ui 内重复的 4 个协议/供应商辅助函数。
- **供应商下拉唯一渲染**：`vault.js` 新增 `populateLocalProviderSelect()`，Agent 模型弹窗与 KB 候选弹窗共用；删除两份重复的 option/占位/默认选中逻辑。
- **凭据来源统一**：后端 `config_store.secret_origin()` / `stamp_secret_origin()`、前端 `vault.js stampSecretOrigin()` 统一 `origin` 与旧字段 `is_local` 的读写，杜绝两套判定漂移。
- **适配规则加载唯一化**：新增 `vm-app/app/presets.py`（目录解析/文件名归一化/缓存/失效），`admin_routes` 与 `proxy_routes` 删除各自副本；新增 `get_run_mode()` / `vault_url_and_token()`，删除重复的 run_mode 归一与中枢 URL/token 解析。
- **参数读取唯一化**：`proxy_routes` / `scheduler` 的 upstream/agent 超时、cooldown_429/5xx/403、circuit_*、max_retries 等长 `or` fallback 链全部改走 `settings.schema.json` + `settings_schema.get_setting()`；config merge 键清单由 schema `all_setting_keys()` 生成；schema 别名顺序、`circuit_cooldown_sec` 默认值（60→300）与运行时对齐。
- **EdgeOne 中枢投影唯一化**：`lib/config.js` 新增 `toVaultProviderView()` / `isVaultExportableKey()`，manifest 与 fetch 共用；修正「manifest 只过滤 is_local、fetch 还过滤 origin=local」造成的清单/拉取不一致（**唯一可见行为修正**：中枢清单不再列出 `origin=local` 的供应商与本地 Key，与 fetch 既有拒绝语义一致）。
- **构建与生成物收敛**：根 `build:admin` 拆为 `build:assets` + T0 门禁，`agent-edgeone` 脚本全部委托根目录；`build-presets` 改为确定性输出（版本/日期取自 `version.json`）单写一次后镜像，并清理 19 个旧手工 per-provider JSON 副本；`edge-functions/` 根镜像改为带删除的 `syncTree()`；删除历史手写重复 bundle `agent-edgeone/admin.js`（78KB）。
- **门禁增强**：新增 T0 **G6**——根 `edge-functions/` 与 `agent-edgeone/edge-functions/` 逐字节一致，`lib/presets/*.json` 与 `agent-edgeone/admin.js` 禁止复活；发版门禁 G1~G5 → **G1~G6**。
- **遗留未收敛项**（已写入 `docs/SYSTEM_DESIGN_SPEC.md` §3.4.x，需单独评审）：EdgeOne `DEFAULT_SETTINGS` 由 schema 生成、`v1/chat` 与 `v1/messages` relay 骨架抽取、Edge↔VM 冷却策略统一、`/api/config` 语义契约化。
- **验证**：四层全量测试 17.6s 全绿（S1~S7 / U1~U4 + vault_ui 双模式 + E2E 76 项），T0 G1~G6 全绿；除上述 manifest 过滤修正外不改变对外 API 与持久化配置格式。

---

## [v20261020-06] - 2026-10-21

### 新增供应商信息区精简、协议按适配脚本预选、移除多余的中枢同步按钮
- **中枢托管来源信息区只保留两条判断**（`#p_desc`）：
  - `中枢 N 个 Key`（来自中枢 manifest 的 Key 数量）；
  - `适配脚本 v{version} · {updated_at}`，无适配脚本时明确显示 `无适配脚本`；
  - 原「一次性整体拉取 / 重新拉取需先删除 / 中枢 Key 只读可删」长段落收敛到 Tooltip，不再占用正文。
- **协议默认值按本地适配脚本预选**（`#p_proto_hint`）：
  - 选中中枢供应商或输入命中的「供应商标识」时，按本地适配脚本声明自动勾选 OpenAI Chat / Anthropic Messages / OpenAI Responses；
  - 协议区提示 `已按适配脚本预选：…（可手动调整）`；无适配脚本时回退中枢 manifest 的 `protocols`；
  - 修正「只勾 Chat 却填了 Messages 独立端点」的不一致：仅在选中 Messages 且存在 `anthropic_base_url` 时才展开独立端点。
- **移除「供应商」页「从凭据中枢同步」按钮**：Key 并不能通过它同步，规则又与本地适配脚本重复，语义不清；
  - 规则升级统一走供应商卡片「升级至 vX」；
  - 系统设置「增量同步中枢规则」与 `POST /api/admin/vault/sync` 保留为 API / 兜底入口。
- **确认过滤行为**：已从中枢拉取过的供应商不会再出现在「新增供应商 → 中枢按需拉取」列表（按 provider id 大小写不敏感过滤），避免重复拉取与 409。
- **测试与文档**：`test_vm_vault_provider_ui` 新增信息区仅两条/协议按适配脚本预选/无脚本回退的断言；`test_behavioral_real_suite` 改为断言同步按钮已移除；静态 UI 契约更新所需 id；SYSTEM_DESIGN_SPEC §3.4/§3.5.1 与 README 同步；四层全量测试与 G1~G5 门禁全绿。

---

## [v20261020-05] - 2026-10-20

### 新增供应商 UI 收敛为「来源选择」，预设规则改为本地自动匹配
- **问题**：新增供应商下拉同时列出「官方预设供应商（16 项）」与「EdgeOne 凭据中枢托管（按需拉取）」，同一厂商重复出现（如 硅基流动 两次，协议文案还不一致 `openai+message` / `OpenAI`）；既破坏「EdgeOne 与 VM 同一套 UI」原则，也与设计文档「下拉只表达来源」矛盾。
- **修复（双端统一）**：
  - 下拉只表达供应商来源：EdgeOne 仅「自定义供应商（手动填写）」（保存即中枢母本）；VM 为「自定义」+「EdgeOne 凭据中枢托管 (按需拉取)」中的未导入项（保存 = 一次性整体拉取规则 + 全部 Key，落地即本地资产 `origin=vault`）；
  - 官方预设**不再作为任何下拉选项/分组出现**（删除 `官方预设供应商` optgroup 与重复的中枢条目渲染）。
- **预设规则自动匹配**：16 款官方预设改为纯本地适配规则模板——输入与预设同 `id`/同名称的「供应商标识」时，自动带入 Base URL、协议、RPM 与规则说明，保存时写入 `preset_id`/`preset_version`/`preset_updated_at` 并落地 `adapter_rules`，无需在 UI 中选择预设。
- **契约与测试**：
  - 新增契约场景 **U4**（真实浏览器，VM 与 EdgeOne 双端）：新增供应商下拉首项为自定义、不含任何官方预设 id、无「官方预设供应商」分组；
  - 扩展 `test_vm_vault_provider_ui.py`：断言来源型下拉 + 预设规则按名称自动匹配；
  - 双端契约 S1~S7 / U1~U4、四层全量测试与发版门禁 G1~G5 全绿。
- **影响面**：仅管理后台「新增供应商」弹窗与预设规则匹配时机；后端接口、调度逻辑与既有供应商数据不变。

---

## [v20261020-04] - 2026-10-20

### 修复「从中枢按需拉取供应商」被误判为编辑而失效
- **严重缺陷**：`saveProvider()` 过去用 `#p_name.disabled` 推断「新增 / 编辑」，而中枢预设为了让名称只读也会 `disable` 名称框，导致保存时进入「编辑已有供应商」分支，`POST /api/admin/vault/fetch-key` 根本不会被调用——选中「EdgeOne 凭据中枢托管（按需拉取）」的供应商保存后，本地只会得到一个 `origin=local`、**0 个 Key** 的空壳供应商，中枢规则与 Key 都没有落地；KB 模式因此无法把中枢供应商挂载为候选节点，与 Agent 侧的本地资产表现不一致。
- **修复**：改为显式编辑态标记（`openProviderModal` 置 create、`editProvider` 置 edit），彻底移除对 DOM `disabled` 状态的推断；同时在打开/编辑弹窗时清理残留的 `currentSelectedVaultProvider`，避免上一次选择污染本次保存。
- **回归测试**：新增 `tests/test_vm_vault_provider_ui.py`（T2 浏览器层，KB + Agent 双模式）：拉起真实 HTTP 中枢与 VM 服务，用真实 Chromium 点击「新增供应商 → 选择中枢项 → 保存并生效」，断言 `origin=vault`、中枢 Key 全部拉取且掩码只读、KB「挂载候选节点」弹窗立即可选该供应商；已接入分层测试 T2 契约层与发版全套。
- **影响面**：仅 VM 端供应商管理 UI；EdgeOne 中枢母本与后端 `/vault/fetch-key` 逻辑不变。

---

## [v20261020-03] - 2026-10-20

### 独立评审修复：中枢写入版本锁、旧中枢 Key 只读与首页快照口径矫正
- **中枢写入统一版本锁与滚动备份（P0 修复）**：
  - `/vault/fetch-key`、`/vault/add-keys`、`/vault/sync`、`/vault/config` 改为统一 `_save_vault_config_change()` 持久化，与手动保存一致地自增 `_version` 并生成滚动加密备份；
  - 修复「在拉取/同步之前打开的旧标签页再次保存会静默删除刚拉取的供应商与 Key」的数据丢失竞态：旧标签页现在收到 409 版本冲突（本地自建 Key 无法从中枢恢复，必须拦截）。
- **旧数据中枢 Key 只读保护（P1 修复）**：
  - 后端：`origin=vault` 供应商下升级前遗留的未标记裸字符串 Key 同样只读（保存时还原原值、可删除）；
  - 前端：供应商 `origin=vault` 时，未标记 Key 回退判定为 `[中枢]`，中枢离线/未配置时不再误显示为可编辑的本地 Key（避免保存后被写成 `origin=local`）；VM 端「供应商」页中枢 Key 不再渲染「编辑」入口（EdgeOne 作为中枢母本不受影响）。
- **首页 Agent 快照按 Key 聚合（P1 修复）**：
  - 同一 Key 绑定多个模型时，EdgeOne 快照先按 `provider:key` 聚合再统计，修正「可用 Key / 冷却故障 / 最近平均耗时」重复计数及「有成功记录却显示未调用/最近失败」的问题；
  - 契约 U3 增加唯一 Key 数量与数值断言，夹具覆盖多模型绑定同一 Key 的去重口径。
- **冷却字段契约化（P1 修复）**：`candidates_status.*.cooldown_until` 正式写入后端契约，VM stats 从调度器冷却窗口补齐该字段，双端快照口径一致。
- **统计边界与重置修复**：
  - SSE 错误帧改为按事件与 JSON 解析：正文内容包含 `event: error` 不再误判为失败，`data:  {"error"`（多余空格）与 `{"type":"error"}` 不再漏判；
  - keep-alive 注释与首个 data 事件同处一个 chunk 时正确计入首字延迟（TTFT）；
  - 「重置统计」接口返回最新 stats 载荷，前端不再把 `{status}` 当作 stats 而回退到空快照；流式统计包装显式关闭上游迭代器，及时释放连接与 Key 租约。
- **安全收口**：`/probe-models` 从中枢取出的明文 Key 只允许发往中枢声明的 `base_url`，不再跟随调用方临时传入地址，杜绝「管理员口令 + 自定义 base_url」的明文 Key 外送通道。
- **回归测试**：
  - 新增 Layer 2 `test_vault_write_version_and_legacy_key_guard`（版本自增、旧标签页 409、旧字符串 Key 不可改写、重置统计返回 stats）；
  - `test_agent_metrics` 补充错误帧误判、同块 keep-alive、Anthropic `event: error` 等边界；契约 U2/U3 在无 Playwright 环境正确 SKIP；
  - 四层全量测试 100% 通过，发版门禁 G1~G5 全绿。

---

## [v20261020-02] - 2026-10-20

### Agent 首页今日统计与中枢供应商拉取/同步规约收敛
- **Agent 首页「今日累计」统计（VM 端）**：
  - 新增 `vm-app/app/agent_metrics.py`，以北京时间自然日累计今日 Token 总量（输入 / 输出 / 用量覆盖率）、平均首字延迟（TTFT，跳过 SSE keep-alive 注释）、失败请求（含 200 流内 error 帧，客户端主动断开不计失败）与切 Key 救回次数；
  - 仅统计进入调度的 Agent 请求（鉴权 / 参数错误与 KB 流量不计）；Token 取自响应 usage（Anthropic 输入含 cache read / creation），网关不注入 `stream_options.include_usage`，卡片显示「用量覆盖率」；
  - 每 30s 节流原子写入 `CONFIG_DIR/agent_summary.json`，服务关停时 flush，重启不清零；「重置统计」同步清零内存与磁盘；
  - Agent 首页 Top 3 改为今日按调用量排序，每项附 Token 与首字延迟。
- **EdgeOne 首页「当前快照」降级呈现（后端零改动）**：
  - EdgeOne 不做累计、不新增 KV 写入；前端以 `candidates_status` 计算「可用 Key / 冷却或故障中的 Key / 最近平均响应耗时」三卡，同一份 `core.js` 渲染；
  - 角标标注「当前快照」，Top 3 在快照模式下隐藏，双端界面保持一致。
- **VM 中枢供应商拉取与同步规约收敛（PR #18）**：
  - 拉取收敛为「新增供应商」一次性整体拉取（规则 + 全部 Key），本地已存在同名供应商返回 409（先删除再拉）；拉下的 Key 标记 `origin=vault`，只读可删；
  - 「同步中枢规则」只更新 `origin=vault` 供应商的规则（协议 / URL / 适配规则 / 模型列表 / RPM），不拉取、不恢复、不新增任何 Key，不新建供应商，也不再误把本地同名自建供应商改写为中枢来源；
  - 新增「+ Key → 从中枢添加」（`POST /api/admin/vault/add-keys`，`HOST.capabilities.vaultClient` 控制显示），只新增不覆盖、不改规则、保留既有模型绑定；
  - 彻底移除墓碑 `tombstones` / `tombstone_keys` 与调度器请求路径上的中枢懒拉取；旧数据中无标记的中枢 Key 在同步时补 `origin=vault`（只补标记、不改值）；
  - 前端 VM 侧中枢来源只认 `origin=vault`，徽章改为「来自中枢」；拉取弹窗中枢供应商 URL 置为只读。
- **契约与测试**：
  - `shared/contracts/admin-ui-backend.json` 新增 `stats.agent.summary` 字段与 S7（API）/ U3（真实浏览器）双端场景，另增 U2（「从中枢添加」能力位）场景；
  - 新增 `tests/test_agent_metrics.py`（Layer 1）与 `test_vault_pull_once_rules_only_sync`（Layer 2，MockTransport 模拟中枢）；移除墓碑 / 懒拉取相关的过时断言；
  - 四层全量测试通过：Layer 1 199 项 ESM 单元 + Python 安全/统计测试，Layer 2 双端后端契约 S1~S7 / U1~U3，Layer 3 架构与窄屏安全审计，Layer 4 全矩阵 Playwright E2E 76 项断言；发版门禁 G1~G5 全绿。

---

## [v20261020-01] - 2026-10-20

### 模型提供商、Key 管理与模型规则全版本统一规约
- **供应商管理唯一入口收敛**：全版本（EdgeOne 与 VM）添加供应商唯一入口严格收敛至「供应商」标签页，模型管理弹窗彻底移除中枢未拉取选项；
- **VM 资产自治与自由删除**：从中枢拉取至 VM 的供应商与 Key 变成本地托管资产，VM 端完全允许自由删除；中枢 Key 在本地保持只读保护；
- **供应商按需拉取交互统一**：VM 端在「新增供应商」弹窗内通过预设下拉框选择中枢未导入项，保存即可按需拉取供应商与其全部 Key；
- **Key 增删改查唯一入口**：所有版本对 Key 的增删改查仅限在「供应商」菜单操作，模型管理弹窗彻底移除 Key 删除叉与临时 Key 逻辑，纯粹仅做勾选绑定；
- **中枢与本地徽章强化**：醒目区分蓝紫色 `[中枢]` 与绿色 `[本地]` 凭证徽章；极简同步策略（删除重拉无冲突）；
- **全套自动化测试通过**：Layer 1 (199/199)、Layer 2 S1~S6/U1 契约、Layer 3 架构审计、Layer 4 全矩阵 Playwright E2E 76 项断言全部通过。

---

## [v2026.10.19-10] - 2026-10-19

### 预设下拉协议规范化、列表版本徽章真理源回显与中枢资产本地持久化
- **预设下拉选项协议纯净化与标准化**：
  - 彻底移除添加供应商下拉框中混杂的规则版本号与更新日期杂质，严格遵循设计规约收敛为 `厂商名称 (协议)` 格式（如 `MiniMax (openai+message)`、`DeepSeek 官方开放平台 (openai)`）；
  - 下拉选项统一收敛于 `<optgroup label="官方预设供应商">`，版本与日期仅在选定后的详情说明中呈现。
- **列表卡片规则版本与日期小标签真理源回显**：
  - 在供应商卡片 Header 恢复并规范规则小标签 `[规则 v{version} · {updated_at}]`（例如 `规则 v1.4.0 · 2026-10-18`）；
  - 建立三级回退真理源解析算法：`持久化属性 (preset_id/version/updated_at)` $\to$ `本地 16 套预设库精准索引` $\to$ `自定义规则/默认`；
  - 补齐 `FALLBACK_PRESETS` 为 16 款完整官方适配规则（补全 cline, deepseek, nvidia, openai, openrouter 等），彻底杜绝官方预设丢失规则版本或错误显示为「默认」的问题。
- **中枢拉取资产本地持久化与本地磁盘优先秒级直出**：
  - 落实“从中枢拉下来就是本地的”原则，EdgeOne Vault Hub 清单输出完整携带 `preset_id`、`preset_version`、`preset_updated_at`；
  - VM 端 `/vault/sync` 存储并持久化预设元数据入库；
  - VM 端 `/presets/catalog` 与 `/presets/detail` 调整为本地磁盘优先秒读，消除向 GitHub 探测造成的 2 秒卡顿或外网超时失败。
- **极简发版质量硬门禁 (Lean Release Gatekeeper v2.0)**：
  - 建立 `tests/verify_release_gate.py`，涵盖 G1~G5 黄金法则（版本强一致、EdgeOne 专属身份强断言、安装脚本零漂移、SSOT 编译一致、零明文密钥泄漏），<0.3s 极速拦截；
  - 强断言 EdgeOne 专属身份（`<title>OCRProxy EdgeOne 控制台</title>`、`EdgeOne 边缘版`、`window.__HOST_KIND__ = 'edgeone'`）与金库中枢常驻，彻底防止部署或编译为 VM Agent 版本。
- **四层全矩阵自动化测试套件 100% 全绿**：
  - Layer 1 Unit: 199 项 ESM 单元测试全绿；
  - Layer 2 Contract: VM 与 EdgeOne S1~S6/U1 后端契约全绿；
  - Layer 3 Security: 零内联事件处理器与配置加密审计全绿；
  - Layer 4 E2E: Playwright 浏览器端到端 76 项断言全部 100% 通过。

---

## [v2026.10.19-09] - 2026-10-19

### 落地方案 A 单一真理源编译器与 14 项界面及排版深度缺陷彻底根治
- **“方案 A 单一真理源”彻底落地，废除分叉维护**：
  - 重构 `agent-edgeone/scripts/build-admin.mjs`，彻底废除 “NEVER overwrite agent-edgeone” 的历史妥协，将 `shared/admin/` 确立为全项目**唯一单一真理源**（Single Source of Truth）；
  - 构建脚本直接读取 `shared/admin/` 下的 HTML/CSS/JS，自动在 EdgeOne JS 头部注入 `window.__HOST_KIND__ = 'edgeone'`，一键内联编译至 `edge-functions/admin.js`、`agent-edgeone/edge-functions/admin.js` 及 `agent-edgeone/admin.bundled.html`，并同步分发至 `agent-edgeone/admin.html` 与 `vm-app/static/`；
  - 杜绝针对 EdgeOne 独立手写页面导致的样式漂移与死代码。
- **排版与可见性规则彻底解耦（根治卡片 5 变形与伪显示）**：
  - 移除 `shared/admin/admin.css` 中 `[data-arch="vm"] { display: flex }` 对可见性的粗暴赋值，消除对 `.card` 类名原本垂直流布局的破坏；
  - 确立纯消极隐藏规则 `body.arch-edgeone [data-arch="vm"] { display: none !important; }`，杜绝其优先级压制原生 `[hidden]` 导致的隐藏元素强行复显；
  - 清理 `shared/admin/js/core.js` 中遗留的 `style.display = 'block'/'none'`，全量替换为现代 `el.hidden = boolean`。
- **手动模式提示恢复与卡片 4 丰满呈现**：
  - 清除 `#manual-routing-tip` 与 `#manual-cooldown-tip` 上写死的行内 `style="display:none"`，改由原生属性 `hidden` 控制，解决 JS 移除 hidden 却因内联 style 仍被隐藏导致的空卡问题。
- **Key 输入框通栏拉长与单项配置全宽展开**：
  - 新增 `.settings-row.settings-row-key` 样式规则，控制区 `flex: 1` 自适应拉满，客户端长密钥输入框横向拉长至 640px+；
  - 运行模式、分流策略等单项配置统一标记为 `.settings-row-full`（`grid-column: 1 / -1; width: 100%`），控制器弹性适配（`clamp(280px, 50%, 540px)`），不再局限于半栏窄框。
- **供应商操作按钮实体边框与样式规范规范恢复**：
  - 为供应商列表中的「编辑」与「+Key」操作按钮补齐 `btn-secondary` 类，并在 `admin.css` 中赋予 `.btn` 基础 `1px solid var(--border)` 实体边框，消除悬空视觉。
- **双端多视口响应式防横向溢出（390px 溢出量归零）**：
  - 将 `.settings-row` 调整为 `min-height: 52px; height: auto;`，彻底解除 `.settings-row-ctrl` 的 `flex-shrink: 0;`；
  - 移动端 Appbar 增加 `height: auto; min-height: 48px;`，真机与模拟器在 390px、600px、1366px 视口下横向溢出彻底归零。
- **超时键名与 data-cap 唯一收口校准**：
  - 统一修正 Agent 模式超时标签为 `单次请求等待超时 (agent_first_byte_timeout_sec)`；
  - 清理 CSS 中对 `data-cap` 的硬编码隐藏，统一收口至 `host.js` 的 `HOST.capabilities` 与 `applyCapabilities()` 运行时驱动。
- **全矩阵自动化测试套件扩充与 100% 全绿**：
  - Layer 1 Unit: 199 项 ESM 单元测试全部通过；
  - Layer 2 Contract: VM 与 EdgeOne S1~S6/U1 后端契约全部通过；
  - Layer 3 Security: 无内联 handler 与 CoW 安全审计全部通过；
  - Layer 4 E2E: Playwright 浏览器端到端测试新增移动端 0 溢出、卡片非 flex、手动模式提示可见、Key 通栏拉长等断言，总验证项扩充至 76 项，全部通过。

---

## [v2026.10.19-08] - 2026-10-19

### 系统设置统一流式比例规范与单一真理源重构
- **根治 JS 运行时 display:block 内联覆盖破坏性缺陷**：
  - 彻底杜绝 `shared/admin/js/settings.js` 中对 `.settings-row` 元素写入 `style.display = 'block'` 的破坏性行为（该内联样式曾将 Flex 布局强行压制为块级元素，导致单选/下拉框被粗暴挤压到第二行竖排，并拉伸破坏相邻卡片高度）；
  - 全面升级为 HTML5 原生 `el.hidden = boolean` 配合 CSS `[hidden] { display: none !important; }`，彻底杜绝内联样式污染与布局破坏。
- **吸收 design-system Token 建立 6.5:3.5 黄金流式比例与统一定高**：
  - 汲取 `design-system` 核心设计语言与间距变量，为 `.settings-row` 设定统一标准定高 `52px`（`min-height: 52px;`）、水平无折行（`flex-wrap: nowrap;`）；
  - 标签区（`.settings-row-label`）固定占 `65%` 并施加 `min-width: 0; text-overflow: ellipsis;`，文字超长自动省略截断，并全量注入原生 `title="..."` Tooltip 承载完整语义；
  - 控件区（`.settings-row-ctrl`）占 `35%`（`clamp(160px, 35%, 260px)`），数字输入框统一定宽 `80px`（右对齐 + 紧凑单位），彻底消除各控件大小参差、卡片高度抖动的乱象。
- **单一真理源 UI 与声明式架构自适应**：
  - 严格落实用户指示，彻底杜绝为每个版本搞单独写死页面的分叉做法，将管理后台唯一真实源（Single Source of Truth）收敛至 `shared/admin/`；
  - 采用声明式属性 `data-arch="vm|edgeone"` 与 `data-cap="runModes|kb|vaultClient|systemUpdate"` 驱动双端呈现，在 `agent-edgeone/scripts/build-admin.mjs` 中执行统一条件打包与编译注入，彻底杜绝代码碎片化。
- **响应式断点平滑单列切换**：
  - 在 `< 840px` 窄屏、平板或小窗口视口下，双列网格自动优雅平滑降级为 `1fr` 单列流式网格，内部控件保持单行对齐不折行。
- **全量四层自动化测试全绿回归**：
  - Layer 1 Core: EdgeOne ESM Pure-Logic 单元测试 (198/198) 全部通过；
  - Layer 2 API: FastAPI 鉴权、级联删除与双端后端契约全套场景 S1~S6/U1 全部通过；
  - Layer 3 UI: 无头组件事件委托与无内联 handler 安全审计全部通过；
  - Layer 4 E2E: 全矩阵 Playwright 真实浏览器端到端测试 69 项验证项（包括 32px 紧凑控件、80px 数字框、流式比例、无折行）100% 全部通过。

---

## [v2026.10.19-07] - 2026-10-19

### 合并 PR #14 & #15：落地共享 UI 双端后端契约规范与 EdgeOne 健壮性加固
- **落地共享 UI 与两端后端契约规范（`shared/contracts/admin-ui-backend.json`）**：
  - 统一候选节点状态键名 `agent:<model>:<provider>:<key>` 与 `active_keys` 口径，消弭异构后端实现漂移。
- **修复 EdgeOne 300ms 首包竞速丢首字缺陷**：
  - 首块为 ping 注释超时后不再遗弃挂起的 reader，将其传递给下游 keep-alive 流继续等待消费，彻底杜绝数据截断。
- **修复 EdgeOne 非流式 /v1/messages 报 500 崩溃**：
  - 不可变 Response Headers 导致的运行时错误已解决，重新构造标准可变响应体。
- **EdgeOne 控制台接入真实调用状态与耗时**：
  - 补齐 `/api/admin/stats` 接口调用与 `state.stats` 注入，真实调用状态与耗时实时上屏，并通过 throttle 策略保护 KV 写预算。
- **VM 手动测 Key 键名校正**：
  - 前端测试请求统一携带 `agent_model` 字段，后端以此精准回写 `candidates_status`，消除显示错位。
- **建立全自动双端双轨契约测试套件（`tests/test_backend_contract.py`）**：
  - 同一套真实场景覆盖 S1~S6 与 U1 浏览器渲染，双端全绿保障未来长期演进效率。

---

## [v2026.10.19-03] - 2026-10-19

### 供应商删除级联模型清理、Vault 墓碑防复活、Agent 模式精简与分层测试体系
- **本地主权与级联模型删除**：
  - 移除后端删除 Vault 凭据的 403 阻断限制，保障 VM 节点上对本地供应商与密钥的完全管理主权；
  - 实现后端级联模型删除机制：删除供应商时自动清理所有模型中绑定的该供应商 Key；若某个模型无剩余有效 Key，则级联彻底删除该模型；同时级联清理 KB 模式下的匹配候选节点。
- **删除墓碑机制 (Tombstones)**：
  - 建立本地删除墓碑追踪体系（`tombstones` / `tombstone_keys`），记录被用户主动删除的供应商与密钥；
  - 中枢同步端点（`/api/vault/sync`）严格遵循墓碑，绝不复活已删除的供应商和密钥，彻底解决删除后一同步就重新出现的 Bug；
  - 当用户在控制台重新手动添加该供应商时，自动清除墓碑标记。
- **Agent 模式精简收敛**：
  - 彻底移除 Agent 模式下冗余的「全部探活」功能按钮及汇总面板，避免并发探测带来的状态竞争与异常，统一聚焦于单 Key 测连通性探活。
- **彻底清理废弃界面残余**：
  - 全仓库各版本彻底删除废弃的独立「接入指引」与「JSON 配置」面板、路由与测试断言，各端主导航严格聚焦为标准的 4 大常驻 Tab。
- **工程化分层测试体系 (Layered Tests)**：
  - 建立标准分层测试执行器（`tests/run_tests.py`），提供 4 层递进式验证：
    1. Layer 1 (Core): 协议核心与 ESM 单元测试（198 项通过）；
    2. Layer 2 (API): FastAPI 真实请求与生命周期集成测试（鉴权、级联删除与墓碑防护）；
    3. Layer 3 (UI): 无头组件与事件委托无内联函数断言；
    4. Layer 4 (E2E): 全矩阵浏览器自动化真机测试（58 项全矩阵通过）。

---

## [v2026.10.19-02] - 2026-10-19

### 界面规范收敛与系统设置工程化紧凑重构
- **主导航统一收敛为 4 大 Canonical Tab**：
  - 彻底从主导航中移除 `[接入指引]` 和 `[JSON 配置]`，两端主导航严格收敛为：`概览`、`供应商`、`模型及路由`、`系统设置`；
  - 接入指南（SDK 调用代码与 cURL 示例）下沉为概览 Dashboard 顶部的可折叠卡片，代码块统一应用深色主题（`background: #0f172a; color: #e2e8f0;`），彻底杜绝白底白字无法看清的问题；
  - 底层 JSON 编辑器下沉为系统设置底部的高级配置折叠卡片，并保留格式化与原子热加载保存功能。
- **VM 独立版系统设置全面工程化紧凑重构**：
  - 彻底淘汰原 6 张臃肿卡片，重组为 6 大紧凑模块（`运行模式与鉴权`、`核心分流策略`、`超时与并发`、`熔断与冷却`、`中枢与运维`、`底层数据管理`）；
  - 全面应用 32px 紧凑表单控件（`.form-control-compact`）与 76px 标准数字框，说明文字提炼为高信噪比短语，消除冗长段落；
  - 底部设立单一吸底浮动保存栏（`恢复推荐默认值` 与 `保存设置并生效`）。
- **EdgeOne 与 VM 端时间戳格式化全局修复**：
  - 完善 `_fmtTime` 与 `fmtTime` 格式化工具函数，支持自动识别并转换毫秒时间戳（如 `1792366939692`）与纯数字字符串为 `HH:MM:SS`（或 `MM-DD HH:MM`）；
  - 修复 EdgeOne 运行时未定义 `fmtTime` 导致降级显示原始整数数字的 Bug。
- **端到端全矩阵 Playwright 浏览器自动化断言升级**：
  - 测试套件扩展至 56 项真实断言，自动化验证真实浏览器下的 4 大主导航、内嵌接入指南深色高对比度样式、系统设置紧凑双列与磁盘持久化、JSON 底层编辑器、EdgeOne 控制台独立编译运行时及 KB 模式全流程，断言通过率 100%。

---

## [v2026.10.19-01] - 2026-10-19

### 核心功能与架构加固
- **模型卡片表格严格像素级对齐**：
  - 在 `agent-models-ui.js` 与 `models.js` 中为模型卡片表格注入严格 `<colgroup>` 规范（固定 `52px`, `140px`, `160px`, `80px`, `130px`, `140px`, `160px`）并施加 `table-layout: fixed; width: 100%;`；
  - 在 `admin.css` 中增加全局固定布局与文本防撑爆截断，彻底消除因模型厂商名称长短造成的卡片表头与各数据列参差抖动。
- **后端 403 权限强校验与中枢资产绝对保护**：
  - 在 `vm-app/app/admin_routes.py` 的配置保存接口增加物理校验，任何尝试删除或篡改中枢纳管供应商与 Key 的请求直接被后端阻断并返回 `HTTP 403 Forbidden` (`{"error": "中枢统一凭据不可在本地篡改：禁止删除中枢..."}`)，真正实现服务端权限安全闭环。
- **EdgeOne 探活状态与最近调用常驻回显**：
  - 前端探活记录调用时间戳（`time: Date.now()`），存入 `modelLatencyCache` 并落盘至 `localStorage`；
  - 行渲染器支持本地降级读取，保证在无状态的 EdgeOne 边缘端刷新或重绘后，响应耗时徽章与 `HH:MM:SS` 格式化时间戳依然常驻展示。
- **彻底清除废弃功能与测试现代化**：
  - 全页面彻底拔除废弃的「实测 1+1」按钮与相关事件代码；
  - 淘汰仅靠 grep 检查源码的脆弱假测试与 Mock 框架，新增包含 36 项断言的真实全矩阵端到端浏览器与后端自动化测试套件（`tests/test_vm_full_matrix_e2e.py`），验证 Agent 与 KB 两种模式全页面与全部功能按钮 100% 通过。

---

## [v2026.10.18-12] - 2026-10-18

### 核心功能与架构加固
- **PR #11 管理端凭据归属统一、SSRF 守卫加固与实时推理验收**：
  - 提取 `resolveKeySource` 判定算法并在供应商列表、模型配置弹窗与列表行统一复用，彻底消灭钥匙徽章的历史显示漂移；
  - 在 `admin_routes.py` 构筑 `_admin_upstream_block_reason` SSRF 守卫，公网 HTTPS 永远放行、已保存私有 HTTP 放行，**绝对阻断实例元数据（`169.254.169.254`）**；
  - 管理后台新增「实测 1+1」(`live-test`) 按钮，直接以真实客户端身份发起模型推理验收；
  - 引入 `tests/test_vm_static_sync.py` 强门禁，确保 `vm-app/static/` 与 `shared/admin/` 逐字节强一致。
- **PR #12 流式首包前预提交心跳保活、客户端早停取消与出站连接池保护**：
  - 首包前流式预提交心跳保活（`_stream_with_precommit`）：大模型深思超过静默宽限期（VM 45s、EdgeOne 20s）时，先预提交 200 并以 15s 间隔下发 `: keep-alive` 心跳保活，首包到达后无缝拼接流，根除中间网关超时断开（N3 问题）；
  - 客户端断开主动取消：当客户端中止连接时主动取消调度 Task，原子释放信号量与出站连接；
  - 出站连接池耗尽防御与健康 Key 零误罚：连接池等待锁定为 10s（`UPSTREAM_POOL_WAIT_SEC`），连接池满抛出 `PoolTimeout` 时转为 `503 GlobalOverloadError`，**绝不扣分惩罚健康的 Key**；连接池上限提升至 256。
- **双端全量测试套件 100% 验收通过**：
  - 包含 198 项 EdgeOne 单测、安全基线、SSRF 白名单守卫、静态镜像强同步与 11 项流式心跳门禁。

---

## [v2026.10.18-11] - 2026-10-18

### 核心修复与交互收敛
- **EdgeOne 探活系统（“测”按钮）彻底修复**：
  - 修复 `agent-edgeone/edge-functions/api/test.js` 中 `bindings` 未定义即切片引发的 `ReferenceError: bindings is not defined`（HTTP 500 崩溃）；
  - 严格解耦单 Key 快速探测与整模型并发探测分支：当请求包含 `provider` 和 `key` 时，精准分流至单 Key 探针，并优先对上游模型发起轻量握手验证，获取真实连通延迟；
  - 在 `agent-edgeone/scripts/test-units.mjs` 中追加单 Key 探活与整模型探活的双重回归门禁。
- **「中枢」vs「本地」概念与 UI 胶囊绝对统一**：
  - 明确统一定义：在「模型提供商」页面中录入的所有 Key 属于【中枢 (Vault)】凭据，面向所有节点同步分发，模型配置弹窗中统一渲染 `[中枢]` 徽章且禁删；
  - 只有在模型列表/弹窗中点击「+ 添加本地 Key」临时录入的专属 Key 才标记为 `[本地]`，且仅有此类 Key 具备红色 `×` 删除按钮；
  - 修复 EdgeOne 丢失 `findVaultProvider` 导致所有 Key 错误降级为本地的问题，两端行为 100% 同构对齐。
- **路由分流策略两端严格收敛为两大模式**：
  - 废除 EdgeOne 遗留的轮询、优先级、随机散列等旧选项，与 VM 端完全统一为符合智能体编程心智的两大选项：
    1. `sticky_failover`：**粘性故障转移 (默认推荐)** —— 保持连接与 KV Cache 稳定，遇 429 顺延并长期驻留新 Key；
    2. `manual`：**纯手动直通** —— 锁定当前激活 Key，绝不自动切换，上游状态纯透传。
- **客户端 Key 状态统一与冗余交互精简**：
  - 去除系统设置中冗余的「复制 Key」按钮（首页顶部卡片已有一键复制入口，设置区回归纯粹配置输入职责）；
  - 在 EdgeOne 侧将 `PROXY_API_KEY` 输入框设为禁用灰掉（`disabled`），并标注 `由 EdgeOne 控制台环境变量注入 (env.PROXY_API_KEY 只读)`，彻底消除在 Web 配置是否生效的认知混乱；VM 侧保留直接配置能力。

---

## [v2026.10.18-10] - 2026-10-18

### 界面紧凑化与细节治理
- **系统配置界面紧凑化与信息密度提升**：
  - 彻底精简冗长说明文字，消除重复低效的长段描述，采用高信噪比短语提示；
  - 输入框高度统一标准化为 `32px` 紧凑尺寸（`.form-control-compact`），数字框限制宽度并与单位内联；
  - 重构为紧凑协调的双列 Key-Value 网格布局（`.settings-grid` / `.settings-row`），去除底部冗余按钮行，将纵向高度压缩 60% 以上，在一屏内协调展现；
- **彻底根除 404 规则源镜像死链**：
  - 将 `agent-edgeone/admin.js` 中的预设规则源镜像地址由早已失效的 `xsk/ocrprox` 修正为权威仓库 `khc8655/ocrproxy`；
- **拔除幽灵 25 秒与重试预算对齐**：
  - 彻底删除 `admin.html` 中遗留的隐藏 `value="25"` 幽灵超时字段，开放显式 `request_total_budget_sec` 配置（默认 300 秒）；
  - 全面规范化重试字段为 `max_retries: 3`，杜绝导出导入时将 VM 调度预算压缩至 3 秒；
  - `max_attempts_per_provider` 默认值与重置默认值对齐为 3（与后端一致）；
- **结构化 Key 元数据防覆盖**：
  - 修复 `saveKeyModal` 在编辑普通 Key 保存时浅拷贝保留原有对象扩展属性（`is_local`、`created_at`、`rpm` 等），防止被降级为纯文本；
- **发版门禁强断言追加**：
  - 在 `build-admin.mjs` 与 `tests/test_phase3_phase4_audit.py` 中强断言禁止出现 `xsk/ocrprox` 与 `value="25"`，必须具备 `set_max_retries`。

---

## [v2026.10.18-09] - 2026-10-18

### 架构边界厘清与发版门禁
- **架构正本清源：彻底厘清“UI 组件共用”与“页面骨架复用”边界**：
  - 严格遵守《架构规范》铁律一，恢复 EdgeOne 专属控制台骨架资产（`agent-edgeone/admin.html`、`admin.css`、`admin.js`），保证 EdgeOne 作为【云端真理源凭据中枢（Vault Hub）】的独立控制台地位；
  - 彻底杜绝用 VM 骨架覆盖 EdgeOne，消除 EdgeOne 页面被误标为「Agent 智能体直连」与空状态问题；
- **子组件标准化共用 (Shared UI Components)**：
  - 通用模型卡片与路由组件（`shared/admin/js/agent-models-ui.js`）在打包阶段内联并入 EdgeOne 单文件 Bundle，两端 100% 共享胶囊选择器、Key 探活、1+1 实机测速与模糊搜索逻辑；
- **历史硬编码清零与版本动态注入**：
  - 彻底清除 `core.js` 与 `admin.js` 中的旧版本常量（`APP_VERSION = 'v2026.10.17-02'`），对齐 `IS_EDGEONE` 宿主环境判断逻辑；
  - `build-admin.mjs` 统一从 `version.json` 读取权威版本号动态注入至顶部 `#topVersionBadge` 与运行时常量；
- **发版门禁强制焊死（物理级不可绕过）**：
  - 将 `tests/test_phase3_phase4_audit.py` 强制并入 `package.json` 的 `build:admin` 与 `test` 命令；
  - 增加 EdgeOne 专属控制台与产物防污染强断言（断言必须包含“OCRProxy EdgeOne 控制台”、“EdgeOne 边缘版”、“已纳管供应商”，严禁包含 VM 专注文案），违规立即退出中断发版。

---

## [v2026.10.18-08] - 2026-10-18

### EdgeOne 官方规范对齐
- **E1: `edgeone.json` 官方规范化与路径匹配合规化**：
  - 清除所有非官方标准字段（`build`、`functions`、`routes`、`kv`、`env`），全面合规声明 `cloudFunctions.python.maxDuration: 120` 与 `mainlandRegions: ["ap-guangzhou"]`；
  - 彻底移除 `headers.source` 中的正则写法，采用官方支持的单通配符（`/v1/*`、`/api/*`、`/admin`、`/admin/*`、`/*.html`），确保 CDN 边缘层 `Cache-Control: no-store` 与 `X-Accel-Buffering: no` 真实生效；
  - KV 命名空间绑定与环境变量配置指引完整收敛至控制台操作手册与 README 说明；
- **E2: 出站请求防重定向降级 (`redirect: 'manual'`)**：
  - 代理转发与关键探测链路（`completions`、`messages`、`verify-key`、`probe-models`、`config`、`test`）出站 fetch 统一显式设置 `redirect: 'manual'`；
  - 杜绝 WHATWG 默认跟随重定向导致 POST 请求体丢失并被静默降级为空 GET；遭遇 3xx 时即刻诊断为 Base URL 配置错误并返回 HTTP 502 明确指引，严格阻断 failover 与误冷却；
- **E3: 超时设置全链路官方闭环**：
  - 依据官方 Fetch 81897 文档，在 `probe-models.js` 与 `presets/hub.js` 出站请求中显式注入 `eo.timeoutSetting`，防止未配置时被 EdgeOne 平台 15 秒默认截断；
  - `cloud-functions/v1.py` 兜底超时提升至 120 秒，对齐云函数规格上限；
- **E4: Fetch 并发与次数硬限制治理**：
  - 针对 EdgeOne 单次运行 64 次 fetch 与最多 8 并发限制，在 `api/test.js` 中实现并发度为 6 的 Worker Pool 调度器；
  - 单次批量探测入参严格截断至最多 60 个候选；单次探测耗时改为在 fetch 真正发出瞬间打点，剔除排队等待延迟；
- **官方运行时与超时架构规范确立**：
  - 新建 `docs/EDGEONE_RUNTIME_SPEC.md`，彻底清除所有历史遗留的“25 秒断开限制”过时记忆与误导文案，明确出站 fetch 原生支持最长 300 秒等待，20 秒保活心跳的唯一职责是保障下游客户端、移动网络 NAT 与反代 TCP 连接的活跃。

---

## [v2026.10.18-07] - 2026-10-18

- **EdgeOne SSE 带内错误精准侦测与保活行规避**：重构流式带内错误解析器，严格支持标准 OpenAI SSE 格式 (`data: {"error": ...}`)，自动跳过 EdgeOne 20 秒保活心跳注释行（`: ping`），彻底解决流式首包 429/500 带内错误穿透或解析失败的问题；
- **400 故障精确短语匹配与 Key 误封根除**：收敛 400 错误码的 Key 级冻结词表为完整精确短语（如 `invalid api key`、`no active subscription`），杜绝因请求体携带 `plan`、`insufficient` 等常规参数校验错误导致正常 Key 被误封 30 分钟；
- **403 地区与模型级权限解耦**：精准识别 `region`、`location`、`permission to access model` 等地区与模型级权限限制错误，将其严格隔离为模型级候选冷却，不再连带冻结整个 Key 名下的其他可用模型；
- **RPM 调度细节彻底闭环与中枢同步增强**：调度器懒加载提供商完整补全 `rpm_per_key` 约束，彻底废弃已失效的 `keys[*].rpm`；中枢管理端清空 RPM 时显式保存 `rpm_per_key: 0`，后端原子更新并重置本地滑动窗口；
- **预算运行时残留彻底清除 (方案 A 契约加固)**：彻底清除 `proxy_routes.py` 中 5 处 `schedule_total_budget` 覆盖与 `_scale_budget` 历史遗留，统一由调度器按候选剩余预算自主分配；VM 端保持强 HTTP 契约，首包前不提前发送 200，确保 429/502 能正常触发客户端重试；
- **Agent 429 短冷却保护与全冷却等待时间完善**：针对上游未提供 `Retry-After` 头的 429 响应，赋予 10 秒默认保守退避冷却；当全部候选均处于冷却时，候选等待时间完整纳入 `_key_cooldown_until`，杜绝未等待即重入导致的死循环或连续 429；
- **Sticky 会话切 Key 条件精准约束**：严格限制 `sticky_failover` 顺延指针的触发时机，仅在 429、401/403 认证错误及配额耗尽等关键凭据故障时顺延指针，普通可重试网络抖动优先就地重试，杜绝偶发波动误切主力 Key；
- **EdgeOne 平台性能与准入加固**：采用 `TextEncoder().encode(bodyText).byteLength` 计算真实 UTF-8 字节数，严密拦截超限请求；采用 `structuredClone` 消除循环内 JSON 序列化性能开销；`messages.js` 默认最大重试次数对齐为 3；边缘 KV 冷却写入接入 `safeWaitUntil`；
- **管理控制台复合键高亮兼容**：`agent-models-ui.js` 的 `isActive` 判定全面兼容原生 Key 标识与 `provider:key` 复合键格式，确保正在调度生效的主力 Key 标签在界面上精准点亮高亮。

---

## [v2026.10.18-06] - 2026-10-18

- **前端单一真理源 (Single Source of Truth) 重构彻底落地**：前端源代码（HTML、CSS、JS）统一收敛至 `shared/admin/`，彻底废除 `agent-edgeone/admin.*` 多重冗余副本维护，彻底根除多端代码漂移与重复修复的历史隐患；引入规范化编译构建管线 `npm run build:admin`；
- **配置声明化与 Host 宿主适配器架构**：引入 `shared/config/settings.schema.json` 与 `host.js`，通过 `settings-form.js` 实现设置面板的声明式动态渲染，前端功能与 VM / EdgeOne 差异化参数彻底解耦；统一重试与超时模型参数命名，全端支持 `max_retries` 与 `request_total_budget_sec`；
- **后端调度器预算解耦与多候选防饿死保障**：重构端点调用预算模型，将整体请求总超时与单次候选超时彻底解耦，针对 OCR 等长耗时任务，首选候选超时（如 60s）失败后自动为备选候选 2 保留充裕时间继续尝试，彻底杜绝单次超时饿死备选候选的问题；
- **三级精准故障冷却体系与 Key 级熔断**：引入 `_key_cooldown_until` 三级冷却机制，将 401（未授权）、403（凭据禁用）、余额欠费、模型配额耗尽等错误精准锁定在具体 Key 级别，杜绝单个 Key 故障导致全提供商被误熔断；EdgeOne 端无缝接入 `classifyFailure` 与 `isKeyLevelFailure`；
- **Sticky 会话复合键一致性与智能顺延避让**：将绑定状态升级为 `provider:key` 复合键，杜绝跨提供商同名 Key 导致的调度漂移；当遭遇 429 或节点故障时，自动顺延避让至下一个健康候选并持久锁定；
- **400 跨厂商参数容错与配额短语防误杀**：多厂商候选下遇 HTTP 400 自动尝试 failover 至备选厂商；严格收敛 Quota 耗尽短语匹配；
- **RPM 滑动窗口安全退避与中枢规则完整保留**：遭遇上游 429 实施 $\ge 15$ 秒保守退避；中枢同步时完整合并保留 `rpm_per_key`、`adapter_rules` 与 `protocols` 等高级字段；
- **向量与重排响应零拷贝 (Zero-Copy Pass-Through)**：`/v1/embeddings` 与 `/v1/rerank` 接口采用字节流零拷贝直通，消除海量浮点数组解析对 Python 堆内存的严重碎片化污染与 GC 停顿；
- **EdgeOne 平台硬限制安全防护与带内错误侦测**：入口强置 900KB 请求体安全准入拦截；流式首包极速侦测带内 JSON 错误，遇错秒级切 Key。

---

## [v2026.10.18-05] - 2026-10-18

- **RPM 速率限制统一收敛至供应商级别**：统一在供应商级别配置每分钟请求上限 (`rpm_per_key`)，作为该提供商名下所有 Key 的统一约束源；
- **移除过时预设推荐模型与选用体验优化**：供应商弹窗彻底删除静态过时的官方预设推荐模型列表，统一改由「模型及路由」面板实时探测上游可用模型一键选用。

---

## [v2026.10.18-04] - 2026-10-18

- **Web 控制台 URL 免密直连 (`?token=` / `?key=`)**：访问后台 URL 支持在尾部附加 `?token=<ADMIN_PASSWORD>`，直接完成自动鉴权；
- **地址栏防泄漏无刷新秒级擦除**：鉴权成功后立即通过 HTML5 `history.replaceState` 自动清除 URL 中的敏感凭据参数，地址栏秒级还原为纯净的 `/admin`；
- **后端全链路与 EdgeOne 同构兼容**：`vm-app` 与 EdgeOne 鉴权底层同步支持从 Query 参数中兜底提取凭据，双端体验 100% 统一。

---

## [v2026.10.16-02] - 2026-10-16

- **网关级传输错误规范化与自动重试头 (PR #9)**：将底层网络传输异常映射为 HTTP 502 / 504，并自动注入响应头 `x-should-retry: true` 与 `Retry-After: 1`；
- **智能体粘性同 Key 级数退避重试 (Sticky Same-Key Backoff Retry)**：在 `sticky_failover` 模式下，遭遇网关瞬态错误时先在原 Key 执行 1s、2s 级数退避重试；
- **Agent 路由策略全面收敛精简**：管理后台与调度器将 Agent 路由策略全面精简为 `sticky_failover` 与 `manual` 两大模式。

---

## [v2026.10.16-01] - 2026-10-16

- **解耦 Agent 首字节超时与 KB 超时**：新增 `agent_first_byte_timeout_sec`（默认 120s），彻底废除按模型名猜测思考超时的硬编码逻辑；解耦 KB 入库短超时（`upstream_timeout_sec` 15s）与 Agent 推理长超时；
- **失效连接 5.0s 探测自愈窗口**：将 `_STALE_RETRY_WINDOW_SEC` 放宽至 5.0s，完美适配跨国链路 TCP RST 与 Cloudflare 偶发静默关闭时的自动重连；
- **出站请求标准化**：HTTP 客户端默认注入 `User-Agent: OCRProxy/{version}`，流式请求默认注入 `Accept: text/event-stream`；
- **模型跨 Key 防重复绑定校验**：控制台新增或编辑模型时，智能检测同一提供商下是否已存在同名上游模型绑定，杜绝重复创建脏节点。

---

## [v2026.10.13-01] - 2026-10-13

- **MiniMax 预设升级至 v1.4.0**：新增声明式 `effort_map`；引入双协议自适应思考规则，完美兼容 Anthropic (`/v1/messages`) 与 OpenAI 思考参数。

---

## [v2026.10.12-02] - 2026-10-12

- **上游 410 模型下线识别**：上游返回 HTTP 410 Gone 时，标记 `provider:model` 为永久下线（默认 24 小时），同一厂商下所有 Key 一并跳过；
- **重载不复活**：下线标记在 `/v1/reload` 和配置热重载后保留；
- **全部下线直接 410**：某模型全部候选下线时直接返回 410，替代原先误导性的 503；
- **EdgeOne 对称对齐**：同步写入 24 小时 KV 冷却。

---

## [v2026.10.12-01] - 2026-10-12

- **上游非 JSON / HTML 报错智能清洗**：解决上游服务商在 413/502/504 时返回原始 HTML 导致客户端反序列化崩溃的问题；
- **413 Payload 超限快速熔断**：不可通过换 Key 恢复的错误直接快速熔断返回客户端；
- **调度报错结构化净化**：清洗后错误写入 `stats.error_logs`；EdgeOne 对称对齐。

---

## [v2026.10.11-06] - 2026-10-11

- **EdgeOne 客户端凭据与管理员密码物理隔离**：首页接入网关重构为独立 `getClientKey()`，从环境变量注入 `PROXY_API_KEY`；
- **紧急修复登录界面函数丢失致命 Bug**：补回 `function loginErr(m)`，解决 DOM ID 与 window 命名冲突；
- **全流程三重机械化发版门禁**：符号契约扫描、DOM 冒烟门禁、构建与测试强阻断；
- **日志与中间件性能深度优化**：纯 ASGI 中间件重构，延迟降至 2.4ms；KB 错误折叠，滑动窗口聚合。

---

## [v2026.10.11-05] - 2026-10-11

- **根除探活假阳性放行 Bug**：严格限定仅 HTTP 2xx 为通过；
- **前端加载容错安全边界**：包裹异常安全边界，登录遮罩新增一键清除缓存重试；
- **孤立绑定自动清理**：删除供应商凭据时自动修剪孤立关联。

---

## [v2026.10.11-04] - 2026-10-11

- **控制台设置面板 DOM 闭合与卡片规范对齐**：修复 Card 4 闭合标签缺失导致的层级塌陷；
- **各设置卡片独立容器层级恢复**：恢复 Card 1~Card 6 同级独立规范；
- **自动化 HTML 标签平衡语法门禁**：新增标签平衡自动化检测。

---

## [v2026.10.11-03] - 2026-10-11

- **PR #7 合并 (OCR 上游请求体异步流式零拷贝)**：`_ReplayableBody` 切片流式发送机制；
- **入站 JSON 字节直读优化**：直接反序列化，跳过冗余转换；
- **管理端 OCR 准入参数可视化**：配置同时处理数与排队超时；
- **模式自适应隔离**：仅在 KB 模式展示 OCR 控件。

---

## [v2026.10.11-02] - 2026-10-11

- **PR #6 合并 (httpx 响应流环状引用彻底解除)**：`release_httpx_response(resp)` 解构流绑定；
- **大图 OCR 解析并发准入控制**：信号量限流并缓冲在网络层；
- **固定 glibc mmap 阈值为 128KB**：分配大内存页直接归还内核，杜绝碎片；
- **OCR 响应零拷贝直接透传**；
- **全面废除定时重启功能**：内存已物理根治，长久稳定运行。

---

## [v2026.10.11-01] - 2026-10-11

- **定时平滑重启时间自定义配置**；
- **按需轻量调度 (零常驻开销)**；
- **智能优雅平滑退避重启**：等待长连接生成完毕再释放；
- **Systemd 联动秒级拉起自愈**。

---

## [v2026.10.10-01] - 2026-10-10

- **调度器首包真内容判定 (First-Payload Detection)**：缓冲前导帧直至真实有效负载，透明 failover 假 200；
- **空回复与断流自动切换**；
- **Agent 阶梯冷却与同网关熔断**；
- **免费提供商生态扩充**：OpenRouter (`:free`)、NVIDIA NIM v2.0.0、OpenCode Zen v2.0.0；
- **链路诊断追踪标头**：`X-Fallback-Trail` 与 `Retry-After`。

---

## [v2026.10.09-14] - 2026-10-09

- **Gemini 思考签名与工具调用支持**：`thought_signature` 无状态透传，解决多轮工具调用 400 崩溃；
- **Vertex AI 思考标签流式分离**：抽取 `<thought>` 至 `reasoning_content`；
- **官方预设规则对齐**：MiniMax、商汤、Google 推荐模型；
- **厂商隔离与零拷贝保护**。

---

## [v2026.10.09-13] - 2026-10-09

- **修复 systemd-run 非法参数**：引入 `--collect` 机制；
- **交互式终端直连优化**：实时回显下载与部署进度；
- **国内极速下载链路重构**：轮询国内高速镜像源；
- **后台 OTA 升级指令增强**。

---

## [v2026.10.09-12] - 2026-10-09

- **客户端 Key 占位符根治**：`PROXY_API_KEY` 环境变量自动兜底；
- **KB 模式 Key 胶囊交互解耦**：解耦 Candidate 弹窗与 Agent 弹窗内部闭包状态；
- **操作按钮精简与全局去重**：收敛「同步中枢规则」入口，移除标题栏重复按钮。
