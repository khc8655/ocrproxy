---
name: khc-admin-design
description: Use this skill to generate well-branded interfaces for KHC Admin. Contains colors, type, fonts, assets, and UI kit for prototyping dashboard UIs.
user-invocable: true
---
# KHC Admin Design Skill

Read the `README.md` file within this skill, and explore the other available files.

If creating visual artifacts, copy assets out and create static HTML files. If working on production code, read the rules here to become an expert in designing with this brand.

## Quick map

- `README.md` — brand context, content fundamentals, visual foundations (read first)
- `colors_and_type.css` — drop-in CSS variables for colors, type, radius, shadow, spacing
- `css.json` — structured token understanding source
- `components/index.json` — component index + cross-component patterns
- `components.css` — aggregated component CSS
- `library-consumption.json` — recommended downstream read order
- `preview/` — small HTML cards illustrating foundations and components
- `ui_kits/dashboard/` — full click-thru recreation

## Essentials at a glance

- Brand primary #1664FF — cool, technical blue on light gray canvas. No warm accents, no decorative gradients.
- Radius 2/4/8/12 — deliberate and tight. Pills only for status badges.
- 32px default control height, 4px spacing unit, 8-pt grid.
- Type: PingFang SC (CN body + display); SF Mono for code; no web font imports.
- Voice: bilingual CN-first, professional, neutral, no emoji in UI.
- Shadows whisper-quiet: 5 levels from 1px offset (rest) to 12px offset (overlays), max .12 opacity.
- Status badges are first-class: 5 semantic states (done/running/queued/failed/canceled) in pill shape.

## Components

| Slug | Name | Key Insight |
|------|------|-------------|
| button | Button | Compact 32px height, blue primary, no decorative icons |
| card | Card | White surface, 1px border, whisper-quiet shadow, 20px padding |
| table | Table | Gray header, hover highlight, no zebra, bottom-border-only rows |
| badge | Status Badge | Pill shape, 5 semantic states: done/running/queued/failed/canceled |
| navigation | Top Navigation | 48px sticky bar, brand left, actions right, subtle border |
| sidebar | Side Navigation | 220px width, icon+label items, blue left-border active state |
