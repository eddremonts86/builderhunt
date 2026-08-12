# Design Modernization — Delivery Plan

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: nothing (feeds [`audit-visual-system`](../50-audit-visual-system/spec.md),
> [`audit-accessibility`](../48-audit-accessibility/spec.md), [`audit-conversion`](../51-audit-conversion/spec.md),
> [`audit-performance-qa`](../49-audit-performance-qa/spec.md))
> **Reality check**: converges the existing UI onto the `src/shared/styles/globals.css` token core;
> removes the dark/neon/glass/gradient migration debt catalogued in [`spec.md`](./spec.md). Visual-only —
> no behavior, content, or data changes.

## Guiding principles

1. **Anchor first.** Write `DESIGN.md` before converging, so "canonical vs debt" is decidable.
2. **Converge one family at a time.** The app stays shippable at every checkpoint.
3. **Remove, don't re-skin.** Retire the anti-references (neon, gradient text, dark metadata) rather
   than polishing the discarded look.
4. **Tokens only.** Every color/spacing/radius resolves through `bh-*`/shadcn tokens; no raw hex, no
   `!important` in components.
5. **Behavior frozen.** Content, routes, data, and features are untouched.

## Phases (dependency order)

### Wave 1 — Anchor + kill the loudest debt (P1)
Goal: stop shipping the anti-references and give the migration a written target.
1. Author `DESIGN.md` (target warm-light world) via `$impeccable document`.
2. Fix `__root.tsx` document metadata (`color-scheme`, `theme-color`, `TileColor`) → warm brand.
3. Remove `.accent-neon` + its `UserMenu` switcher; recolor `BrandLogoMark`; retire `.text-gradient*`;
   repaint the OG templates. (`$impeccable quieter` lens.)

### Wave 2 — Converge the system (P1/P2)
Goal: one button, one card, one badge, one input; tokens everywhere.
4. Canonicalize on shadcn primitives; retire bespoke `.btn-*`/`.card*`; define/delete `btn-icon`;
   extract shared `<EmptyState>`/`<LoadingState>`/`<ErrorState>`. (`$impeccable extract`.)
5. Remove `!important`; collapse duplicate card idioms; reserve `.glass-panel` to the shell.
   (`$impeccable distill`.)
6. Route all hard-coded accent/focus hex through tokens (search/profile).

### Wave 3 — Elevate + verify (P2/P3)
Goal: make it feel authored, then prove the score moved.
7. Introduce a display/serif face for hero numbers; de-genericize the body face; contain monospace.
   (`$impeccable typeset`.)
8. Tame landing motion/marquee to serve conversion. (`$impeccable quieter` + `layout`.)
9. Cut backdrop-blur/glass footprint + infinite animations. (`$impeccable optimize`.)
10. Re-run `$impeccable audit`; finish with `$impeccable polish`.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Retiring `.btn-*`/`.card*` visually regresses many screens at once | Medium | High | Converge one family at a time; keep a thin compat shim mapping old classes to the canonical component until call sites migrate; visual-diff each module |
| Removing neon/gradient surprises users who used the toggle | Low | Low | It is an anti-reference experiment, not a promised feature; remove quietly, no migration needed |
| Typography change shifts layout (metrics) | Medium | Medium | Pick a display face with similar metrics; adjust number components only, test wrapping |
| `!important` removal breaks specificity somewhere | Medium | Medium | Remove only after the dual systems collapse; rely on Tailwind layer order; visual check per surface |
| Touching `__root.tsx` head affects SEO/OG | Low | Medium | Only color/theme metadata changes; leave SEO/OG structure intact; verify OG render |
| Scope creep into behavior changes | Low | Medium | Explicit non-goal; visual-only diffs; no data/route edits |

## Rollback plan

- Every change is visual and additive-or-swap; **revert per commit** (one commit per wave-step) with
  no data implications.
- `DESIGN.md` is a new file — deleting it is safe.
- The compat shim lets a half-migrated component family be rolled back to the bespoke classes instantly.
- No migrations, no env changes, no API changes — rollback is pure `git revert`.

## Definition of done

- `$impeccable audit` ≥ 16/20; all six P1 closed.
- `grep` proves `accent-neon` / `text-gradient` / `#0a0e17` / undefined `btn-icon` → 0 live uses.
- One canonical button + card family in use; `DESIGN.md` exists and `context.mjs` resolves it.
- `pnpm lint`, `pnpm type-check`, `pnpm build` green; no behavioral test regressions.
