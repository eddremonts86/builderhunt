# Design Modernization — Tasks

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: nothing (feeds [`audit-visual-system`](../audit-visual-system/spec.md),
> [`audit-accessibility`](../audit-accessibility/spec.md), [`audit-conversion`](../audit-conversion/spec.md),
> [`audit-performance-qa`](../audit-performance-qa/spec.md))
> **Reality check**: token core in `src/shared/styles/globals.css`; bespoke `.btn-*`/`.card*` coexist
> with shadcn `src/components/ui/button.tsx`; anti-references in `__root.tsx`, `.accent-neon`,
> `.text-gradient*`, `BrandLogoMark.tsx`. Baseline `$impeccable audit` = 12/20. Visual-only work.

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

- [ ] **Typeset — display/serif for hero numbers, de-genericize body**
  - Files: `src/routes/__root.tsx` (font links), `src/shared/styles/globals.css` (font tokens), stat/number components
  - Do: add a display/serif face for large figures ("numbers are the hero"); pick a body face with more
    character than Inter (metrics-compatible).
  - Verify: display face loads + is applied to stat figures; `$impeccable audit` no longer flags `overused-font`.

- [ ] **Contain monospace to code/keys**
  - Files: `src/modules/landing/components/HomePage.tsx`, `src/modules/search/components/SearchPage.tsx`
  - Do: remove `font-mono` from marketing/discovery copy; keep it only for `.kbd`/code.
  - Verify: `grep -rn "font-mono" src/modules/landing src/modules/search` → only true code/key uses.

- [ ] **Tame landing motion to serve conversion**
  - Files: `src/modules/landing/components/HomePage.tsx`
  - Do: cut entrance/marquee/pulse to purposeful reveals; slow or pause-on-idle the marquee.
  - Verify: visual review; reduced-motion still degrades cleanly.

- [ ] **Cut glass/blur + infinite-animation footprint**
  - Files: `src/shared/styles/globals.css`, glass call sites
  - Do: reduce `backdrop-filter` surfaces and infinite animations outside the shell.
  - Verify: `grep -rln "glass-panel\|backdrop-filter" src | wc -l` decreases materially; frame check.

- [ ] **Re-audit and polish**
  - Files: — (verification)
  - Do: run `$impeccable audit`, then `$impeccable polish` for the final coherence pass.
  - Verify: health score ≥ 16/20; `pnpm lint`, `pnpm type-check`, `pnpm build` green.
