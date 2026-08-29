# OCRProxy 管理界面设计审计

> 基于 `khc-admin` Design Library 的约束检查。

## 核心结论

两个项目的管理界面在色彩、字体、布局骨架上已接近 `khc-admin` 规范，但**文案语气、emoji 使用、以及部分 token 细节**严重偏离，导致整体显得不专业、花哨。最大扣分项是 emoji 和营销式长文案。

## 问题清单

### 1. Emoji 泛滥（严重）

`khc-admin` 规范明确要求：**禁止 emoji、感叹号、感叹词**。

两个项目几乎在所有可见文本里都加了 emoji：

- 登录框：`🚀 OCRProxy`
- 导航：`📊 概览`、`🤖 Agent 模型`、`🏢 供应商与 Key`
- 标题：`⚡ 边缘中转状态总览`、`🌐 当前边缘节点出口 IP`
- 按钮：`🔍 重新探测`、`🗑 清空`、`💾 保存`
- 状态/Toast：`✅ 成功`、`❌ 失败`、`⚠️ 异常`
- JS 动态生成内容：`🤖 Agent`、`📚 KB`、`🏆 热门模型 Top 3`

**整改**：全部移除，改用纯文字 + khc badge / 图标按钮。

### 2. 文案冗长、营销腔（严重）

规范要求：**工程化、精准、无装饰的中文；动宾结构 2–6 字；状态标签 2–4 字**。

反面示例：

- "EdgeOne Makers 边缘大模型中转控制台" → "OCRProxy EdgeOne 控制台"
- "实时探测当前处理请求的 EdgeOne 边缘 CDN 节点及其实际出网公网 IP（防止单 IP 429 限流）" → "边缘节点出口 IP"
- "⚡ KV 冷却状态与失败计数表" → "Key 冷却状态"
- "🔍 重新探测节点 IP" → "探测 IP"
- "🗑 清空全部冷却状态" → "清空冷却"
- "配置已成功写入 EdgeOne KV 并向全网广播生效" → "配置已保存"

**整改**：精简为规范语气，删除修饰性定语和括号说明。

### 3. Token 偏差（中等）

| Token | khc-admin 规范 | edgeone/admin.css | vm-app/static/admin.html |
|---|---|---|---|
| `--radius-sm` | 2px | 4px | 4px |
| `--radius-md` | 4px | 6px | 8px（--radius） |
| `--radius-lg` | 8px | 8px | 12px |
| `--radius-xl` | 12px | 12px | - |
| body 字号 | 14px | 13px | 13px |
| h1/h2/h3 | 24/20/16px | 22/18/15px | -/15/- |
| 顶栏高度 | 48px | 52px | 52px |
| 表格 td/th padding | 10px 12px | 10px 14px | 10px 14px |
| 按钮高度 | 32px | 32px | 32px |
| 输入框高度 | 40px | 34px | 34px |

**整改**：对齐 khc-admin token；卡片、按钮、输入框统一圆角。

### 4. 组件形态不一致（中等）

- **Badge**：规范使用 pill 形态（10px 圆角）和 `b-done/b-running/b-queued/b-failed/b-canceled` 语义类。项目使用 `badge-success/badge-primary` 等，部分 badge 还嵌 emoji。
- **Button hover**：规范推荐 `filter: brightness()`，项目使用背景色变。
- **Table**：规范使用 `.tbl` 类、表头用页面底色、无 zebra。项目直接用 `<table>`，padding 偏大。
- **Card hover**：edgeone 给卡片加了 hover 边框加深，规范卡片默认即足够，hover 只需极淡阴影。

### 5. 两个项目各自为政（轻微）

- edgeone 使用外置 `admin.css` + `admin.js`。
- vm-app 使用单文件内联样式 + 脚本。
- 两者颜色别名、类名不统一，维护成本高。

## 整改优先级

1. **P0**：移除所有 emoji；精简所有文案到工程语气。
2. **P1**：修正 radius、字号、顶栏高度等 token。
3. **P2**：统一 badge 类名、表格 padding、按钮 hover 效果。
4. **P3**：两个项目样式收敛到同一套 khc-admin token。
