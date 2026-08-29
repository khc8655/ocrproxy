# KHC Admin — Agent Implementation Rules

> 快速规则书：在实现任何 KHC Admin 界面之前先通读本文。违反以下任何一条都属于设计系统偏离。

## 1. 绝对禁止

- **禁止 emoji**：按钮、标题、标签、状态、Toast、空状态、表格、导航中均不得出现 emoji。
- **禁止感叹号、感叹词、营销话术**："太棒了！""立即体验""优异""全新""极致"等一律删除。
- **禁止装饰性渐变**：除顶部 logo 方块外，不使用任何渐变背景/文字/边框。
- **禁止私自发明 token**：所有颜色、字号、间距、圆角、阴影必须从 `colors_and_type.css` 取。
- **禁止 pills 滥用**：只有 Badge 状态标签使用 10px 圆角 pill，其他组件一律按 2/4/8/12 圆角体系。

## 2. Token 速查表

| Token | 值 | 用途 | 常见错误 |
|---|---|---|---|
| body 字号 | 14px | 全局正文 | 错用 13px |
| h1 / h2 / h3 | 24px / 20px / 16px | 页面/区块/小标题 | 错用 22/18/15 |
| `--radius-sm` | 2px | 按钮、输入框 | 错用 4px |
| `--radius-md` | 4px | 卡片、统计卡片 | 错用 6px/8px |
| `--radius-lg` | 8px | 大容器 | 错用 12px |
| `--radius-xl` | 12px | 最高层级容器 | 错用 16px+ |
| appbar 高度 | 48px | 顶部导航 | 错用 52px/56px |
| button 高度 | 32px | 默认按钮 | 错用 36px/40px |
| input 高度 | 40px | 表单输入框 | 错用 34px |
| table padding | 10px 12px | 表格单元格 | 错用 14px+ |
| card padding | 20px 24px | 内容卡片 | 错用 16px/32px |

## 3. 文案规则

### 3.1 按钮
- 动宾结构，2–6 个汉字。
- Good: `保存配置` `探活` `清空冷却` `删除` `应用`
- Bad: `[emoji] 保存并应用设置` `[emoji] 重新探测节点 IP`

### 3.2 导航项
- 名词短语，同级抽象层级一致。
- Good: `概览` `配置` `密钥` `日志` `模型`
- Bad: `[emoji] 供应商与 Key` `[emoji] Agent 模型`

### 3.3 状态标签 / Badge
- 2–4 字，进行态末尾加"中"，完成态不加。
- Good: `运行中` `排队中` `已完成` `失败` `已取消`
- Bad: `[对勾] 成功` `[叉号] 失败啦` `[感叹] 出现异常`

### 3.4 标题与说明
- 标题用简洁名词短语；说明文字只陈述事实，不解释价值。
- Good: `状态总览` `出口 IP` `Key 冷却状态`
- Bad: `[装饰] 边缘中转状态总览` `实时探测当前处理请求的 EdgeOne 边缘 CDN 节点及其实际出网公网 IP（防止单 IP 429 限流）`

### 3.5 Toast / 反馈
- 陈述事实，不带 emoji/前缀图标。
- Good: `配置已保存` `连接成功 (120ms)` `删除失败，请重试`
- Bad: `[对勾] 配置已成功写入 KV 并向全网广播生效` `[叉号] 探活失败`

## 4. 组件纪律

- **Button**：32px 高，2px 圆角，`filter: brightness()` 实现 hover，不要加装饰图标。
- **Card**：4px 圆角，1px 边框，shadow-1，hover 只升到 shadow-2，不要改边框色。
- **Table**：表头用页面底色，无斑马纹，行间仅底部边框，padding 10px 12px。
- **Badge**：唯一 pill，50 级底色 + 500 级文字，五种语义态（done/running/queued/failed/canceled）。
- **Navigation**：48px 高 sticky，文案纯文字，无 emoji。

## 5. 交付前自检清单

在提交任何 KHC Admin 界面代码前，确认：

- [ ] 全文件搜索无 emoji 残留
- [ ] 所有可见文案无感叹号、营销词、多余修饰
- [ ] 圆角只使用 2/4/8/12/10(badge-only)，未发明其他值
- [ ] 字号严格使用 display/h1/h2/h3/body/caption/mono 阶
- [ ] 颜色、间距、阴影均来自 `colors_and_type.css`
- [ ] 组件样式与 `components.css` 及 `components/{slug}.json` 一致
- [ ] 按钮文案 ≤6 字，状态标签 ≤4 字，导航项为名词
