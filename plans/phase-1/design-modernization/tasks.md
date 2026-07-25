# Design Modernization — Tasks

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing (feeds [`audit-visual-system`](../audit-visual-system/spec.md),
> [`audit-accessibility`](../audit-accessibility/spec.md), [`audit-conversion`](../audit-conversion/spec.md),
> [`audit-performance-qa`](../audit-performance-qa/spec.md))
> **Reality check** (updated 2026-07-25): all three waves executed — neon/gradient/dark-navy debt
> removed, one canonical button/card system, shared `EmptyState`/`LoadingState`/`ErrorState`,
> hardcoded accent colors routed through tokens, a self-hosted display face for hero numbers,
> `font-mono` contained to code/keys, glass restricted to 3 shell files. `pnpm lint`/`type-check`/
> `test`/`build` all green; the mechanical `impeccable detect` scan is clean (0 real findings across
> every UI surface). The full agent-driven scored `$impeccable audit`/`polish` pass was not run this
> session (no direct invocation available) — only the mechanical detector.

Execute top-to-bottom. The app stays shippable at each checkpoint. Verify commands assume repo root.

## Wave 1 — Anchor + kill the loudest debt (P1)

- [ ] **Author `DESIGN.md` (target warm-light world)**
  - Files: `DESIGN.md` (new)
  - Do: run `$impeccable document` to capture the terracotta+cream warm-light system as canonical
    (palette, type, surfaces, glass scope, motion budget), citing `src/shared/styles/globals.css`.
  - Verify: `DESIGN.md` exists; `node /Users/edd/.agents/skills/impeccable/scripts/context.mjs --target src/routes/_dashboard` reports a non-null `designPath`.

- [ ] **Fix dark document metadata**
  - Files: `src/routes/__root.tsx`
  - Do: set `color-scheme` to `light dark` (or `light`), `theme-color` + `msapplication-TileColor` to
    the warm brand surface, revisit `apple-mobile-web-app-status-bar-style`.
  - Verify: `grep -n "0a0e17\|color-scheme" src/routes/__root.tsx` shows no dark navy; mobile status-bar check.

- [ ] **Remove neon accent + its switcher**
  - Files: `src/shared/styles/globals.css` (`.accent-neon`, `:root.accent-neon…`, `--color-bh-accent-alt*`), `src/modules/dashboard/components/UserMenu.tsx`
  - Do: delete the neon accent tokens/selectors and the accent toggle UI.
  - Verify: `grep -rn "accent-neon\|accent-alt" src | wc -l` → 0.

- [ ] **Recolor the brand mark to the warm palette**
  - Files: `src/shared/components/BrandLogoMark.tsx`
  - Do: replace the blue/purple gradient with terracotta/warm tokens.
  - Verify: `grep -n "url(#\|linearGradient\|#[0-9a-fA-F]" src/shared/components/BrandLogoMark.tsx` shows no off-palette blue/purple; visual check in header + footer.

- [ ] **Retire gradient text**
  - Files: `src/shared/styles/globals.css` (`.text-gradient`, `.text-gradient-accent`) + call sites
  - Do: replace hero headline gradients with a solid token color; delete the utilities.
  - Verify: `grep -rn "text-gradient" src | wc -l` → 0.

- [ ] **Repaint OG share templates in the warm brand**
  - Files: `src/routes/api/og/*.tsx`
  - Do: replace `#0a0e17` gradient stops with warm-brand values.
  - Verify: `grep -rn "0a0e17" src/routes/api/og | wc -l` → 0; render an OG route and eyeball.

## Wave 2 — Converge the system (P1/P2)

- [ ] **Canonicalize on one button component**
  - Files: `src/components/ui/button.tsx`, `src/shared/styles/globals.css` (`.btn-*`), call sites (43 files)
  - Do: standardize on shadcn `<Button>`/`LinkButton`; add a thin compat shim if needed, then migrate
    call sites and retire the bespoke `.btn-*` classes.
  - Verify: `grep -rn "btn-primary\|btn-secondary\|btn-ghost\|btn-danger" src | wc -l` trends to 0 (or only the shim).

- [ ] **Fix the undefined `btn-icon` class**
  - Files: `src/routes/_dashboard/admin/roadmap.tsx` (and/or `src/shared/styles/globals.css`)
  - Do: replace `btn-icon` with the canonical icon-button, or define it once.
  - Verify: `grep -rn "btn-icon" src` shows no undefined usage; roadmap admin controls render styled.

- [ ] **Canonicalize on one card + reserve glass to the shell**
  - Files: `src/shared/styles/globals.css` (`.card*`, `.glass-panel`), call sites (~33 files)
  - Do: standardize on one card component; keep `.glass-panel` only in the dashboard shell/menus/flagship
    cards; use flat card elsewhere.
  - Verify: `grep -rln "glass-panel" src` lists only shell/menu files; card idioms reduced to one.

- [ ] **Remove `!important` from the core stylesheet**
  - Files: `src/shared/styles/globals.css`
  - Do: drop `!important` on `.card`/`.card-premium-glow` (border/box-shadow) once the dual systems collapse.
  - Verify: `grep -c "!important" src/shared/styles/globals.css` → 0 (or a documented minimum); visual check.

- [ ] **Extract shared UI-state components**
  - Files: `src/shared/components/EmptyState.tsx`, `LoadingState.tsx`, `ErrorState.tsx` (new) + call sites
  - Do: extract the repeated empty/loading/error markup (billing/search/profile) into shared components.
  - Verify: reused in ≥3 modules; `pnpm test` still green.

- [ ] **Route hard-coded accent/focus through tokens**
  - Files: `src/modules/search/components/SearchPage.tsx`, `src/modules/builder-profile/components/OutreachCopilot.tsx`, `src/modules/builder-profile/components/PersonaCard.tsx`
  - Do: replace hard-coded accent/focus hex/rgb with `--color-bh-accent` / focus tokens.
  - Verify: `grep -n "#e07338\|rgba(224" src/modules/search/components/SearchPage.tsx` etc. → 0.

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
