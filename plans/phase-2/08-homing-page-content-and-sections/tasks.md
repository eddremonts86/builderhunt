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

- [x] **Write `landing-copy/00-inventory.md`** with one row per home-page claim.
  - Files: `landing-copy/00-inventory.md`
  - Do: For every claim on the current home (`src/modules/landing/components/HomePage.tsx`)
    plus every claim this plan proposes adding, write a row: `claim | evidence (file:line) |
    plan path | shipped | coming soon |`.
  - Verify: every row's `evidence` resolves to a real file or plan path via `ls` / `grep -r`.
  - Result: the file already existed; running its own verification is what the task was worth. Two of
    seventeen `src/…` paths did not resolve — `src/lib/sources/index.ts`, which has never existed at
    that path, and `src/routes/api/feeds/$searchId.xml`, where `.xml` is the URL and `.ts` is the
    module. Both corrected, and all seventeen now resolve on disk.
  - **The source-count row was wrong in four ways at once**: it said 12, listed `sourcehut` and
    `hashnode` — retired 2026-08-04 by drizzle/0143 and 0144 — omitted `devpost`, `producthunt` and
    `bluesky`, and cited a file that does not exist. The real count is 13, and the row now says the
    count is **never a literal**: copy derived from it must interpolate `SEARCH_SOURCE_COUNT`, the way
    `segment-pages.ts` already does. Nine surfaces once hardcoded "12 sources" and all nine went stale
    on the same day, which is the whole reason that constant exists.
  - The verification is a ten-line script over the table's backticked paths, not a read-through. A
    document whose job is to be the ground truth for twenty-two other tasks had a broken first row,
    and reading it carefully is exactly what had already failed to catch that.

- [x] **Write the persona copy variants table**
  - Files: `landing-copy/01-hero.md` (top section)
  - Do: Four persona variants (`hiring`, `investing`, `building`, `other`) × three text
    blocks (hero sub-paragraph, persona-tabs headline, CTA strip).
  - Verify: every persona has a value for every block; default `hiring` matches the current
    home copy exactly so the persona switch is invisible-by-default.
  - Result: the 4 × 3 table at the top of `landing-copy/01-hero.md`. The `hiring` column was copied
    out of `HomePage.tsx` string by string rather than written from memory — that column *is* the
    shipped page, which is what makes the switch invisible to anyone arriving without `?persona=`.
  - The four are `USER_SEGMENTS` from `user-segments.ts`, not categories invented for this page. A
    fifth would be a taxonomy the goal step and the dashboard presets do not honour. `other` repeats
    `hiring` on purpose: `resolveSegmentPreset` maps it to the general experience, and a variant
    written for somebody who declined to say is copy addressed to nobody.
  - **The CTA paragraph is deliberately not persona-varied.** `HomePage.tsx` carries the reason beside
    it: `ACCESS_ALLOWLIST_ENABLED` gates sign-up behind an approval queue, so any wording promising
    immediate access is false whenever that flag is on — and it is on, in production and in
    `.env.example`. `trust-claims.test.ts` matches the raw component source, so the phrasing is a
    build-time constraint rather than a preference. Its nine forbidden patterns are listed in the file
    so the next person writing a variant does not have to rediscover them; the guard reads only
    `HomePage.tsx`, so listing them in a plan document is safe, and its 30 tests stay green.

## Phase 1 — Copy draft

- [x] **Draft `landing-copy/01-hero.md`**
  - Files: `landing-copy/01-hero.md`
  - Do: Hero eyebrow, headline, sub-paragraph (with persona variants), CTA microcopy.
  - Verify: every line grounded in the inventory; no invented numbers.
  - Result: the file had **two contradicting persona tables** — the one this plan's task 2 added and
    an earlier draft below it. Reconciled into one, with the closing CTA split out because it is the
    block with the most ways to become false.
  - Three claims failed "no invented numbers", and each fails differently, so all three are recorded
    in the file rather than quietly deleted:
    - *"Search 12 sources in under a minute"* — wrong (13) **and** a literal. `SEARCH_SOURCE_COUNT`
      exists because nine surfaces hardcoded 12 and all nine went stale the day two connectors were
      retired.
    - *"Claim your builder profile in under 3 minutes"* — nothing in the product times a claim. A
      number that sounds measured and was not.
    - *"Track 50 founders per workspace"* — **true**, `PLAN_LIMITS.free.savedBuilders` is 50, and
      still wrong to type by hand. That is the instructive one: a number that is right today and
      written by hand is a number that goes stale silently.
  - The default column remains `HomePage.tsx` string for string, so a visitor with no `?persona=`
    sees no change at all.

