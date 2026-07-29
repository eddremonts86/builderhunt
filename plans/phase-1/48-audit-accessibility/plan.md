# Plan: Accessibility release gate

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: `src/routes/-root-components.tsx`, `src/shared/styles/globals.css`, and `src/modules/landing/components/FAQSection.tsx` already provide a skip link, visible focus style, and native FAQ semantics. This plan preserves those pieces and closes the missing universal target, modal focus, measured contrast/target-size, and CI coverage.

## Delivery sequence

### Phase 1 — Capture the executable baseline

1. Add the browser harness and route fixtures before changing markup.
2. Record axe violations, missing skip targets, focus-loop failures, target rectangles, reduced-motion
   state, narrow viewport overflow, and contrast token failures as test output.
3. Keep failures visible; do not add broad axe exclusions or lower severity thresholds.

Checkpoint: `tests/regression/test-accessibility.mjs` runs locally and fails for the known gaps with selectors
and route names in its output.

### Phase 2 — Fix global navigation and focus primitives

1. Give the root skip link one universal, focusable content target and remove duplicate ids.
2. Add reduced-motion overrides without removing essential progress feedback.
3. Implement reusable dialog initial focus, Tab/Shift+Tab containment, background isolation, scroll
   locking, Escape policy, and trigger restoration.
4. Apply the same contract to the blocking ToS modal while preserving its non-dismissible behavior.

Checkpoint: skip-link and dialog keyboard tests pass on public and authenticated shells.

### Phase 3 — Remediate audited routes

1. Fix accessible names, label/error associations, live regions, landmarks, heading order, and
   duplicated accessibility-tree content surfaced by axe and manual inspection.
2. Measure target rectangles; enlarge failing controls or document a standards-valid exception.
3. Adjust semantic color tokens or local foreground/background pairs based on computed ratios, not
   a global utility-class substitution.
4. Verify 320 CSS pixel reflow, 200% zoom, and reduced motion across the route matrix.

Checkpoint: automated violations are zero at the declared severity threshold and the control
inventory has no unexplained undersized target.

### Phase 4 — CI and manual assistive-technology gate

1. Add the quality workflow with PostgreSQL, deterministic seed, production build/preview, and both
   viewports.
2. Run VoiceOver with Safari and Chrome through signup/explore and authenticated search/save.
3. Store the dated manual checklist in `docs/accessibility-verification.md`, including tester,
   browser/OS versions, failures, exceptions, and issue links.

Checkpoint: all automated commands pass in CI and the manual matrix has no release-blocking issue.

## CI gate

`.github/workflows/quality.yml` runs on pull requests and pushes to `master`:

1. install with `pnpm install --frozen-lockfile`;
2. run `pnpm lint`, `pnpm type-check`, `pnpm test`, and `pnpm build`;
3. start PostgreSQL, run `pnpm db:migrate` and the deterministic seed;
4. start `pnpm preview --host 127.0.0.1 --port 3000` and wait for `/api/health`;
5. run `pnpm test:a11y` and upload sanitized failure traces only.

No deployment job may run if the quality workflow for the same revision fails.

## Runtime smoke gate

Against the production-like preview:

- activate the first focusable skip link on `/`, `/pricing`, `/auth/sign-up`, and `/dashboard` and
  assert `document.activeElement` is the universal content target;
- keyboard-open and close the FAQ and admin menu;
- open the reusable dialog, loop Tab and Shift+Tab, press Escape, and assert focus returns to its
  trigger;
- render the ToS modal, assert focus cannot leave it, and confirm Escape does not dismiss it;
- perform search and save-search flows and confirm status/error announcements;
- run axe after hydration at 375x812 and 1440x900.

## Risks and mitigations

| Risk                                           | Likelihood | Impact | Mitigation                                                                                                |
| ---------------------------------------------- | ---------: | -----: | --------------------------------------------------------------------------------------------------------- |
| Global focus changes alter visual layout       |     Medium | Medium | Use outline/box-shadow that does not affect dimensions and visual-regression snapshots at both viewports. |
| Focus trap conflicts with nested overlays      |     Medium |   High | Centralize stack ownership in the dialog primitive and test ToS + cookie-banner coexistence.              |
| Automated scans create false confidence        |       High |   High | Keep VoiceOver, zoom, reflow, reading-order, and keyboard checks as explicit manual gates.                |
| Live source latency makes browser checks flaky |       High | Medium | Seed/stub route data; do not require third-party APIs for accessibility assertions.                       |
| Contrast changes weaken hierarchy              |     Medium |    Low | Change semantic pairs individually and approve screenshots after numerical checks.                        |

## Rollout

1. Merge the test harness and non-visual semantic fixes first.
2. Release focus/dialog changes behind `VITE_ACCESSIBILITY_PRIMITIVES_V2` for one deployment if
   modal regressions cannot be excluded in staging; default it on in staging.
3. Complete the manual matrix in staging, then enable for all users.
4. Keep accessibility CI blocking every later release; do not remove it after the audit closes.

## Rollback

- Revert the feature flag to the existing dialog implementation if a focus dead-end blocks users.
- Keep the skip-target, semantic markup, and tests unless they are the direct cause of a verified
  regression.
- Revert individual token changes rather than the entire accessibility patch.
- Rollback is code/config-only; this plan has no data migration. Re-run the previous production
  smoke and open a blocking issue before redeploying.

## Definition of done

All tasks are checked, CI and runtime smoke gates pass, the manual verification record is current,
no broad rule suppression exists, and the spec metrics are met without claiming certification.
