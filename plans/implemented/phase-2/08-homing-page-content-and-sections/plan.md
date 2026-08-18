# Homing-page content and sections — Delivery Plan

> **Status**: `implemented` — 2026-08-18
> **Depends on**: nothing in the same phase. Reads [`app-reality`](../../../_meta/app-reality.md)
> for the ground truth on what is shipped today and what the home page is allowed to claim. Reads
> every plan under `plans/` to know what is coming so the home page can advertise it honestly.
> **Blocks**: nothing. Pure landing-page rewrite — no schema, no API, no migration.
> **Reality check**: the current landing (`src/modules/landing/components/HomePage.tsx`) is a single
> 600+ line file grown across three redesign passes, advertising only the discovery loop and a
> 4-persona grid. It does not mention teams, sprints, alerts as a first-class surface, notes,
> exports, RSS, claimable profiles, outreach, enrichment, AI helpers, the credit ledger, semantic
> search, or the phase-4 queue — see [`spec.md`](./spec.md) for the full list.

## Delivery principles

1. **Read the ground truth before writing the page.** `plans/_meta/app-reality.md` is the
   only allowed source of "is this shipped?" answers. The walker evidence
   (`docs/ui-audit/evidence/walk-summary.json`) is the only allowed source of "how does the
   current page look?" answers.
2. **One section per commit.** Each of the four new sections (Pipeline, AI helpers, Roadmap,
   Persona switch) ships in its own commit. The copy-refresh commits follow the same rule
   per section. A bad section is reverted on its own.
3. **Page-size budget enforced at the wire.** The landing never grows beyond 1.5× current
   footprint. The gate is a sibling script to `check-dashboard-budgets.ts`. If a section
   blows the budget, that section is the one reverted, not the others.
4. **No imagery, no illustration, no new icons.** The page is text + the existing
   `liquid-glass` panel style. If a section needs an illustration, it goes on the
   `image-to-code` backlog, not this plan.

## Dependency map

```
A ["Phase 0: read & inventory"] --> B ["Phase 1: copy draft"]
B --> C ["Phase 2: new sections"]
C --> D ["Phase 3: persona switch"]
D --> E ["Phase 4: page-size gate"]
E --> F ["Phase 5: visual regression baseline"]
F --> G ["Phase 6: deploy gates"]
```

## Phase 0 — Read and inventory

### Outcome

A single document, [`landing-copy/00-inventory.md`](./landing-copy/00-inventory.md), that lists
every claim the home page is allowed to make today, and every claim it must label
`Coming soon`.

### Work

- Read `app-reality.md` end-to-end and extract every `implemented`/`complete` feature.
- Read every plan's `Status` header across `plans/phase-1/`, `plans/phase-2/`,
  `plans/phase-4/` and extract every `pending` plan whose home-page teaser fits in one line.
- Read the current `src/modules/landing/components/HomePage.tsx` and list every claim in the
  existing copy, mapped to either a shipped feature or a wrong/outdated claim that needs to
  be fixed.
- Cross-reference the four landing personas (`phase-2/README.md`) and write the
  persona-specific copy variants.

### Verify

`landing-copy/00-inventory.md` exists, has one row per claim, and every row resolves to a
plan path in `plans/` or a feature path in `src/`.

## Phase 1 — Copy draft

### Outcome

Four markdown files in `landing-copy/`:

- [`01-hero.md`](./landing-copy/01-hero.md) — hero sub-paragraph for each persona, eyebrow,
  and CTA microcopy.
- [`02-features-refresh.md`](./landing-copy/02-features-refresh.md) — copy refresh for the
  six existing bento feature cards.
- [`03-pipeline.md`](./landing-copy/03-pipeline.md) — `Pipeline` section copy.
- [`04-ai-helpers.md`](./landing-copy/04-ai-helpers.md) — `AI helpers` section copy.
- [`05-roadmap.md`](./landing-copy/05-roadmap.md) — `Roadmap` section copy.

### Work

- Draft each file using the inventory as the only source of truth.
- Every numeric claim cites its plan path.
- Every "Coming soon" label cites its plan path.
- Persona variants live in `01-hero.md` as a table.

### Verify

Each file's claims resolve via `grep` to the cited path. The persona table covers all four
landing personas plus the default.

## Phase 2 — New sections

### Outcome

The three new sections land in `HomePage.tsx` as additive components, each in its own
sub-file:

- `src/modules/landing/components/PipelineSection.tsx`
- `src/modules/landing/components/AiHelpersSection.tsx`
- `src/modules/landing/components/RoadmapSection.tsx`

The `HomePage.tsx` imports them in the order established in `spec.md`.

### Work

- Each section is its own component file so future re-orderings do not touch
  `HomePage.tsx`'s surface area.
- Each section reuses the existing `liquid-glass` panel style from `HeroGlass.tsx`. No new
  CSS unless the bento grid requires it; in that case, the CSS is appended to
  `src/shared/styles/globals.css` under a clearly-marked `/* homing-page-section */` block.
- Each section renders data from a typed props object; no inline literals in JSX.

### Verify

`pnpm type-check` clean. `pnpm vitest run` 100% green (no new tests in this phase). The
component files each have a sibling `*.test.tsx` that pins the rendered copy.

