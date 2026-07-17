# Plan: Accessibility & Semantic HTML

## Goal recap

Bring BuilderHunt into full compliance with WCAG 2.2 Level AA guidelines. Focus on semantic HTML5 FAQ tags, high-contrast text tokens, minimum 24px target sizes, visible focus rings, and skip-to-content anchors.

## Why this is a valuable addition

1. **Inclusive Product Quality**: Accessibility is a fundamental marker of premium design engineering. A production-ready developer platform must support all engineers, including those utilizing screen readers or keyboard controls.
2. **SEO Optimization Boost**: Search engines reward semantic layouts (like `<main>`, `<nav>`, `<details>`) with higher organic ranking signals.
3. **Enterprise Compliance**: Large recruiting companies require WCAG compliance certificates (VPATs) to buy software. Meeting Level AA unlocks sales conversations.

## Phases

### Phase 1: Global Outlines & Skip Links
- Edit root layout `src/routes/__root.tsx`:
  - Add the hidden "Skip to main content" anchor as the first child of the body element.
  - Mount `id="main-content"` on the primary `<main>` wrapper node.
- Configure tailwind CSS focus rules in global stylesheets:
  - Establish `focus-visible:ring-2 focus-visible:ring-indigo-500` outlines globally.

### Phase 2: CSS Contrast Audit & Variables
- Scan color token files and global classes.
- Replace low-contrast gray colors:
  - Swap `text-zinc-500` with `text-zinc-400`.
  - Swap `text-zinc-400` with `text-zinc-300` on body copy blocks.
- Verify badge tags (such as source pills) meet the 3:1 contrast requirement.

### Phase 3: Semantic FAQ & Acordeón refactor
- Edit `src/modules/landing/components/FAQSection.tsx`.
- Replace the previous div-based click handler with native HTML5 `<details>` and `<summary>` tags.
- Apply transitional rotate animations on toggle state using CSS group-selectors.

### Phase 4: Target Sizes & Keyboard trapping
- Review buttons and elements in `src/modules/builder-profile/components/`.
- Ensure all close buttons and tags meet the 24x24 CSS pixel bounding size.
- Implement standard accessibility modal trapping inside profile detail drawers (ensuring focus is trapped within the slide-out and escapes cleanly when `Escape` is pressed).

### Phase 5: Verification & Accessibility Audit
- Execute local audits using axe-core / Lighthouse CLI tools.
- Verify navigation flow by tabbing through the page without using a mouse.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Fokus outline clashes with visual designs** | Medium | Low | Use `focus-visible` ring parameters so focus circles ONLY display for keyboard navigation, keeping normal mouse clicks outline-free. |
| **Bypass of detail toggle styles on old browsers** | Low | Low | Native details/summary tags have full support across all modern web browsers. |

## Rollback plan

- Accessibility modifications are native structure changes and color overrides, requiring no backend rollback plans.
