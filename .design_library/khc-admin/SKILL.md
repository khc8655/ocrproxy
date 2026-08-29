---
name: khc-admin-design
description: Use this skill to generate well-branded interfaces for KHC Admin. Contains colors, type, fonts, assets, and UI kit for prototyping dashboard UIs.
user-invocable: true
---

# KHC Admin Design Skill

Read the `README.md` file within this skill, and explore the other available files.

If creating visual artifacts, copy assets out and create static HTML files. If working on production code, read the rules here to become an expert in designing with this brand.

## Quick map

- `AGENT_RULES.md` — concise implementation rulebook: read this first before writing UI
- `README.md` — brand context, content fundamentals, visual foundations
- `colors_and_type.css` — drop-in CSS variables for colors, type, radius, shadow, spacing
- `css.json` — structured token understanding source
- `components/index.json` — component index + cross-component patterns
- `components.css` — aggregated component CSS
- `library-consumption.json` — recommended downstream read order
- `preview/` — small HTML cards illustrating foundations and components
- `ui_kits/dashboard/` — full click-thru recreation

Read `AGENT_RULES.md` first for the implementation checklist, then `README.md` for brand context, then return here for the full rule set.

## Essentials at a glance

- Brand primary `#1664FF` — cool, technical blue on light gray canvas. No warm accents, no decorative gradients except the logo gradient in the top navigation.
- Radius tokens are deliberate and tight. Use **only** these values:
  - `radius-sm` = **2px** (buttons, inputs, small controls)
  - `radius-md` = **4px** (cards, small containers)
  - `radius-lg` = **8px** (panels, large containers)
  - `radius-xl` = **12px** (highest-level containers)
  - **Status badges are the ONLY pill-shaped elements (10px radius).**
- Type scale is strict. Body is **14px**. Headings are **h1 24px / h2 20px / h3 16px**.
- Component heights: top appbar **48px**, default button **32px**, standard input **40px**.
- 32px default control height, 4px spacing unit, 8-pt grid.
- Type: PingFang SC (CN body + display); SF Mono for code; no web font imports.
- Voice: **Chinese-first, professional, neutral, no emoji, no exclamation marks, no marketing copy.**
- Shadows whisper-quiet: 5 levels from 1px offset (rest) to 12px offset (overlays), max .12 opacity.
- Status badges are first-class: 5 semantic states (done/running/queued/failed/canceled) in pill shape.

## Agent Rules

### Absolute bans

- No emoji in visible UI text, buttons, status labels, toasts, headings, or tooltips.
- No exclamation marks (`!`) in copy.
- No marketing phrases (`实时探测...`, `全新体验`, `立即开启`, etc.).
- No decorative gradients except the top-navigation logo gradient defined in `components/navigation.json`.
- No invented token values. Do not guess radii, font sizes, spacing, colors, or heights.
- No verbose button labels longer than 6 Chinese characters.
- No verbose status labels longer than 4 Chinese characters.

### Token compliance

- Use **only** variables from `colors_and_type.css`. Treat that file as the single source of truth.
- Never hardcode radius, font-size, spacing, or color values.
- **Never** use `13px` for body text; body is `--font-size-body` (`14px`).
- **Never** use `4px` for `radius-sm`; `radius-sm` is **2px**.
- Reference tokens by name (`--radius-sm`, `--font-size-h1`, `--space-4`, `--khc-primary-500`, etc.).

### Copy discipline

- **Action buttons** use verb-object structure and stay between 2–6 Chinese characters, e.g. `保存配置`, `应用配置`, `上传模板文件`, `全量重入库`.
- **Nav items** use concise noun phrases at a consistent abstraction level, e.g. `概览`, `基础配置`, `文档库`, `模板管理`, `任务中心`.
- **Section titles** use concise noun phrases, not full sentences or slogans.
- **Toasts / status messages** are factual statements without emoji prefixes like checkmarks, crosses, or warning triangles.

### Component discipline

- Treat the files in `components/{slug}.json` as binding contracts.
- Do not restyle components, add extra states, or change anatomy.
- **Badge** is pill-shaped only (10px radius). No other component may use a pill.
- **Card** hover state uses `shadow-2` only. Do not darken borders or add scale transforms.
- **Table** has no zebra striping. Rows use bottom-border only; hover uses `--khc-surface-hover`.
- **Button** hover / active states use `filter: brightness(...)` against the same background color; do not swap to a different color.

### Before you ship

Check every artifact against this list:

1. No emoji in visible text.
2. All colors, radii, font sizes, spacing, and heights come from `colors_and_type.css`.
3. Copy follows verb-object / noun-phrase rules and stays within length limits.
4. Component styles match `components.css` and the corresponding `components/{slug}.json` contracts.
5. No decorative gradients except the logo gradient in `navigation.json`.

## Common failure modes

- Agents often set body font to `13px` — must be `14px` (`--font-size-body`).
- Agents often use `4px` for `radius-sm` — must be `2px` (`--radius-sm`).
- Agents often add emoji to buttons, status labels, or toasts — remove all of them.
- Agents often write marketing copy like `实时探测...` — simplify to concise noun phrases.
- Agents often deepen card border on hover — use `shadow-2` only and leave the border unchanged.

## Components

| Slug | Name | Key Insight |
|------|------|-------------|
| button | Button | Compact 32px height, blue primary, no decorative icons |
| card | Card | White surface, 1px border, whisper-quiet shadow, 20px padding |
| table | Table | Gray header, hover highlight, no zebra, bottom-border-only rows |
| badge | Status Badge | Pill shape, 5 semantic states: done/running/queued/failed/canceled |
| navigation | Top Navigation | 48px sticky bar, brand left, actions right, subtle border |
| sidebar | Side Navigation | 220px width, icon+label items, blue left-border active state |

Refer to `components/{slug}.json` for the full contract; do not deviate from documented anatomy, states, or variants.