- [x] **Draft `landing-copy/02-features-refresh.md`**
  - Files: `landing-copy/02-features-refresh.md`
  - Do: Refresh copy for the six existing bento feature cards plus the "13 sources" claim
    in the Sources strip.
  - Verify: "13 sources" becomes "12 sources + semantic search" with a link to
    `src/lib/sources/index.ts` for the live count.
  - **This Verify clause was itself wrong** and is superseded. The live count is **13**, not 12; the
    file it names has never existed (the registry is `src/shared/lib/search-connectors.ts`); and the
    "+ semantic search" framing came from reading 13 as `12 + 1`. It is thirteen connectors.
  - Result: the count is **never a literal**. The card interpolates `SEARCH_SOURCE_COUNT` and the
    sources strip renders from `IMPLEMENTED_SEARCH_CONNECTORS`, so retiring a connector updates the
    page. The old strip still listed Hashnode and SourceHut, retired 2026-08-04 by drizzle/0143 and
    0144, and omitted Devpost, Product Hunt and Bluesky.
  - Also removed: "a 7-day decay window". `src/lib/score.ts` is a five-step ladder (30/22/12/5/1 by
    age), so the copy describes the shape and survives a retune instead of quoting one step.

- [x] **Draft `landing-copy/03-pipeline.md`**
  - Files: `landing-copy/03-pipeline.md`
  - Do: Section header + three cards (Keyword alerts, AI sourcing sprints, Team shortlists)
    with one-line copy each.
  - Verify: every cited plan path exists; every status claim matches the plan's
    `Status` header.
  - Result: all three plans resolve and **all three are in `plans/implemented/phase-1/`**. The draft
    badged Team shortlists `COMING SOON` and linked "to the plan, not to the feature" — the page would
    have advertised a shipped feature as unavailable. That is the failure nobody catches, because no
    reviewer audits a landing page for underselling.
  - The badge now derives from where the plan directory lives rather than from a hand-written status,
    and the sprint caps render from `SOURCING_SPRINT_LIMITS` instead of the draft's typed
    "Free: 0. Pro: 3. Team: 10" — right today, silent about `pro_max`, stale on the next change.

- [x] **Draft `landing-copy/04-ai-helpers.md`**
  - Files: `landing-copy/04-ai-helpers.md`
  - Do: Section header + five tiles (Semantic search, AI sourcing sprints, AI outreach
    copilot, AI profile enrichment, AI CV generation) with status badge, plan path, credit
    cost, and one-line copy.
  - Verify: status badge matches the plan's `Status`; credit cost matches the plan's
    billing section or is `included in plan`.
  - Result: four tiles link into `plans/implemented/phase-1/`, the fifth into `plans/phase-4/`, and
    every target resolves.
  - **The credit allowances were removed rather than corrected.** "Pro: 140 credits/month, Pro Max:
    700, Team: 2100" appears nowhere `grep -rn` reaches. They may well be right and written down
    somewhere else — they are not verifiable from this repository, which is the bar for a landing
    page. The header now says so and asks whoever restores them to cite the file. The section
    headline lost "Three cost credits, two do not" with them: that is arithmetic over numbers nobody
    can check.

- [x] **Draft `landing-copy/05-roadmap.md`**
  - Files: `landing-copy/05-roadmap.md`
  - Do: 8 items, each with `plan name — one-line why — Coming soon`. The plan-name link
    points to the matching `plans/phase-1/<dir>/spec.md` or `plans/phase-4/<dir>/spec.md`.
  - Verify: every link target exists; order matches the priority list in `spec.md`.
  - Result: all seven `phase-4/…/spec.md` targets resolve, and every item is now a real link rather
    than a bare path in parentheses.
  - **It was seven items, not eight.** Solutions Intelligence is
    `plans/implemented/phase-1/43-solutions-intelligence` — shipped, not upcoming. It ships behind
    seven `SOLUTIONS_*` flags that were `false` in `env.ts` and absent from `.env.example` entirely
    until 2026-08-16: built, switched off, invisible. "Coming soon" is the wrong badge either way, so
    the item is struck with the two honest options written beside it.
  - A methodology note worth keeping: my first check reported all seven phase-4 paths missing. The
    check was broken — zsh aborts the whole glob when the first pattern matches nothing — not the
    paths. A verification script that fails open is worse than none, because it produces confident
    wrong answers.

## Phase 2 — New sections

