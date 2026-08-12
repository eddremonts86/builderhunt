# Delivery Plan: Visual System Normalization and Regression Gate

> **Status**: `implemented`
> **Depends on**: [`audit-performance-qa`](../49-audit-performance-qa/spec.md), [`audit-accessibility`](../48-audit-accessibility/spec.md)
> **Blocks**: nothing
> **Reality check**: A light semantic palette and reusable UI primitives exist, and many landing
> cards already use flex layouts. Normalization is incomplete because global `!important` rules
> override local utilities, raw class composition remains common, metadata describes a dark theme,
> and responsive appearance is not tested automatically.

## Delivery sequence

### Phase 1 — Freeze and classify the baseline

Use the shared Playwright harness to capture the five audited surfaces at three primary viewports
with deterministic data, fonts, motion, and time. Add structural measurements for overflow,
control sizes, and same-row alignment. Inventory raw radii/shadows/colors and classify each as a
semantic role or explicit source-brand exception before changing CSS.

### Phase 2 — Normalize tokens and primitives

Define spacing/radius/elevation/control/motion tokens in `globals.css`; remove the duplicate late
`:root` background override and all relevant `!important`. Make `Button`, `LinkButton`, `Input`,
and `Dialog` the canonical stateful primitives, with tests for variants, size, disabled/loading,
focus, and reduced motion. Correct root light-theme metadata. This phase may change snapshots only
for documented token conflicts.

### Phase 3 — Migrate public surfaces

Migrate Header, Footer, landing, FAQ, and pricing from ad hoc button/panel styling to semantic
roles. Preserve source-brand colors and content hierarchy. Apply equal-height behavior only within
the three-step, feature, and pricing comparison rows. Prove no overflow at 320/390/768/1440 px and
review before/after screenshots.

### Phase 4 — Migrate authenticated surfaces

Apply the same container, panel, control, and responsive contracts to DashboardLayout, SearchPage,
PersonResultCard, and BuilderProfilePage. Keep the compact mobile navigation functional and avoid
truncating user-generated values without an accessible full-value affordance.

### Phase 5 — Enforce the contract

Add a static visual-contract checker, unit tests, and screenshot/structural specs to the existing
quality workflow. Produce a small design-system reference in `docs/visual-system.md` with token
roles, permitted exceptions, component examples, and snapshot-update procedure. Run a production
smoke at mobile and desktop sizes after merge.

## Gate matrix

| Gate            | Pass condition                                                                           |
| --------------- | ---------------------------------------------------------------------------------------- |
| Static contract | No prohibited raw color/radius/shadow/`!important` in audited files.                     |
| Primitive unit  | Variant, size, focus, disabled/loading, and reduced-motion tests pass.                   |
| Structure       | No page overflow; same-row cards ≤1 px delta; controls ±1 px of token height.            |
| Visual          | Every committed Chromium snapshot is within 1% diff (`maxDiffPixelRatio: 0.01` — see spec.md). |
| Accessibility   | Existing keyboard/focus/contrast tests remain green after visual changes.                |
| Runtime         | Production mobile/desktop screenshots, local fonts, theme metadata, and navigation pass. |

## Risks and controls

| Risk                                           | Control                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Removing `!important` reveals latent conflicts | Migrate primitive-first, inspect computed styles, and approve snapshots per surface.                              |
| Snapshot noise hides real regressions          | Dockerized Chromium, fixed fixtures/time/fonts, disabled motion, tight masks only for unavoidable dynamic values. |
| Universal equal heights create wasted space    | Limit stretching to explicit comparison rows and assert named card groups only.                                   |
| Visual changes regress accessibility           | Preserve semantic DOM/focus states and make the accessibility suite a hard dependency/gate.                       |
| Mass utility replacement creates broad churn   | Restrict work to audited surfaces; use the checker to prevent new drift rather than rewriting untouched routes.   |

## Rollout

1. Land baseline snapshots and structural assertions without UI changes.
2. Land tokens/primitives behind no feature flag; verify one public and one authenticated canary
   surface before expanding.
3. Migrate public surfaces, then authenticated surfaces in reviewable commits.
4. Enable the static/screenshot checks as required after the normalized baseline is approved.
5. Verify the production build at 390 and 1440 px and retain before/after artifacts for one release.

## Rollback

Revert the most recent surface migration while keeping the harness and token additions. If a token
causes widespread regression, restore only its previous computed value; do not reintroduce
`!important`. Snapshot baselines are never updated to make an unexplained regression pass. No data
or backend rollback is required.

## Completion evidence

Attach the inventory, primitive test output, contract-check output, viewport measurements,
reviewed before/after images, CI run, and production smoke. Mark implemented only after all five
surfaces pass twice in clean CI and once against the deployed runtime.
