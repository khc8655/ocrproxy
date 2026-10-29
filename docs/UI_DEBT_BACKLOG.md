# 控制台 UI 旧账清单（后续 UI 调整时统一清理）

> 基线：v20261029-01（2026-10-29）  
> 来源：PR #28（控制台样式/结构迁移）+ PR #29（结构破损修复与 HTML 守卫）合并后的状态。  
> 原则：本清单只记录**视图层/维护性旧账**；不改变调度、API、配置、HOST 能力位与 DOM 契约。

## 已完成的统一项

- `admin.html` 结构破损、重复 `class`、空属性、未闭合标签：已修复。
- `admin.html` 内联 `style`：已归零，由 `tests/test_html_structure.py` 守卫。
- 语义类（`btn--*`、`badge--*`、`page-header`、`card`、`field` 等）已用于新壳层/页头/设置页。
- 设置页已拆分为 Vault Hub / 系统版本与运维 / 底层配置三张卡。
- `build:assets` 已接入 HTML 结构守卫。

## 剩余旧账（按优先级）

### P1：JS 模板内联样式

当前快照（v20261029-01）：

- `shared/admin/admin.html`：`style="` **0** 处；
- `shared/admin/js/*.js`：`style="` 约 **223** 处；
- `shared/admin/js/*.js`：`.style.xxx =` 约 **71** 处；
- 旧按钮/徽章类名仍有约 **59** 处（`btn-secondary`、`btn-primary`、`btn-ghost`、`badge-success` 等）。

目标：

- 能由语义 class 表达的样式，全部移入 `admin.css`；
- 数据驱动的宽度/百分比可保留 `style="--w:NN%"`，由 CSS 消费；
- 显隐优先用 `hidden` / `.is-hidden`，减少 `.style.display` 赋值；
- 已迁移的旧类名进入 legacy 映射，确认无引用后删除。

注意：

- `UI.dialog` / `UI.confirm` / `UI.alert` / OAuth 登录弹窗已是统一实现，不要在清理中改回原生 `alert/confirm`。
- 供应商字母导航、文件导入 input、Raw JSON 区块已有回归守卫，迁移时不得回退。

### P2：测试棘轮补全

- 现有 `tests/test_html_structure.py` 只审计 `admin.html`；
- 后续应把 JS 模板中的内联样式/旧类名纳入棘轮统计；
- 基线只允许下降，修复期单独 PR 上调阈值需在 PR 标题注明理由。

### P3：体积预算

当前实测：

```text
EdgeOne admin.bundled.html
349,068 bytes raw / 86,737 bytes gzip
```

旧预算：340 KB raw / 85 KB gzip；本次临时接受略超。

后续二选一：

1. 接受新预算 **350 KB raw / 88 KB gzip**，写入规范；
2. 先做 CSS/旧类去重与 JS 模板瘦身，再收紧回 340/85。

不要在功能 PR 里无说明地继续放大体积。

## 执行方式

- 只在下一次明确的 UI 迭代中集中处理，避免和功能修复混在一个 PR；
- 建议按「JS 内联样式 → 旧类名 → 棘轮 → 体积」顺序；
- 每步单独 PR，保持控制台可独立发版；
- 必跑：`npm run build:admin`、`npm run test:full`、VM/EdgeOne 双宿主页面检查、360px 无横向滚动；
- 发版前确认 G1~G6 与 `tests/test_settings_binding_contract.py` 仍通过。

## 关联记录

- PR #28：控制台样式与结构迁移；
- PR #29：HTML 结构破损修复 + 结构守卫；
- 规范草案（仅分支）：`docs/UI_STANDARD_MIGRATION.md`（PR #27）。
