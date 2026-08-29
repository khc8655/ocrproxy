# KHC Web Design System

一套面向 B 端 Web 应用的轻量设计规范，基于简约科技风格。适用于 Dashboard、管理后台、配置页、数据展示等 Web 界面。

---

## 两层使用方式

本规范拆成两个层级，按需引入，避免轻量页面负担过重。

### 核心层（Core）— 推荐默认使用

覆盖 90% 的配置页、表单页、简单数据页：

```html
<link rel="stylesheet" href="design-system/colors_and_type.css">
<link rel="stylesheet" href="design-system/core.css">
```

包含：
- Reset + 基础排版
- 色彩 Token
- 按钮 `.btn`
- 卡片 `.card`
- 表单输入 `.form-field` / `input` / `select`
- 字段错误 `.has-error` / `.error-msg`
- 简单表格 `table`
- 内联提示 `.flash` / `.alert`

### 完整层（Components）— 需要时追加

当页面包含复杂表格、弹窗、文件选择器、Tab 工具栏、Toast 等场景时，在核心层基础上追加：

```html
<link rel="stylesheet" href="design-system/colors_and_type.css">
<link rel="stylesheet" href="design-system/core.css">
<link rel="stylesheet" href="design-system/components.css">
```

额外包含：
- 顶部导航 `.top-nav`
- 侧边导航 `.sidenav`
- 页签 `.tabs` / `.tabs-pill` / `.tabs-line`
- 状态徽章 `.badge`
- 表格工具栏 `.toolbar`
- 分页 `.pagination`
- 弹窗 `.modal-overlay` / `.modal-dialog`
- 文件选择器 `.file-picker`
- Toast 提示 `.toast`

---

## 图标系统

统一使用 SVG Sprite。基础图标使用方式：

```html
<svg class="icon"><use href="#icon-refresh"/></svg>
```

图标尺寸：
- `.icon`：16×16（默认）
- `.icon-sm`：14×14
- `.icon-lg`：20×20

完整图标列表见 `USAGE.md`。

---

## 目录结构

```
design-system/
├── colors_and_type.css        # 设计 Token：颜色、字体、间距、圆角、阴影
├── core.css                   # 核心轻量组件（推荐默认引入）
├── components.css             # 完整增强组件（按需引入）
├── css.json                   # Token 结构化数据
├── components/                # 组件契约 JSON
├── preview/                   # 组件预览页
├── ui-kits/dashboard/         # 完整 UI Kit 展示
├── README.md                  # 本说明
└── USAGE.md                   # 详细使用手册
```

---

## 核心 Token 速查

| 变量 | 值 | 用途 |
|------|-----|------|
| `--khc-primary-500` | `#1664FF` | 品牌蓝、主按钮、链接 |
| `--khc-success-500` | `#10B981` | 成功、完成状态 |
| `--khc-warning-500` | `#F59E0B` | 警告、取消状态 |
| `--khc-danger-500` | `#EF4444` | 错误、删除、失败 |
| `--khc-surface-page` | `#F8FAFC` | 页面背景 |
| `--khc-surface-card` | `#FFFFFF` | 卡片背景 |
| `--khc-border-1` | `#E2E8F0` | 默认边框 |
| `--khc-text-1` | `#0F172A` | 主文本 |
| `--khc-text-2` | `#475569` | 次要文本 |
| `--khc-text-3` | `#94A3B8` | 辅助文本 |

---

## 设计原则

1. **轻量优先**：核心层只保留最基础的布局与组件
2. **按需加载**：复杂组件不强制引入
3. **色彩统一**：所有项目共用同一套 Token，保持品牌一致
4. **中文优先**：默认文案以中文为主
5. **少即是多**：不使用过度阴影、渐变、动画
