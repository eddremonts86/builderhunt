# Tasks: Accessibility & Semantic HTML

## Phase 1: Skip Links & Global Outlines
- [ ] Add the "Skip to main content" link to `src/routes/__root.tsx`
- [ ] Mount `id="main-content"` on the primary page wrapper element
- [ ] Set up global `focus-visible` focus ring styles in `src/shared/styles/` or tailwind configuration

## Phase 2: Color Contrast Corrections
- [ ] Scan and replace `text-zinc-500` with `text-zinc-400` across landing modules
- [ ] Scan and replace `text-zinc-400` with `text-zinc-300` across landing modules
- [ ] Audit badge/pill backgrounds to ensure contrast matches 3:1 criteria

## Phase 3: Semantic FAQ refactor
- [ ] Re-write `src/modules/landing/components/FAQSection.tsx`
  - [ ] Replace custom div components with `<details>` and `<summary>`
  - [ ] Add SVG indicators showing state transitions
  - [ ] Configure keyboard toggling support (Space/Enter) natively

## Phase 4: Target Sizes & Focus Trap
- [ ] Add minimum size layouts (`min-w-[24px] min-h-[24px]`) to all tiny icons and close button containers
- [ ] Write keyboard trap event handlers for the builder detail side-drawer (lock tab navigation inside drawer, release on click outside or Escape)

## Phase 5: Verification & Audits
- [ ] Audit the app locally using Lighthouse or Axe DevTools chrome extensions
- [ ] Verify tab navigation order flow matches visual layouts
