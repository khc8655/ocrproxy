# CLAUDE.md — OCRProxy 代理入口与文档优先级

> 本文件是 AI 代理的入口索引，不替代 `ARCHITECTURE_STANDARDS.md`；但下列优先级用于解决"文档互相矛盾、UI 参数不生效"的问题。

## 1. 冲突时的优先级（2026-10-23 事故后）

1. `shared/config/settings.schema.json` + 各运行时真实读取点 + `tests/test_settings_binding_contract.py`
2. `docs/ADMIN_UI_BACKEND_CONTRACT.md`、`docs/SYSTEM_DESIGN_SPEC.md` 的近期章节
3. `ARCHITECTURE_STANDARDS.md` 的历史原则（可能滞后）
4. 其它 README / 记忆文件

**文档与可执行契约冲突时，以可执行契约和测试为准，并当场更新文档；禁止按旧文档继续开发。**

## 2. 前端只有一个源码

- 所有管理端 HTML/CSS/JS 只在 `shared/admin/` 修改；
- `vm-app/static/`、`agent-edgeone/admin.html`、`edge-functions/admin.js` 是构建产物，禁止手改；
- EdgeOne 的 Vault Hub（供应商与 Key Tab）任何模式下不得隐藏；
- `data-cap` 只能引用 `HOST.capabilities` 里真实存在的键；`data-arch` 只能是 `vm`/`edgeone`。

## 3. 设置项生效契约（强制）

新增/修改任何设置，必须同时完成：

1. `settings.schema.json` 增加 canonical key，声明 `hosts`、`modes`、`strategies`、默认值；
2. `shared/admin/admin.html` 增加/修改控件，显隐用 schema 的 mode/strategy，不得发明 `data-cap`；
3. `shared/admin/js/settings.js` 保存时写入**同名 canonical key**；
4. VM / EdgeOne 运行时读取**同一个 key**；
5. 更新 `tests/test_settings_binding_contract.py` 与相关行为测试；
6. 文档同批更新。

已删除且禁止复活：`request_total_budget_sec`、`max_retries`、`max_attempts_per_provider`（2026-10-23, v20261023-03）。

## 4. 超时模型（v20261023-03 起）

- 硬总超时固定 **300s**（EdgeOne 平台架构上限 / VM 安全上限），不是设置项；
- 粘性 `manual`：固定当前 Key，不轮换；VM 纯中转，EdgeOne 300s 到点返回超时；
- 自动轮换：按候选 Key 逐个尝试，成功 / 试完所有 Key / 300s 先到先停；
- KB：全部 429/冷却 → `429 + Retry-After`，客户端自行重试，服务端不排队等待；
- 设置页按 host/mode 只显示真实生效的参数。

## 5. 外部官方文档与日志归属

- 所有 EdgeOne / 厂商官方文档链接统一登记在 [`docs/EXTERNAL_REFERENCES.md`](docs/EXTERNAL_REFERENCES.md)，禁止散落在聊天或临时笔记里；收到新链接先更新该表，再同步相关 spec。
- EdgeOne 日志统一在腾讯云 Makers 控制台「日志分析」查看，**不在 OCRProxy 管理 UI**；EdgeOne 控制台不得新增错误日志页。VM 的 `stats.error_logs` 仅属于 VM。
- 官方平台行为与项目文档冲突时，以官方文档 + 可执行契约（schema/runtime/tests）为准，并同步更新文档。

## 6. 发布前

```bash
npm run build:admin
PYTHON=.venv/bin/python npm run test:full
```

G1~G6 全绿、`tests/test_settings_binding_contract.py` 通过后方可发版；文档与 CHANGELOG 同批更新。
