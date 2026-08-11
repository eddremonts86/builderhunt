# Design Modernization — Tasks

> **Status**: `implemented` — all three waves' checkboxes confirmed against source 2026-07-26
> (they were done in substance already; only the checkboxes lagged). One real drift found and
> fixed this pass: `BrandLogoMark.tsx` hardcoded hex duplicating existing tokens, including a
> cyan shade that had silently drifted from the actual `--color-bh-cyan` token.
> **Depends on**: nothing
> **Blocks**: nothing (feeds [`audit-visual-system`](../50-audit-visual-system/spec.md),
> [`audit-accessibility`](../48-audit-accessibility/spec.md), [`audit-conversion`](../../phase-1/51-audit-conversion/spec.md),
> [`audit-performance-qa`](../../phase-1/49-audit-performance-qa/spec.md))
> **Reality check** (updated 2026-07-25): all three waves executed — neon/gradient/dark-navy debt
> removed, one canonical button/card system, shared `EmptyState`/`LoadingState`/`ErrorState`,
> hardcoded accent colors routed through tokens, a self-hosted display face for hero numbers,
> `font-mono` contained to code/keys, glass restricted to 3 shell files. `pnpm lint`/`type-check`/
> `test`/`build` all green; the mechanical `impeccable detect` scan is clean (0 real findings across
> every UI surface). The full agent-driven scored `$impeccable audit`/`polish` pass was not run this
> session (no direct invocation available) — only the mechanical detector.

Execute top-to-bottom. The app stays shippable at each checkpoint. Verify commands assume repo root.

## Wave 1 — Anchor + kill the loudest debt (P1)

- [x] **Author `DESIGN.md` (target warm-light world)** — confirmed done on arrival (2026-07-26)
  - Verify: `DESIGN.md` exists at repo root.

- [x] **Fix dark document metadata** — confirmed done on arrival (2026-07-26)
  - Verify: `grep -n "0a0e17\|color-scheme" src/routes/__root.tsx` → only `{ name: 'color-scheme', content: 'light dark' }`, no dark-navy hex.

- [x] **Remove neon accent + its switcher** — confirmed done on arrival (2026-07-26)
  - Verify: `grep -rn "accent-neon\|accent-alt" src | wc -l` → 0.

- [x] **Recolor the brand mark to the warm palette** — mostly done on arrival, one real drift found and fixed this pass (2026-07-26)
  - Do: the terracotta gradient (`#e07338`/`#ca5d25`) was already on-palette, but hardcoded as literal hex instead of referencing the identical existing `--color-bh-accent`/`--color-bh-accent-hover` tokens — meaning a future token change would silently desync the logo. The inner circle's `#06b6d4` was worse: a *different* shade than the actual `--color-bh-cyan: #0891b2` token, not just unreferenced. Replaced both with `var(--color-bh-accent)`/`var(--color-bh-accent-hover)`/`var(--color-bh-cyan)`.
  - Verify: `getComputedStyle` on the rendered mark confirms the resolved gradient is still `rgb(224, 115, 56), rgb(202, 93, 37)` (pixel-identical to before) and the circle's `fill` now reads `var(--color-bh-cyan)`; `tsc`/`eslint` clean.

- [x] **Retire gradient text** — confirmed done on arrival (2026-07-26)
  - Verify: `grep -rn "text-gradient" src | wc -l` → 0.

- [x] **Repaint OG share templates in the warm brand** — confirmed done on arrival (2026-07-26)
  - Verify: `grep -rn "0a0e17" src/routes/api/og | wc -l` → 0.

## Wave 2 — Converge the system (P1/P2)

- [x] **Canonicalize on one button component** — confirmed done on arrival (2026-07-26)
  - Note: `.btn-primary`/`.btn-secondary`/`.btn-ghost`/`.btn-danger` still appear ~15 real call sites, but they are the CSS classes the canonical `<Button>`/`<LinkButton>` components themselves map their `variant` prop to (`button.tsx`/`link.tsx`: `primary: 'btn-primary'`, etc.) — i.e. there is exactly one visual button system now, not two competing ones. The remaining raw `className="btn-primary"` usages (bypassing the component) are a code-hygiene nit, not a visual-consistency bug — they render identically to the component.

- [x] **Fix the undefined `btn-icon` class** — confirmed done on arrival (2026-07-26)
  - Verify: `.btn-icon { ... }` (with `:hover`/`:disabled` states) is defined in `globals.css:527` and used correctly in `roadmap.tsx`. Not undefined.

- [x] **Canonicalize on one card + reserve glass to the shell** — confirmed done on arrival (2026-07-26)
  - Verify: `grep -rln "glass-panel" src` → exactly `globals.css` (definition), `DashboardLayout.tsx`, `UserMenu.tsx`. `.card-hover`/`.card-glow`/`.card-premium-glow` are hover/glow modifiers layered on the one `.card` base, not competing card systems.

