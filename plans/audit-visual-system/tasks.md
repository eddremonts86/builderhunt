# Tasks: Visual System Normalization

## Phase 1: Design Tokens Alignment
- [ ] Review Tailwind v4 CSS configuration to ensure standard naming rules
- [ ] Define helper CSS classes for standard corner radii (e.g. `rounded-2xl` for cards, `rounded-xl` for buttons)

## Phase 2: Spacing & Margin corrections
- [ ] Scan `src/routes/_landing/index.tsx` for ad-hoc spacing values and replace them with 4px grid steps (`mt-12`, `mb-6`, `p-6`)
- [ ] Unify layout grids (margins/paddings) inside search page and builder detail components

## Phase 3: Card Heights Normalization
- [ ] Update features section grid in `src/routes/_landing/index.tsx` to use `items-stretch` and `h-full` to align card heights
- [ ] Update candidate result card loops to use flex vertical expansion

## Phase 4: Button styles & contrast
- [ ] Refactor secondary button component styles
  - [ ] Replace low-contrast gray backgrounds with higher-contrast dark slate
  - [ ] Add border highlight hover effects
  - [ ] Integrate active scale down micro-animations (`active:scale-95`)
- [ ] Update primary/secondary CTA sizes to ensure consistent height matching

## Phase 5: Responsive Verification
- [ ] Test layout wrapping on small screens
- [ ] Adjust padding margins on mobile viewports (<640px) to prevent card edge clipping
- [ ] Verify vertical stacks and FAQ layout shift behaviors during responsive checks
