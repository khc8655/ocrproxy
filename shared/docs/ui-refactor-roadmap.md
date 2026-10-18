# UI 审查复核报告与重构方案

> 本文档由审查报告复核与架构评估生成，记录针对 UI 分裂与配置歧义的现状核验与重构路径。

## 1. 现状核实结论

经过对当前代码库基线（commit `4402b1e`）的详细审查，报告指出的所有问题均确凿存在：

1. **P0-1 `schedule_total_budget` 语义冲突**：
   - `agent-edgeone/admin.js` 中将 `schedule_total_budget` 映射到重试次数（默认 3 次）；
   - `vm-app`（`proxy_routes.py`、`scheduler.py`）将 `schedule_total_budget` 视为浮点数秒（总请求超时预算）。
   - EO 导出的配置导入 VM 后，3 次重试被 VM 当成 3 秒预算，直接扼杀 failover 机制。
2. **P0-2 EO 前端预设镜像地址错误**：
   - `agent-edgeone/admin.js` 写死指向 `xsk/ocrprox`，导致 404；应统一调用后端预设代理。
3. **P0-3 VM 内全局函数声明相互遮蔽**：
   - `models.js` 覆盖 `agent-models-ui.js` 导出的 `runLiveTest` 与 `removeLocalKeyFromModal`；
   - `core.js`、`providers.js`、`models.js`、`vault.js` 中存在多个重复函数声明。
4. **P0-4 参数默认值与限制不一致**：
   - `max_attempts_per_provider`、`cooldown_429_sec` 在 EO 后端、VM 后端与两端 UI 中定义互不相同。
5. **P1/P2/P3 架构性缺陷**：
   - EdgeOne 与 VM 实际上存在两份前端 HTML/CSS/JS 实现，`shared/admin` 并未真正成为两端唯一源。
   - 模式差异缺乏统一 JSON Schema 驱动，直接散落在 UI 代码判断中。

## 2. 建议分阶段执行路径

- **阶段一 (P0)**：阻断性 Bug 与符号冲突消除（语义统一、镜像纠正、去除重名覆盖、对齐默认参数）。
- **阶段二 (P1)**：建立 `shared/config/settings.schema.json`，由 Schema 驱动 UI 表单和两端后端的配置解析与迁移。
- **阶段三 (P2)**：实现 `shared/admin/js/host.js` 宿主适配器，使 EdgeOne 构建直接基于 `shared/admin`，删除 `agent-edgeone/admin.*` 副本。
- **阶段四 (P3)**：清理前端兜底预设，统合通用 BindingEditor。
