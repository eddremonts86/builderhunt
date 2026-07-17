# Specification: Accessibility & Semantic HTML

## Problem

The current BuilderHunt landing page and dashboard components contain multiple accessibility (a11y) barriers that violate WCAG 2.2 Level AA compliance guidelines:
1. **Inert Accordion & FAQ Patterns**: The FAQ controls are div-based toggle boxes lacking semantic roles, keyboard bindings, and ARIA state labels (like `aria-expanded` or `aria-controls`), making them unreadable for screen readers.
2. **Missing Focus Indicators**: Interacting via keyboard (`Tab` navigation) does not show a clear focus ring (`outline-none` overrides), leaving keyboard-only users blind to their current position.
3. **Low Contrast Elements**: Text color tokens for secondary subtitles, labels, and badges fall below the WCAG AA minimum contrast ratio of **4.5:1** for regular text.
4. **Touch Target Size Deficiencies**: Custom icon buttons (like closing modal drawers or sidebar tags) have active touch targets smaller than **24x24 CSS pixels** (violating WCAG 2.2 SC 2.5.8).
5. **No Skip Link Navigation**: The dashboard lacks a functional skip-to-content anchor, forcing keyboard users to tab through the entire sidebar menu on every page load.

## Goal

Bring the landing page and core dashboard components into full WCAG 2.2 Level AA compliance:
- Re-architect the FAQ section using semantic HTML5 `<details>` and `<summary>` tags.
- Implement high-visibility focus indicators across all interactive elements.
- Audit and adjust Tailwind color variables to satisfy the 4.5:1 contrast requirement.
- Enforce the minimum 24x24 CSS pixel target size with padding grids.
- Implement a functional skip-to-content anchor.

## User stories

1. **As a screen reader user**, when I navigate to the FAQ section, I want the system to announce whether each question is expanded or collapsed.
2. **As a keyboard-only user**, when I tab through the page, I want to see a clear, high-contrast focus ring outline around every active element.
3. **As a visually impaired user**, I want all page copy, badge text, and form labels to have high enough contrast to read without eye strain.

## Technical details & fixes

### 1. Semantic & Accessible FAQ Accordion
Re-write `src/modules/landing/components/FAQSection.tsx` to use native `<details>` and `<summary>` elements:
```html
<details class="group border-b border-zinc-800 py-4">
  <summary class="flex cursor-pointer list-none items-center justify-between font-medium text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded p-1">
    <span>How is the builder score calculated?</span>
    <span class="transition-transform group-open:rotate-180" aria-hidden="true">+</span>
  </summary>
  <p class="mt-2 text-zinc-400 leading-relaxed">
    Our algorithm scores developers on a scale from 0 to 100 based on repository stars, recency of public pushes, and code quality.
  </p>
</details>
```
*Note: Using native `<details>` automatically manages open/closed accessibility state in the browser accessibility tree without custom JS.*

### 2. High-Visibility Focus Outline Rules
Update the global stylesheets (or `@tailwindcss/vite` configuration):
- Bind the custom styling `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2` to all interactive tags (`<button>`, `<a>`, `<input>`, `<textarea>`).
- Enforce that focus rings have an active contrast > 3:1 against background colors.

### 3. Contrast Ratios (WCAG 2.2 AA Audit)
Modify grey/neutral color variables to elevate contrast:
- Replace `text-zinc-500` (contrast ratio 3.1:1 on dark grey) with `text-zinc-400` (contrast ratio 5.1:1).
- Replace `text-zinc-400` on secondary elements with `text-zinc-300` (contrast ratio 7.0:1).
- Verify that background-to-foreground contrast for tags/badges is at least **3:1**.

### 4. Interactive Target Sizes (SC 2.5.8)
- Update icon buttons in dashboard components (e.g. `src/modules/builder-profile/components/BuilderDetailSheet.tsx` close buttons) to have a bounding padding of at least `p-2` or define `min-w-[24px] min-h-[24px]` explicitly.

### 5. Skip to Main Content Anchor
Add the anchor inside `src/routes/__root.tsx` as the first node:
```html
<a href="#main-content" class="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:bg-indigo-600 focus:text-white focus:px-4 focus:py-2 focus:rounded">
  Skip to main content
</a>
<!-- Mount id="main-content" on the primary <main> layout node -->
```

## Success metrics

- **Compliance**: Page passes Lighthouse accessibility audits with a **100% score**.
- **Keyboard Navigation**: 100% of dashboard features are reachable and triggerable using keyboard-only input (`Tab`, `Enter`, `Space`, `Escape`).
