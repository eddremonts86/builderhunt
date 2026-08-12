# Homing-page content and sections — Tasks

> **Status**: `pending`
> **Spec**: [`spec.md`](./spec.md)
> **Plan**: [`plan.md`](./plan.md)
> **Rule**: a task is complete only after its runtime verification passes AND the page-size
> gate (`scripts/audit/check-landing-budget.ts`) stays green.
> **Depends on**: nothing in the same phase. Reads [`app-reality`](../../_meta/app-reality.md)
> for the ground truth on what is shipped today and what the home page is allowed to claim. Reads
> every plan under `plans/` to know what is coming so the home page can advertise it honestly.
> **Blocks**: nothing. Pure landing-page rewrite — no schema, no API, no migration.
> **Reality check**: the current landing (`src/modules/landing/components/HomePage.tsx`) is a single
> 600+ line file grown across three redesign passes, advertising only the discovery loop and a
> 4-persona grid. It does not mention teams, sprints, alerts as a first-class surface, notes,
> exports, RSS, claimable profiles, outreach, enrichment, AI helpers, the credit ledger, semantic
> search, or the phase-4 queue — see [`spec.md`](./spec.md) for the full list.

## Phase 0 — Read and inventory

- [ ] **Write `landing-copy/00-inventory.md`** with one row per home-page claim.
  - Files: `landing-copy/00-inventory.md`
  - Do: For every claim on the current home (`src/modules/landing/components/HomePage.tsx`)
    plus every claim this plan proposes adding, write a row: `claim | evidence (file:line) |
    plan path | shipped | coming soon |`.
  - Verify: every row's `evidence` resolves to a real file or plan path via `ls` / `grep -r`.

- [ ] **Write the persona copy variants table**
  - Files: `landing-copy/01-hero.md` (top section)
  - Do: Four persona variants (`hiring`, `investing`, `building`, `other`) × three text
    blocks (hero sub-paragraph, persona-tabs headline, CTA strip).
  - Verify: every persona has a value for every block; default `hiring` matches the current
    home copy exactly so the persona switch is invisible-by-default.

## Phase 1 — Copy draft

- [ ] **Draft `landing-copy/01-hero.md`**
  - Files: `landing-copy/01-hero.md`
  - Do: Hero eyebrow, headline, sub-paragraph (with persona variants), CTA microcopy.
  - Verify: every line grounded in the inventory; no invented numbers.

- [ ] **Draft `landing-copy/02-features-refresh.md`**
  - Files: `landing-copy/02-features-refresh.md`
  - Do: Refresh copy for the six existing bento feature cards plus the "13 sources" claim
    in the Sources strip.
  - Verify: "13 sources" becomes "12 sources + semantic search" with a link to
    `src/lib/sources/index.ts` for the live count.

- [ ] **Draft `landing-copy/03-pipeline.md`**
  - Files: `landing-copy/03-pipeline.md`
  - Do: Section header + three cards (Keyword alerts, AI sourcing sprints, Team shortlists)
    with one-line copy each.
  - Verify: every cited plan path exists; every status claim matches the plan's
    `Status` header.

- [ ] **Draft `landing-copy/04-ai-helpers.md`**
  - Files: `landing-copy/04-ai-helpers.md`
  - Do: Section header + five tiles (Semantic search, AI sourcing sprints, AI outreach
    copilot, AI profile enrichment, AI CV generation) with status badge, plan path, credit
    cost, and one-line copy.
  - Verify: status badge matches the plan's `Status`; credit cost matches the plan's
    billing section or is `included in plan`.

- [ ] **Draft `landing-copy/05-roadmap.md`**
  - Files: `landing-copy/05-roadmap.md`
  - Do: 8 items, each with `plan name — one-line why — Coming soon`. The plan-name link
    points to the matching `plans/phase-1/<dir>/spec.md` or `plans/phase-4/<dir>/spec.md`.
  - Verify: every link target exists; order matches the priority list in `spec.md`.

## Phase 2 — New sections

- [ ] **Build `PipelineSection` component**
  - Files: `src/modules/landing/components/PipelineSection.tsx`,
    `src/modules/landing/components/PipelineSection.test.tsx`
  - Do: Read copy from `landing-copy/03-pipeline.md`. Three cards in a
    `md:grid-cols-2 lg:grid-cols-3` bento. Each card uses the existing `liquid-glass`
    panel style. Status badges match the inventory (`Shipped`, `Coming soon`).
  - Verify: `pnpm vitest run tests/unit/modules/landing/components/PipelineSection.test.tsx`
    passes; rendered copy matches the draft.

- [ ] **Build `AiHelpersSection` component**
  - Files: `src/modules/landing/components/AiHelpersSection.tsx`,
    `src/modules/landing/components/AiHelpersSection.test.tsx`
  - Do: Read copy from `landing-copy/04-ai-helpers.md`. Five tiles in a 2/3-column grid
    (smaller tiles than Pipeline because the count is higher). Each tile carries a status
    badge, plan path as `data-testid`, credit cost, and one-line copy.
  - Verify: test pins the rendered copy and the status badge of each tile.

- [ ] **Build `RoadmapSection` component**
  - Files: `src/modules/landing/components/RoadmapSection.tsx`,
    `src/modules/landing/components/RoadmapSection.test.tsx`
  - Do: Read copy from `landing-copy/05-roadmap.md`. Eight items in a single column. Each
    item is a link to the cited plan's `spec.md`. No `Coming soon` badge inline; the badge
    is the section-level "Coming soon" eyebrow.
  - Verify: every link's `href` matches a real plan path; render test snapshots the eight
    items in order.

