# Design Modernization

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: nothing (it feeds the release audits — [`audit-visual-system`](../50-audit-visual-system/spec.md),
> [`audit-accessibility`](../48-audit-accessibility/spec.md), [`audit-conversion`](../51-audit-conversion/spec.md),
> [`audit-performance-qa`](../49-audit-performance-qa/spec.md))
> **Reality check**: the token core already exists and is good
> (`src/shared/styles/globals.css` — `bh-*` tokens + shadcn aliases + dark mode + focus rings +
> reduced-motion + skip link). The problem is an **unfinished dark→warm-light migration**: bespoke
> `.btn-*`/`.card*` classes coexist with shadcn `<Button>`/`<Card>` (`src/components/ui/button.tsx`),
> `.accent-neon` + its `UserMenu` switcher and `.text-gradient*` ship named PRODUCT.md anti-references,
> `__root.tsx` still emits dark-navy document metadata, and there is no `DESIGN.md` anchoring the target
> world.

> Source: this plan is the `$impeccable audit` (technical + critique lens) of the whole app, run
> 2026-07-23 (detector over `src/routes`+`src/modules`+`src/shared/components`, app-wide Explore
> inventory). Target world = the warm premium-**light** direction in [PRODUCT.md](../../../PRODUCT.md)
> (terracotta `#e07338` + cream); the legacy dark/neon/glass look is **evidence + anti-reference**,
> not a co-equal option.

## Problem

BuilderHunt is **functionally robust** (real empty/loading/error states, sane IA, strong a11y
foundations) but sits in an **unfinished visual migration**: two visual languages run at once — the
target warm-premium-light system and a leftover dark / neon / glass / gradient world. The failure is
not missing features; it is **inconsistency and drift** (dual component systems, token bypasses,
brand-mark mismatch), which is why similar screens feel different and the migration keeps stalling.

## Goal

Converge the whole app onto one coherent, product-specific warm-premium-light system: one canonical
token + component set, the dark/neon/glass anti-references removed, the typography expressing "numbers
are the hero," and a written `DESIGN.md` anchor so the world can't drift again. Verifiable by the
`$impeccable audit` health score rising from **12/20** and the P1 findings below closing.

## Non-goals

- No functional/behavioral changes: content, routes, data, auth, and features stay as-is.
- Not a full rebrand: the warm-light direction is already chosen in PRODUCT.md; this executes it.
- Not the recurring release audits themselves (`audit-*` plans own the ongoing gates); this is the
  one-time remediation that clears their current backlog of visual/theming debt.

## Audit health score (baseline, 2026-07-23)

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 3/4 | Strong foundations; weakened by focus/accent colors hard-coded outside tokens |
| 2 | Performance | 2/4 | `backdrop-blur` glass in ~33 files + infinite marquee/glow-pulse |
| 3 | Responsive Design | 3/4 | Generally adaptive; isolated onboarding sticky-blur risk |
| 4 | Theming | 2/4 | Excellent token core, but dual component systems + hex bypasses + dark metadata leftover |
| 5 | Implementation Integrity | 2/4 | Detector near-clean, but 5 card + 6 button variants **plus** shadcn, one undefined class, brand mismatch |
| **Total** | | **12/20** | **Acceptable — significant work needed (band 10–13)** |

### Implementation-integrity verdict — PARTIAL FAIL

Does not yet express one coherent product-specific system: bespoke `.btn-*` (6 variants, 154 uses /
43 files) + shadcn `<Button>` + `LinkButton` + raw `<button>`; 5 card idioms
(`.card`/`.card-glow`/`.card-premium-glow`/`.card-hover` + `.glass-panel` in ~33 files); and
`btn-icon` used in [roadmap.tsx](../../src/routes/_dashboard/admin/roadmap.tsx) but **undefined** in CSS.

## Findings by severity

**Counts: P0 0 · P1 6 · P2 6 · P3 3.**

### P1 — Major

