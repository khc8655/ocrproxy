# KHC Admin Design System

KHC Admin 是面向 MCP 知识库系统的管理控制台设计系统。该系统为数据密集型仪表盘场景而构建，强调紧凑密度、冷蓝色调与零装饰渐变的工程化美学。色彩主调为 `#1664FF`——一种技术感的冷蓝，不偏向暖色，不使用默认渐变。

## What this design system covers

- **Foundations** — 色彩（主色 `#1664FF`、10 级 primary scale、中性色 50–900）、字体（PingFang SC / SF Mono）、间距（4px 基数 8 档）、圆角（2 / 4 / 8 / 12px）、阴影（5 层极简）、语义色四系
- **Components** — 6 个核心组件：Badge、Button、Card、Navigation、Sidebar、Table
- **Sample kit** — dashboard 型 UI Kit，涵盖知识库管理、任务中心、模板管理等场景的交互预览

---

## CONTENT FUNDAMENTALS

### Voice & tone

KHC Admin 的语言风格是工程化、精准、无装饰的中文。文案以动宾结构为主——"保存配置""应用配置""上传模板文件"——直接指向操作意图，不使用感叹号、emoji 或营销话术。状态标签采用两字至四字的简洁形态，与 Badge 组件的语义色一一映射。导航项使用名词短语（"概览""基础配置""文档库""模板管理""入库""任务中心""维护工具"），保持一致的抽象层级。整体语气是中性的、面向专业运维人员的技术文档调性。

### Concrete copy examples

- 导航项：*"概览"*、*"基础配置"*、*"文档库"*、*"模板管理"*、*"入库"*、*"任务中心"*、*"维护工具"*
- 表单操作：*"保存配置"*、*"应用配置"*、*"从存储桶选择"*、*"上传模板文件"*
- 任务操作：*"解析"*、*"全量重入库"*
- 状态标签：*"运行中"*、*"已完成"*、*"排队中"*、*"失败"*、*"已取消"*
- 数据维度：*"库况"*、*"最近任务"*、*"文档"*、*"卡片"*、*"产品型号"*、*"生成素材"*

### When generating copy

- 操作按钮使用动宾结构，控制在 2–6 个汉字（"保存配置""全量重入库"），避免冗长修饰
- 状态标签固定使用 2–4 字格式——进行态末尾加"中"（"运行中""排队中"），完成态不加（"已完成""失败""已取消"）
- 导航项使用名词短语，保持同级菜单的抽象层级一致，不混用动词与名词
- 禁止感叹号、emoji、感叹词——语气保持中性技术文档调性

---

## VISUAL FOUNDATIONS

### Color

KHC Admin 的色彩系统以 `#1664FF` 为品牌主色（primary-500），这是一种饱和度较高但不刺眼的冷蓝色，带有技术工具感。Primary scale 从 `#E6EEFF`（primary-50，极淡的蓝白底色，用于 active 态背景与 badge 底色）到 `#06205C`（primary-900，深蓝黑），共 10 级。最常用的操作色集中在 primary-500 与 primary-600（`#0F54E0`）之间——按钮主色用 500，导航 logo 渐变用 500→700（`#0B43B8`）。

中性色是一套从 `#F8FAFC`（neutral-50，页面底色）到 `#0F172A`（neutral-900，主文字色）的 10 级灰阶。日常工作中最频繁使用的几档是：neutral-50 作为页面画布（`--khc-surface-page`），neutral-200（`#E2E8F0`）作为卡片与表格的默认描边（`--khc-border-1`），neutral-400（`#94A3B8`）作为辅助文字（`--khc-text-3`），neutral-600（`#475569`）作为正文文字（`--khc-text-2`）。白色 `#FFFFFF` 是卡片的标准表面色。

语义色各有一条独立的 10 级 scale：Success 为 `#10B981`（翠绿系），Warning 为 `#F59E0B`（琥珀系），Danger 为 `#EF4444`（红系），Info 为 `#06B6D4`（青系）。这些语义色在 Badge 中以 50 级底色 + 500 级文字色的方式使用——例如"已完成"badge 用 success-50 底 + success-500 文字，"失败"badge 用 danger-50 底 + danger-500 文字，使得状态指示器色彩柔和但语义清晰。

整体色彩氛围是冷调、克制、工程化的。蓝色作为唯一的品牌色承担所有交互入口，中性灰承担信息架构，语义色仅出现在状态指示场景。没有装饰渐变——唯一的渐变出现在顶部导航的 logo 方块上（`linear-gradient(135deg, primary-500, primary-700)`），这是一个克制的品牌签名。

### Typography

主字体为 **PingFang SC**，搭配 `-apple-system`、`BlinkMacSystemFont`、`Segoe UI`、`Roboto` 作为跨平台回退。这是一个为中文优化的无衬线字体，在 macOS 上原生呈现，在 Windows 上回退至 Segoe UI。等宽字体为 **SF Mono**，回退至 `Roboto Mono` 和 `Consolas`，用于代码与数据展示场景。

字阶从 display 到 caption 共 6 档加 1 档等宽：display 32px / line-height 1.2 / weight 600，h1 24px / 1.3 / 600，h2 20px / 1.4 / 600，h3 16px / 1.5 / 500，body 14px / 1.5 / 400，caption 12px / 1.5 / 400，mono 13px / 1.6 / 400。标题级（display、h1、h2）使用 600 字重，h3 降至 500，正文与说明文字使用 400。行高策略是标题越紧、正文越松——display 行高 1.2，body 行高 1.5，mono 行高 1.6 以保证代码可读性。

### Spacing

