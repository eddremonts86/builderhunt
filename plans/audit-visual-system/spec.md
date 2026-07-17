# Specification: Visual System Normalization

## Problem

The BuilderHunt landing page and dashboard elements contain multiple layout and style discrepancies that break visual polish and consistency:
1. **Ad-Hoc Spacing & Gaps**: Margins, paddings, and flex/grid gaps are defined arbitrarily across files, resulting in alignment offsets of 1–4 px.
2. **Inconsistent Border Radii & Shadows**: Buttons, badges, and card components use different rounded values (e.g. some buttons use `rounded-md`, some `rounded-full`, cards alternate between `rounded-lg` and `rounded-2xl`) and shadow elevations, producing a chaotic feel.
3. **Unequal Card Heights**: In grid systems (like the features list or candidate results), cards containing different copy lengths render at different heights, breaking vertical alignment.
4. **Weak Secondary CTA Contrast**: The secondary action button uses low-contrast grey backgrounds and borders, making it resemble a disabled element.
5. **Responsive Breakdown**: In mobile viewports (<640px) or tablet views (768px), floating elements overflow horizontally, lateral padding margins are insufficient, and the footer takes up too much vertical space.

## Goal

Standardize the visual system of BuilderHunt using a unified design token system:
- Enforce strict spacing scales (multiples of 4px) and flex/grid alignments.
- Unify border radii and shadow elevations.
- Ensure all grid card elements share identical height constraints.
- Re-design secondary button styles to prevent "disabled" appearance.
- Refactor responsive layouts to prevent overflows and layout shifts on small viewports.

## User stories

1. **As a visitor**, when I view the page on my phone or tablet, I want the grids and cards to stack neatly without horizontal scrollbars or overflowing tags.
2. **As a visitor**, I want card containers in any row grid to have matching heights, creating clean horizontal lines.
3. **As a visitor**, I want to clearly distinguish between primary and secondary clickable buttons.

## Technical details & tokens

### 1. Unified Border Radii & Shadow Tokens
We establish strict visual style guides:
- **Card containers**: `rounded-2xl` (`1rem` / `16px`) with `shadow-xl`.
- **Primary/Secondary Buttons & Inputs**: `rounded-xl` (`0.75rem` / `12px`) with `shadow-md`.
- **Badges, Pills, and Tag chips**: `rounded-full` or `rounded-md` (`0.375rem` / `6px`) with `shadow-sm`.

### 2. Equal Grid Heights
Modify all grid card layouts (e.g. `src/modules/landing/components/FeaturesGrid.tsx` and builder cards) to enforce same-height constraints:
- Apply `flex flex-col h-full justify-between` to card wrappers.
- Set title and body layout heights so text wrapping does not push content down.

### 3. Button Restyling
Modify the secondary button style inside `src/shared/components/Button.tsx`:
- **Old (Frictional)**: `bg-zinc-800 border border-zinc-700 text-zinc-500` (low contrast, looks disabled).
- **New (Premium)**: `bg-zinc-900 border border-zinc-700 text-zinc-200 hover:bg-zinc-800 hover:border-zinc-500 active:scale-95 transition-all duration-150`.

### 4. Responsive Padding & Overflows
- Set main grid layout wrappers on the landing page to use clean responsive padding rules:
  - Mobile: `px-4 py-8`
  - Tablet: `md:px-8 md:py-16`
  - Desktop: `lg:px-12 lg:py-24 max-w-7xl mx-auto`
- For card text blocks, prevent text overflow issues by using standard Tailwind text-wrapping overrides (`break-words` and `line-clamp-3`).

## Success metrics

- **Pixel-Perfect Alignment**: All margins, paddings, and card gaps align to a strict 4px grid system without custom pixel values.
- **Visual Harmony**: 100% of cards, buttons, and inputs share matching corner radii tokens.