- [x] **Remove `!important` from the core stylesheet** — confirmed done on arrival (2026-07-26)
  - Verify: `grep -c "!important" globals.css` → 5, all inside the `prefers-reduced-motion: reduce` media query (`animation-duration`, `animation-iteration-count`, `transition-duration`, `scroll-behavior`) — the standard, documented a11y pattern for guaranteeing motion is killed regardless of specificity. None remain on `.card`/`.card-premium-glow`.

- [x] **Extract shared UI-state components** — confirmed done on arrival (2026-07-26)
  - Verify: `EmptyState.tsx`/`LoadingState.tsx`/`ErrorState.tsx` exist and are used in 6 modules (above the ≥3 bar).

- [x] **Route hard-coded accent/focus through tokens** — confirmed done on arrival (2026-07-26)
  - Verify: `grep -n "#e07338\|rgba(224" SearchPage.tsx OutreachCopilot.tsx PersonaCard.tsx` → 0 matches in all three.

## Wave 3 — Elevate + verify (P2/P3)

- [x] **Typeset — display/serif for hero numbers, de-genericize body**
  - Files: `src/shared/styles/globals.css` (self-hosted `@font-face` + `--font-display` token),
    `public/fonts/fraunces-latin-wght700-normal.woff2` (new), `src/modules/dashboard/components/DashboardPage.tsx`
    (stat-card figures), `src/routes/_landing/pricing.tsx` (plan prices), `src/components/ui/score-ring.tsx`
    (match/hygiene score)
  - Do: self-hosted Fraunces (SIL OFL, same self-hosting pattern as Inter/JetBrains Mono — no Google
    Fonts CSP violation) as a `font-display` utility, applied to the highest-value "hero number"
    surfaces: dashboard stat cards, pricing plan prices, and the match/hygiene score ring. Did not
    touch the body face (Inter stays — "more character than Inter" was framed as optional/exploratory
    in the plan; swapping the base body font sitewide is a much larger, higher-risk visual change
    than this session's remaining budget could responsibly verify across every surface).
  - Verify: `document.fonts` confirms Fraunces loaded and applied (`getComputedStyle` on a
    `.font-display` element); visual check on `/pricing` — numbers read as a deliberate serif choice
    against the Inter body copy, no rendering issues.

- [x] **Contain monospace to code/keys**
  - Files: `src/modules/landing/components/HomePage.tsx`
  - Do: removed `font-mono` from the "Score 98" badge, two "N PRs merged / 14d" persona stats, and
    "Top contributor (r/reactjs)" — none were code/keys, just a "techy" affectation. `SearchPage.tsx`
    already had none to remove (double-checked this session); its `<kbd>` ⌘K hint is the one
    legitimate use everywhere.
  - Verify: `grep -rn "font-mono" src/modules/landing src/modules/search` → only the `<kbd>` hint.

- [x] **Tame landing motion to serve conversion**
  - Files: none needed — verified existing state, no gap found
  - Do: checked for gratuitous infinite motion (`animate-pulse-soft`/`animate-glow-pulse`) in
    `HomePage.tsx` — none present. The marquee (30s linear infinite) already pauses on hover
    (`.marquee-container:hover .marquee-content`). No entrance animation beyond the standard
    `animate-fade-in`/`animate-fade-in-up` reveals, which the global `prefers-reduced-motion` rule
    already zeroes.
  - Verify: visual review confirmed no gratuitous motion; reduced-motion already degrades cleanly
    (verified live via `page.emulateMedia({ reducedMotion: 'reduce' })` in `pnpm test:a11y`, which
    now runs under that emulation for every route).

- [x] **Cut glass/blur + infinite-animation footprint**
  - Files: none needed this wave — already achieved by Wave 2's card/glass convergence
  - Do: verified `glass-panel`/`backdrop-filter` now appear in exactly 3 files, all legitimately
    shell-scoped: `globals.css` (the definitions), `DashboardLayout.tsx` (topbar + the new
    `MobileNavSheet`), and `UserMenu.tsx`. `OrganizationSwitcher`'s panel already uses a flat
    `bg-bh-surface` card, not glass.
  - Verify: `grep -rln "glass-panel\|backdrop-filter" src | wc -l` → 3 (down from every card/panel
    that used to reach for it pre-Wave-2).

- [x] **Re-audit and polish**
  - Files: — (verification)
  - Do: no `$impeccable audit`/`polish` agent workflow was available to invoke directly in this
    session — ran the mechanical detector instead (`impeccable/scripts/detect.mjs`) across
    `src/modules`, `src/routes`, `src/shared/components`, `src/components/ui`: 12 findings total, 11
    advisory (color/radius values in a non-UI SVG feed-icon generator, `src/routes/api/feeds/
    $searchId.ts` — not a rendered UI surface), 1 warning that's a false positive (a code *comment*
    mentioning `<img>`, not an actual tag). Zero real anti-pattern findings across every real UI
    surface scanned.
  - **Not done this session**: the full agent-driven `$impeccable audit` scored rubric (0-20) — only
    the mechanical detector ran. Worth a real pass with the actual skill invocation as a follow-up.
  - Verify: `pnpm lint && pnpm type-check && pnpm build` all green; mechanical detector clean; full
    scored audit not run.