- [x] **Build `PipelineSection` component**
  - Result: **one `LandingSection` component, three thin wrappers**, plus
    `content/landing-sections.ts` holding all three sections as data. Three hand-built sections would
    drift into three different answers to what this product does — the same reasoning as
    `SegmentLandingPage`, and the reason the copy drafts contradicted each other in the first place.
  - **The "Coming soon" badge is derived from the plan path, never passed.** `isShipped` returns true
    for anything under `plans/implemented/`, so a card cannot claim a state its plan contradicts. The
    draft this replaces badged Team shortlists "Coming soon" while `28-shared-resources` sat in
    `implemented/`; nothing here can express that, and a test asserts the roadmap contains no
    implemented plan.
  - **No number appears in any copy string, and the test enforces it against the resolved value.** The
    weaker "no hand-written number" rule is unenforceable — a test sees `3` in the output but not
    whether a constant or a keyboard produced it, so it lets both through or blocks both. My first
    version interpolated `SOURCING_SPRINT_LIMITS.pro` and the test caught it. Tier limits belong on
    the pricing page next to what they cost; a landing card saying "up to 3 at once" is a number
    without a price.
  - 40 unit tests: every `planPath` resolves to a real `spec.md`, the roadmap holds nothing
    implemented, the shipped sections hold nothing unimplemented, no copy string carries a number, and
    the forbidden-promise patterns from the segmented landing apply here too.
  - Files: `src/modules/landing/components/PipelineSection.tsx`,
    `src/modules/landing/components/PipelineSection.test.tsx`
  - Do: Read copy from `landing-copy/03-pipeline.md`. Three cards in a
    `md:grid-cols-2 lg:grid-cols-3` bento. Each card uses the existing `liquid-glass`
    panel style. Status badges match the inventory (`Shipped`, `Coming soon`).
  - Verify: `pnpm vitest run tests/unit/modules/landing/components/PipelineSection.test.tsx`
    passes; rendered copy matches the draft.

- [x] **Build `AiHelpersSection` component**
  - Files: `src/modules/landing/components/AiHelpersSection.tsx`,
    `src/modules/landing/components/AiHelpersSection.test.tsx`
  - Do: Read copy from `landing-copy/04-ai-helpers.md`. Five tiles in a 2/3-column grid
    (smaller tiles than Pipeline because the count is higher). Each tile carries a status
    badge, plan path as `data-testid`, credit cost, and one-line copy.
  - Verify: test pins the rendered copy and the status badge of each tile.

- [x] **Build `RoadmapSection` component**
  - Files: `src/modules/landing/components/RoadmapSection.tsx`,
    `src/modules/landing/components/RoadmapSection.test.tsx`
  - Do: Read copy from `landing-copy/05-roadmap.md`. Eight items in a single column. Each
    item is a link to the cited plan's `spec.md`. No `Coming soon` badge inline; the badge
    is the section-level "Coming soon" eyebrow.
  - Verify: every link's `href` matches a real plan path; render test snapshots the eight
    items in order.

- [x] **Wire the new sections into `HomePage.tsx`**
  - Files: `src/modules/landing/components/HomePage.tsx`
  - Do: Insert `<PipelineSection />`, `<AiHelpersSection />`, `<RoadmapSection />` in the
    order established in `spec.md`. No other change to `HomePage.tsx` in this commit.
  - Verify: page-size gate passes (see Phase 4). Visual: each section renders in the
    expected position via `browser_navigate`.

## Phase 3 — Persona switch

- [x] **Add `?persona=` query parameter to the home route**
  - Result: `validateSearch` keeps `persona` as a raw string and `personaFromSearch` narrows it at the
    point of use, so an unrecognised value is **indistinguishable from an absent one**. A validator
    that rejected loudly would turn the parameter into a way to enumerate the segment enum — the same
    rule `parseSegmentHint` follows for `?goal=`.
  - Verified against the served HTML, not a browser: no query and `?persona=hiring` are byte-identical,
    the three variants each swap, `other` repeats the default, and `?persona=platform_admin` renders
    the default with no trace that it was rejected.
  - The switch is `PersonaSwitcher`, a `<details>` of four anchors. A disclosure widget the browser
    already ships gets the keyboard behaviour, the focus handling and `aria-expanded` right; a
    `useState` toggle would be three of those re-implemented and one forgotten. Anchors rather than
    buttons so it survives JavaScript being off and a middle-click does the obvious thing.
  - **The closing paragraph is deliberately not persona-varied**, and a test asserts the persona data
    never contains its phrasing. `ACCESS_ALLOWLIST_ENABLED` gates sign-up behind an approval queue, so
    any wording promising immediate access is false whenever the flag is on — and it is on in
    production. `trust-claims.test.ts` matches raw component source, making it a build-time constraint.
  - Files: `src/routes/_landing/index.tsx` (or wherever the home route is defined)
  - Do: Read `persona` via `useSearch({ from: '/' })`. Default `hiring`. Pass to the
    hero, persona-tabs, and closing-CTA components as a prop. SSR-safe default: the
    server renders the `hiring` variant; the client swaps if the query differs.
  - Verify: server-rendered HTML matches the default `hiring` variant. Client-side swap
    on navigation does not flash.

- [x] **Add the persona-switch UI**
  - Files: `src/modules/landing/components/PersonaSwitcher.tsx`
  - Do: A small radio group below the hero sub-paragraph, four options, hidden by default
    behind a "Different goal?" text link. Picking one navigates to `?persona=X`.
  - Verify: keyboard accessible; ARIA roles correct; default `hiring` is the
    `aria-pressed` choice.

- [x] **Render persona variants**
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