- **[P1] Dark document metadata leftover** · [__root.tsx](../../src/routes/__root.tsx#L21) L21–L30:
  `color-scheme: dark`, `theme-color: #0a0e17` (the "flat navy" anti-reference), `msapplication-TileColor: #0a0e17`,
  no override → wrong native chrome + dark flash app-wide.
- **[P1] Neon accent shipped + user switcher** · `.accent-neon` in globals.css +
  [UserMenu.tsx](../../src/modules/dashboard/components/UserMenu.tsx) — "neon accents" is a named
  PRODUCT.md anti-reference, now a production toggle.
- **[P1] Brand-mark off-palette** · [BrandLogoMark.tsx](../../src/shared/components/BrandLogoMark.tsx#L7)
  uses a blue/purple gradient, not terracotta.
- **[P1] Gradient text** · `.text-gradient*` in globals.css violates PRODUCT.md "no gradient text"
  and hard-codes hex (dark-mode-broken).
- **[P1] Component-system drift** · dual button/card systems + undefined `btn-icon` (integrity verdict).
- **[P1] Hard-coded accent/focus outside tokens** · [SearchPage.tsx](../../src/modules/search/components/SearchPage.tsx#L661)
  L661/L790, [OutreachCopilot.tsx](../../src/modules/builder-profile/components/OutreachCopilot.tsx#L144) L144/L199,
  [PersonaCard.tsx](../../src/modules/builder-profile/components/PersonaCard.tsx#L106).

### P2 — Minor

- **[P2] `!important` specificity war** · globals.css `.card`, `.card-premium-glow`.
- **[P2] Glass/blur over-scoped** · `.glass-panel` in ~33 files vs "shell only" intent.
- **[P2] Monospace bleeding into marketing/discovery** · [HomePage.tsx](../../src/modules/landing/components/HomePage.tsx#L204) L204/L409, [SearchPage.tsx](../../src/modules/search/components/SearchPage.tsx#L676) — dev-tool anti-reference.
- **[P2] Landing motion over hierarchy** · [HomePage.tsx](../../src/modules/landing/components/HomePage.tsx#L25) L25/L107/L444/L477.
- **[P2] OG share card uses dead navy** · [api/og/explore.tsx](../../src/routes/api/og/explore.tsx#L38) (`#0a0e17`).
- **[P2] Duplicated UI-state blocks** · repeated empty/loading/error markup across billing/search/profile.

### P3 — Polish

- **[P3] Generic body typeface + no display face** · [__root.tsx](../../src/routes/__root.tsx#L71)
  loads Inter + JetBrains Mono only; PRODUCT.md wants "numbers are the hero (large serif/display
  figures)" — no serif/display face exists.
- **[P3] Admin still a distinct nav block** · [UserMenu.tsx](../../src/modules/dashboard/components/UserMenu.tsx#L150).
- **[P3] Onboarding sticky blur bottom bar** · [onboarding/save.tsx](../../src/routes/onboarding/save.tsx#L211).

### Verified false positive

Detector `broken-image` at [api/og/explore.tsx](../../src/routes/api/og/explore.tsx#L128) is an OG-image
template (satori/SVG with a raster→SVG fallback), not a shipped broken `<img>`. No action.

## Systemic patterns

1. **Unfinished migration is the root cause** — treat convergence as one program, not scattered fixes.
2. **Token core is good; the perimeter leaks** (hex, `!important`, undefined classes).
3. **Duplication over absence** — too many ways to build the same thing.
4. **No `DESIGN.md`** — nothing declares "this is canonical, that is debt."

## Positive findings (keep and replicate)

- Serious a11y baseline (focus rings WCAG 2.4.7, skip link 2.4.1, reduced-motion, AA token comments).
- Thoughtful token architecture (semantic `bh-*` + shadcn aliased onto them).
- Real states everywhere (search/profile/billing/auth).
- IA already moved right (admin/settings out of the topbar into the user menu).

## Target world / architecture

- **One token source of truth**: `src/shared/styles/globals.css` `bh-*` + shadcn aliases. No raw
  hex in components; no `!important`.
- **One component of each kind**: shadcn `<Button>`/`<Card>`/`<Badge>`/`<Input>` as canonical; the
  bespoke `.btn-*`/`.card*` families retired; shared `<EmptyState>`/`<LoadingState>`/`<ErrorState>`.
- **Glass reserved** to the dashboard shell/menus/flagship cards only; flat `.card` elsewhere.
- **Typography**: a display/serif face for hero numbers; a body face with more character than Inter;
  monospace only for code/keys.
- **`DESIGN.md`** authored as the canonical warm-light world (currently missing).

## Success metrics

- `$impeccable audit` health score rises from 12/20 (target ≥16/20); all six P1 closed.
- `grep` proves the anti-references are gone: `accent-neon`, `text-gradient`, `#0a0e17`, `btn-icon` → 0
  live uses.
- One button/card component family in use (bespoke `.btn-*`/`.card*` retired or reduced to a thin shim).
- `DESIGN.md` exists and `context.mjs` resolves it as the visual truth.

## Resolved edge cases

- **Existing subscribers/screens**: purely visual — no behavior, copy, or data changes, so nothing to
  migrate at the data layer.
- **Dark mode stays**: the `.dark` theme is kept; only the *default/document* chrome stops being dark
  and the neon accent is removed.
- **Incremental safety**: converge one component family at a time; the app stays shippable between
  waves (see plan.md).