## Phase 3 — Persona switch

### Outcome

A `?persona=` query parameter on the home page swaps the persona-aware copy in three
places: hero sub-paragraph, persona-tabs section heading, closing CTA strip. Default
`hiring`.

### Work

- `HomePage.tsx` reads `useSearch({ from: '/' })` for `persona` and passes the value to
  `<Hero>`, `<PersonaTabs>`, and `<ClosingCta>` as a prop.
- The switch UI is a small radio group below the hero sub-paragraph, four options, hidden by
  default. Picking one navigates to `?persona=X`. The radio is `aria-pressed`-true when
  matching the current `persona` query param.
- The radio group is opt-in: it does not appear until the visitor clicks a "Different goal?"
  text link. Default behaviour is unchanged from today (no toggle visible).

### Verify

`browser_navigate` to `?persona=hiring`, `?persona=investing`, `?persona=building`,
`?persona=other`. Three text blocks per page differ; the rest of the page is identical.

## Phase 4 — Page-size gate

### Outcome

`scripts/audit/check-landing-budget.ts` runs as part of `pnpm audit:landing` and
`pnpm ci:local`. It fails when the rendered viewport-height on desktop 1440 or mobile 320
exceeds the budget by > 0.2 viewports.

### Work

- The script is a sibling of `check-dashboard-budgets.ts`. It uses the same walker
  infrastructure (Playwright + viewport emulation) and reads a baseline JSON at
  `docs/ui-audit/evidence/landing-baseline/metrics-<date>.json`.
- The walker navigates to `?persona=hiring` on desktop 1440 and mobile 320, scrolls the
  full page once, and measures `document.body.scrollHeight / window.innerHeight` in
  viewport heights.
- Budgets: desktop ≤ 10.8, mobile ≤ 20.1. Fail above by > 0.2.
- The script reads `app-reality.md` to verify the source-count claim matches the live
  `src/lib/sources/index.ts` registry.

### Verify

Run after every commit in phase 2 and 3. Exit non-zero on any budget violation.

## Phase 5 — Visual regression baseline

### Outcome

A baseline screenshot set under `docs/ui-audit/evidence/landing-baseline/desktop-light/`,
`docs/ui-audit/evidence/landing-baseline/desktop-dark/`, and
`docs/ui-audit/evidence/landing-baseline/mobile-375/` for each persona variant
(`?persona=hiring|investing|building|other`).

### Work

- Extend `scripts/audit/saas-review-walk.ts` (or write a sibling script
  `scripts/audit/landing-walk.ts`) to capture the landing page once per persona per viewport.
- The walker writes the screenshots and a `metrics-<date>.json` to
  `docs/ui-audit/evidence/landing-baseline/`.
- Future runs diff the screenshots against the baseline. The diff budget is 5% pixel
  difference per section.

### Verify

`ls docs/ui-audit/evidence/landing-baseline/` lists three directories, each with 4
persona-variant screenshots plus a `metrics-<date>.json`.

## Phase 6 — Deploy gates

### Outcome

`pnpm ci:local` runs `check-dashboard-budgets.ts`, `check-landing-budget.ts`, the walker, and
`pnpm vitest run`. Each gate is required; the deploy hook does not advance on a failure.

### Work

- Add `pnpm audit:landing` to `package.json` running `check-landing-budget.ts`.
- Add `landing-walk.ts` to the CI gate.
- Document the new gates in `docs/operations/development.md` next to the existing
  `dashboard-budgets` entry.

### Verify

`pnpm ci:local` runs end-to-end with all four new gates. Every gate is green before this plan
is complete.

## Order of commits

```
feat(landing): homing-page Phase 0 — inventory & copy drafts
feat(landing): Pipeline section
feat(landing): AI helpers section
feat(landing): Roadmap section
feat(landing): ?persona= switch
feat(landing): copy refresh on hero + bento + sources
feat(audit): landing-page budget gate
feat(audit): landing-page visual regression baseline
docs(audit): landing-baseline metrics in development.md
```

Nine commits, all reversible on their own. The copy-refresh commit lands **last** because
the prior commits establish the inventory and section structure that the copy references.

## Risks

1. **Page-size budget**: the new sections push the page from 7.2 to ~10.9 desktop viewports.
   Margin is 0.1. A surprise 100 px in any bento card blows the budget. Mitigation:
   commit-level budget check after every section commit; revert the over-budget section, not
   the others.
2. **Persona switch breaks SSR**: `useSearch` runs on the client. If the landing is SSR'd
   (it is — `src/routeTree.gen.ts` confirms), the persona param must default to `hiring` on
   the server and only swap on the client. Mitigation: the default `hiring` matches the
   current copy exactly, so no visible change for the default path.
3. **Roadmap section goes stale**: every plan status change requires a landing change.
   Mitigation: the section renders from `landing-copy/05-roadmap.md`, which is a small file
   the maintainer can refresh in one commit when a plan transitions out of `pending`.

## Rollback

Each phase is a single commit. Reverting any one returns the landing to its pre-phase state.
The plan author runs `git revert <commit-hash>` for the offending phase; the rest of the
landing is unaffected.
