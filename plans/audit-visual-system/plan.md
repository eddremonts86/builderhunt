# Plan: Visual System Normalization

## Goal recap

Standardize BuilderHunt's spacing, border radii, shadow elevations, card heights, button styling, and responsive grids to eliminate visual bugs, misalignment, and layout inconsistencies.

## Why this is a valuable addition

1. **Aesthetics & Premium Polish**: Consistency in spacing, corner rounding, and alignments separates high-end developer products from generic, quickly assembled layouts.
2. **Design System Hygiene**: Replacing custom CSS offsets with standard Tailwind tokens makes the front-end code cleaner, more maintainable, and easier to iterate on.
3. **Responsive Stability**: Ensuring the layout is fully responsive prevents layout breaks on tablets or laptops, supporting mobile-first visitors.

## Phases

### Phase 1: Tailwind CSS Design Tokens Auditing
- Verify configurations inside `tailwind.config` or `@tailwindcss/vite` imports.
- Configure or write global CSS utility classes for consistent rounding (`rounded-card`, `rounded-button`) and shadows if custom attributes are required, or establish standard guidelines.

### Phase 2: Spacing & Grid Alignments
- Audit layout files:
  - `src/routes/_landing/index.tsx`
  - `src/routes/_dashboard/search/index.tsx`
- Replace raw margin values with 4px grid steps (`space-y-4`, `space-y-8`, `gap-6`, `p-6`).

### Phase 3: Card Height Normalization
- Update grid loops.
- Enforce same-height constraints on cards using:
  ```html
  <div class="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
    <!-- Card item -->
    <div class="flex flex-col h-full bg-zinc-900 border border-zinc-800 rounded-2xl p-6 justify-between">
      ...
    </div>
  </div>
  ```

### Phase 4: Button Refactoring & Contrast
- Update button variants inside `src/shared/components/Button.tsx` (or custom button styles).
- Rewrite secondary button styles to improve contrast (active hover states, scale transitions).
- Add hover transitions: `transition-all duration-150 active:scale-[0.98]`.

### Phase 5: Responsive Viewports Verification
- Check responsive styles on mobile, tablet, and widescreen layouts.
- Validate that the footer section stacks cleanly on screens <768px.
- Use `line-clamp` utilities to enforce vertical alignment in copy fields.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Vite-8 Tailwind compile warning** | Low | Low | Use native CSS variables configured in Tailwind v4 guidelines, avoiding obsolete syntax. |
| **Grid layout wraps on tablet view** | Medium | Low | Use sensible breakpoints: `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` to prevent cramped horizontal cards. |

## Rollback plan

- Visual corrections are markup and theme styles changes, requiring no server rollback pipelines.
