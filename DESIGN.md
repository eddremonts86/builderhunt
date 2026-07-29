---
name: BuilderHunt
description: Discover active open-source builders — a warm, premium studio dashboard, not a hacker terminal.
colors:
  terracotta: "#e07338"
  terracotta-deep: "#ca5d25"
  slate-cyan: "#0891b2"
  cream-bg: "#ececf0"
  cream-bg-alt: "#f1f1f3"
  surface: "#ffffff"
  surface-2: "#fcfcfc"
  border: "#e4e4e7"
  border-strong: "#d4d4d8"
  ink: "#18181b"
  ink-muted: "#52525b"
  ink-dim: "#71717a"
  success: "#16a34a"
  warning: "#d97706"
  danger: "#dc2626"
typography:
  display:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontWeight: 800
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontWeight: 400
  label:
    fontFamily: "'JetBrains Mono', monospace"
rounded:
  sm: "8px"
  md: "10px"
  lg: "20px"
  xl: "24px"
  pill: "9999px"
spacing:
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "1.75rem"
components:
  button-primary:
    backgroundColor: "{colors.terracotta}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "0.625rem 1.25rem"
  button-primary-hover:
    backgroundColor: "{colors.terracotta-deep}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0.625rem 1.25rem"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "1.5rem"
---

# Design System: BuilderHunt

## Overview

**Creative North Star: "The Warm Studio Dashboard"**

BuilderHunt is mid-migration from a dark, generic dev-tool theme to a warm, premium-light
system — terracotta and cream over a calm, ordered surface. It should feel like a well-run
studio dashboard: confident, unhurried, built by people who care about craft — not a hacker
terminal, and not a cold enterprise admin panel. Data is the hero; chrome stays quiet.

The system rejects: gradient text, glass-for-its-own-sake, neon/alternate accent themes, and
dark-navy document metadata bleeding into a light-first product. Motion is restrained —
purposeful reveals, not marquees and pulses competing for attention.

**Key Characteristics:**
- Warm terracotta accent on a cream/white neutral base, applied sparingly
- Numbers and data get visual weight; navigation and chrome stay light
- One button system, one card system — no parallel bespoke/shadcn idioms
- Glass/blur reserved for the elevated dashboard shell (topbar, floating menus), not every box
- Restrained, purposeful motion; full `prefers-reduced-motion` compliance

## Colors

A warm neutral base (cream/white) with a single terracotta accent used sparingly, plus a
muted slate-cyan as a secondary accent for two-tone gradients (card-glow) and to shade
source-specific badges. Source brand colors (GitHub, Reddit, HN, DEV.to, etc.) are exceptions —
they carry external identity and are not part of the semantic palette.

### Primary
- **Terracotta** (`#e07338`): the one accent — primary buttons, links, focus rings, badges,
  selection color. Used sparingly; it is not a background color.
- **Terracotta Deep** (`#ca5d25`): hover/active state for the accent, and the gradient stop
  paired with Terracotta on the brand mark and OG images.

### Secondary
- **Slate Cyan** (`#0891b2`): secondary accent, used only in the `.card-glow` border gradient
  paired with Terracotta. Not used as a standalone interactive color.

### Neutral
- **Cream Background** (`#ececf0`): page background (`--color-bh-bg`).
- **Cream Background Alt** (`#f1f1f3`): secondary surfaces, muted backgrounds (`--color-bh-bg-alt`).
- **Surface White** (`#ffffff`): card/panel surface (`--color-bh-surface`).
- **Surface White 2** (`#fcfcfc`): a step below Surface White, for nested panels (`--color-bh-surface-2`).
- **Border** (`#e4e4e7`) / **Border Strong** (`#d4d4d8`): default and emphasized dividers.
- **Ink** (`#18181b`): primary text.
- **Ink Muted** (`#52525b`): secondary text.
- **Ink Dim** (`#71717a`): tertiary/disabled text, placeholders.

Dark mode is a full token-swap (`.dark` on `<html>`), not a separate design: the same semantic
names (`--color-bh-bg`, `--color-bh-text`, etc.) resolve to near-black surfaces and near-white
text. Two source badges (GitHub, DEV.to) flip their ink to stay visible against a dark page.

### Named Rules
**The One Accent Rule.** There is exactly one interactive accent color (Terracotta). No
alternate/neon accent theme — it was removed because a bright accent theme reads as generic
dark-dev-tool chrome, the system's explicit anti-reference.

## Typography

**Body/UI Font:** Inter (self-hosted variable, weights 100–900), with the system-ui stack as
fallback.
**Monospace Font:** JetBrains Mono (self-hosted variable), used only for code, keyboard-shortcut
badges (`.kbd`), and literal keys/identifiers — never for marketing or discovery copy.

**Character:** A single, versatile grotesk (Inter) carries the whole system today. Hero numbers
and large stat figures are the system's next typographic differentiation point (tracked in
`plans/phase-1/06-design-modernization`), not yet a second display face.