- [ ] **Wire the new sections into `HomePage.tsx`**
  - Files: `src/modules/landing/components/HomePage.tsx`
  - Do: Insert `<PipelineSection />`, `<AiHelpersSection />`, `<RoadmapSection />` in the
    order established in `spec.md`. No other change to `HomePage.tsx` in this commit.
  - Verify: page-size gate passes (see Phase 4). Visual: each section renders in the
    expected position via `browser_navigate`.

## Phase 3 — Persona switch

- [ ] **Add `?persona=` query parameter to the home route**
  - Files: `src/routes/_landing/index.tsx` (or wherever the home route is defined)
  - Do: Read `persona` via `useSearch({ from: '/' })`. Default `hiring`. Pass to the
    hero, persona-tabs, and closing-CTA components as a prop. SSR-safe default: the
    server renders the `hiring` variant; the client swaps if the query differs.
  - Verify: server-rendered HTML matches the default `hiring` variant. Client-side swap
    on navigation does not flash.

- [ ] **Add the persona-switch UI**
  - Files: `src/modules/landing/components/PersonaSwitcher.tsx`
  - Do: A small radio group below the hero sub-paragraph, four options, hidden by default
    behind a "Different goal?" text link. Picking one navigates to `?persona=X`.
  - Verify: keyboard accessible; ARIA roles correct; default `hiring` is the
    `aria-pressed` choice.

- [ ] **Render persona variants**
  - Files: `src/modules/landing/components/HomePage.tsx`,
    `src/modules/landing/components/HeroGlass.tsx`,
    `src/modules/landing/components/ClosingCta.tsx`
  - Do: Three text blocks per persona variant. Everything else on the page is identical.
  - Verify: `browser_navigate ?persona=hiring|investing|building|other` swaps exactly three
    blocks per page.

## Phase 4 — Page-size gate

- [ ] **Write `scripts/audit/check-landing-budget.ts`**
  - Files: `scripts/audit/check-landing-budget.ts`
  - Do: Sibling of `check-dashboard-budgets.ts`. Reads baseline JSON at
    `docs/ui-audit/evidence/landing-baseline/metrics-<date>.json`. Fails when desktop or
    mobile viewport-height exceeds budget by > 0.2.
  - Verify: gate runs end-to-end; exits non-zero when the budget is over.

- [ ] **Wire the gate into `pnpm audit:landing`**
  - Files: `package.json`
  - Do: Add `"audit:landing": "tsx --env-file-if-exists=.env scripts/audit/check-landing-budget.ts"`
    to the `scripts` block.
  - Verify: `pnpm audit:landing` runs the gate and exits with the correct code.

- [ ] **Document the gate**
  - Files: `docs/operations/development.md`
  - Do: Append a "Landing page budget" section next to the existing "Dashboard baseline"
    entry. State the budgets, the walker script, and the failure threshold.
  - Verify: `grep -nE "Landing page budget|10\.8|20\.1" docs/operations/development.md`
    returns the new lines.

## Phase 5 — Visual regression baseline

- [ ] **Write `scripts/audit/landing-walk.ts`**
  - Files: `scripts/audit/landing-walk.ts`
  - Do: For each viewport (desktop 1440, desktop dark 1440, mobile 320), navigate to each
    persona variant (`?persona=hiring|investing|building|other`). Capture a screenshot per
    persona per viewport. Write the metrics JSON and the screenshots under
    `docs/ui-audit/evidence/landing-baseline/`.
  - Verify: walker runs end-to-end; 12 screenshots + 1 metrics JSON land in the evidence
    directory.

- [ ] **Capture the baseline**
  - Files: `docs/ui-audit/evidence/landing-baseline/`
  - Do: Run `pnpm tsx --env-file-if-exists=.env scripts/audit/landing-walk.ts`. The output
    becomes the first landing baseline. Future runs diff against this.
  - Verify: `ls docs/ui-audit/evidence/landing-baseline/{desktop-light,desktop-dark,mobile-375}`
    shows four PNGs per directory.

## Phase 6 — Deploy gates

- [ ] **Add `landing-walk.ts` to the CI gate**
  - Files: `package.json`, `.github/workflows/quality.yml`
  - Do: Wire `landing-walk.ts` and `check-landing-budget.ts` into `ci:local` and the CI
    workflow. Both gates are required.
  - Verify: `pnpm ci:local` runs end-to-end with all gates green.

- [ ] **Document the gates**
  - Files: `docs/operations/development.md`
  - Do: Append the new entries next to the existing dashboard-budget gates entry.
  - Verify: the gates section references both files by path.

## Final cross-plan reconciliation

- [ ] **Verify the plan against `app-reality.md`**
  - Files: `plans/phase-2/08-homing-page-content-and-sections/spec.md`
  - Do: Re-read every claim in the spec against the latest `app-reality.md`. A claim with no
    ground-truth backing is removed.
  - Verify: every claim in `spec.md` resolves to either a `src/` feature, a `plans/` plan
    path, or the `Coming soon` label with a plan path.

- [ ] **Close the plan**
  - Files: `plans/phase-2/08-homing-page-content-and-sections/`
  - Do: Update the `Status:` header in each of `spec.md`, `plan.md`, `tasks.md` to
    `implemented` or `closed` with a dated implementation note.
  - Verify: every `[ ]` in `tasks.md` is checked; the plan header reflects the final state.