间距基数为 4px，token 从 `--space-1`（4px）到 `--space-8`（64px），共 8 档：4 / 8 / 12 / 16 / 24 / 32 / 48 / 64px。组件尺寸以这套间距为基础——默认按钮高度 32px（`--size-button-sm`），标准输入框高度 40px（`--size-input`），大按钮 48px（`--size-button-lg`）。图标尺寸分为 16px / 20px / 24px 三档。卡片内边距为 20px 24px，统计卡片更紧凑为 16px 18px。整体密度偏紧凑——32px 的默认控件高度和 10–12px 的表格单元格内边距反映了 dashboard 场景对信息密度的要求。

### Radius

圆角体系刻意保持锐利，共 4 个值：

- **2px**（`--radius-sm`）— 按钮、输入框等交互控件。几乎不可见的圆角，强调精确感
- **4px**（`--radius-md`）— 卡片、统计卡片。比控件略大但仍保持几何感
- **8px**（`--radius-lg`）— 大型容器或面板
- **12px**（`--radius-xl`）— 最高层级容器

唯一的例外是 Badge 组件使用 10px 圆角（pill 形态），这是状态标签的专用形态——仅在 badge 场景使用 pill，不扩散到其他组件。

### Shadow / Elevation

阴影系统共 5 层，全部基于 `rgba(15,23,42, x)` 即 neutral-900 的透明度叠加：

1. **shadow-1（Card）：** `0 1px 2px rgba(15,23,42,.04)` — 卡片默认态，几乎不可见的极淡阴影
2. **shadow-2（Card Hover）：** `0 2px 4px rgba(15,23,42,.06)` — 卡片悬停态，微弱提升
3. **shadow-3（Float）：** `0 4px 8px rgba(15,23,42,.08)` — 浮动元素
4. **shadow-4（Modal）：** `0 8px 16px rgba(15,23,42,.10)` — 模态框
5. **shadow-5（Overlay）：** `0 12px 24px rgba(15,23,42,.12)` — 最高层级覆盖层

阴影哲学是"极简到几乎不存在"。卡片在静止态仅有 0.04 透明度的阴影，需要靠近才能感知。暗色模式下阴影加深（shadow-1 变为 `rgba(0,0,0,.30)`，shadow-2 变为 `rgba(0,0,0,.35)`），以补偿深色背景上的层次感缺失。

### Borders & Backgrounds

- 默认描边为 1px solid `--khc-border-1`（neutral-200 / `#E2E8F0`），用于卡片、表格行分隔、侧边栏右边界、顶栏下边界
- 次级描边 `--khc-border-2`（neutral-300 / `#CBD5E1`）用于需要更强分隔的场景
- 页面底色 `--khc-surface-page`（`#F8FAFC`），卡片底色 `--khc-surface-card`（`#FFFFFF`），悬停底色 `--khc-surface-hover`（neutral-100 / `#F1F5F9`）
- 表格表头使用页面底色作为背景，与卡片白色形成微弱对比
- 暗色模式：页面 `#0F172A`，卡片 `#1E293B`，悬停 `#334155`，描边 `#334155` / `#475569`

---

## Component Patterns

| Component | File | Key Insight |
|---|---|---|
| Button | `components/button.json` | 默认高度 32px、圆角 2px，通过 `filter: brightness()` 实现悬停/按下态而非换色 |
| Card | `components/card.json` | 标准 padding 20px 24px，统计卡片含 22px / 700 字重的数值展示 |
| Table | `components/table.json` | 表头用页面底色区分、13px 字号、行悬停背景切换 |
| Badge | `components/badge.json` | pill 形态（10px 圆角），50 级底色 + 500 级文字色的五态映射 |
| Navigation | `components/navigation.json` | 48px 高度 sticky 顶栏，logo 为 135° 渐变方块 |
| Sidebar | `components/sidebar.json` | 220px 宽度，active 项用 primary-50 底 + 2px 左边框 |

---

## Index

- `README.md` — 品牌叙事与设计系统总览（本文件）
- `SKILL.md` — AI Agent 技能入口文件
- `colors_and_type.css` — 色彩、字体、间距、圆角、阴影的 CSS 变量定义
- `css.json` — 结构化设计 token 的 JSON 格式
- `components.css` — 从 preview 页面自动提取的组件 CSS
- `preview/` — 6 个组件的 HTML 预览卡片（button / card / table / badge / navigation / sidebar）
- `components/` — 组件契约 JSON（index + button / card / table / badge / navigation / sidebar）

---

## Caveats / known substitutions

1. **PingFang SC** 为 macOS 原生字体，在 Windows / Linux 上不可用。回退链为 `-apple-system` → `BlinkMacSystemFont` → `Segoe UI` → `Roboto`。Windows 环境下实际渲染为 Segoe UI，字宽与笔画细节有差异，但不影响布局完整性。
2. **SF Mono** 同样为 Apple 平台字体。回退至 `Roboto Mono`（Android / Chrome OS）和 `Consolas`（Windows）。代码展示场景在非 macOS 设备上会呈现 Consolas 字形。
3. 所有色彩 token 标注为 `/* AI-generated */`，表示由设计系统生成器从品牌主色 `#1664FF` 推导而来，非从 Figma 原始设计稿直接提取。
4. 暗色模式仅覆盖了 surface、text、border 和 shadow-1 / shadow-2 变量——primary / semantic 色阶在暗色下未做单独调整，可能需要后续补充。
5. 侧边栏导航项的图标引用了 `data-lucide` 属性，实际渲染依赖 lucide 图标库。在离线环境中需替换为内联 SVG。
6. 组件 CSS 从 preview HTML 自动提取，部分组件 anatomy 注释被截断——完整 anatomy 参考各 `components/{slug}.json` 文件。