### Hierarchy
- **Display / Hero** (800 weight, `text-5xl`–`text-7xl`, tight tracking): landing hero headline.
- **Title** (700–800 weight): section headings, card titles.
- **Body** (400–500 weight, `text-sm`–`text-lg`): default copy, `--color-bh-text` /
  `--color-bh-text-muted`.
- **Label** (600 weight, `0.75rem`–`0.8125rem`, tracked): eyebrows, badges, uppercase section
  labels.

## Layout

Two container widths: `.container` (max 1200px) for standard sections, `.container-narrow`
(max 800px) for reading-width content — both with `1.25rem` side padding. Section rhythm uses
`.section` (5rem vertical, 3rem below 768px) and `.section-lg` (7rem, 4rem below 768px).

The dashboard shell is a fixed glass topbar over scrollable content; the public/landing layout
is a standard flowing page. Responsive collapse below `md` (768px) is being formalized in
`plans/phase-1/07-responsive-mobile-design` (mobile nav pattern, floating-panel viewport clamping, table
overflow handling).

## Elevation & Depth

Hybrid: mostly flat surfaces with a soft ambient shadow at rest, plus one dedicated glass
treatment reserved for the dashboard shell (topbar, dropdown menus). Structural elevation (glass
blur) should not spread to ordinary content cards — that's tracked debt (`.card`'s
`!important`-forced shadow and `.glass-panel` overuse) this plan reduces.

### Shadow Vocabulary
- **Card ambient** (`0 10px 30px -15px rgba(24,24,27,0.03), 0 1px 3px rgba(24,24,27,0.01)`):
  default `.card` rest shadow.
- **Card premium hover** (`0 12px 30px -10px rgba(224,115,56,0.15)`): accent-tinted hover lift
  for `.card-premium-glow`.
- **Glass shadow** (`0 10px 30px -15px rgba(24,24,27,0.08), 0 1px 3px rgba(24,24,27,0.03)`):
  the dashboard shell's topbar/menu treatment only.

### Named Rules
**The Shell-Only Glass Rule.** `backdrop-filter`/`.glass-panel` is reserved for the dashboard
shell (topbar, floating menus, flagship cards) — not general-purpose card decoration.

## Shapes

Generous, soft corners throughout: `8px` for buttons/inputs, `10px` for large buttons, `20px`
for glass panels, `24px` for cards. Pills (`9999px`) for badges and eyebrows. Borders are thin
(1px) and low-contrast at rest, strengthening only on hover/focus — never decorative.

## Components

### Buttons
- **Shape:** `8px` radius (`10px` for `.btn-lg`).
- **Primary:** Terracotta → Terracotta Deep vertical gradient fill, white text, subtle accent
  glow shadow. `0.625rem 1.25rem` padding.
- **Secondary:** white surface, ink text, bordered.
- **Ghost:** transparent, muted text, background tint on hover.
- **Danger / Danger Outline:** red gradient fill or red-tinted outline, for destructive actions.
- **Hover / Focus:** primary/danger lift 1px + brightness boost; every interactive element gets
  the shared `:focus-visible` ring (2px white + 4px accent).

### Badges
- **Style:** pill shape, accent-soft background, accent text, thin accent-tinted border.
- **Source badges:** each external source (GitHub, Reddit, HN, DEV.to, …) keeps its own brand
  tint — these are the confirmed exception to the semantic palette.

### Cards / Containers
- **Corner Style:** `24px` radius.
- **Background:** Surface White.
- **Shadow Strategy:** ambient card shadow at rest (see Elevation); accent-tinted lift only on
  `.card-premium-glow` hover.
- **Border:** thin, low-contrast; strengthens on `.card-hover`.
- **Internal Padding:** `1.5rem`.

### Inputs / Fields
- **Style:** Surface White fill, `border-strong` border, `8px` radius, inset shadow for depth.
- **Focus:** border shifts to accent + `3px` accent-soft glow ring.

### Navigation
- Dashboard shell: fixed glass topbar; account/org controls always reachable. Below `md`, the
  primary nav collapses into a single disclosure pattern (see
  `plans/phase-1/07-responsive-mobile-design/spec.md` for the confirmed pattern) rather than silent
  horizontal scroll.

## Do's and Don'ts

### Do:
- **Do** keep exactly one accent color (Terracotta) and one button/card system.
- **Do** reserve `backdrop-filter`/`.glass-panel` for the dashboard shell.
- **Do** respect `prefers-reduced-motion` for every CSS and JS-driven animation.
- **Do** route all UI color through the `--color-bh-*` semantic tokens — never a raw hex/rgb
  literal in a component.

### Don't:
- **Don't** reintroduce gradient text (`.text-gradient*`) — solid accent color only.
- **Don't** add a second (neon/alternate) accent theme.
- **Don't** ship dark-navy document metadata (`theme-color`, `msapplication-TileColor`,
  `color-scheme`) against a light-first product — they must track the live surface.
- **Don't** use `font-mono` outside literal code/keys.
