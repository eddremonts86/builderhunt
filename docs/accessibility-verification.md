# Accessibility verification record

Tracks the manual assistive-technology release gate required by
`plans/implemented/phase-1/48-audit-accessibility/spec.md`. Every entry is either a real, dated verification run or
explicitly marked as not yet done — never inferred or assumed.

## How to use this document

Before shipping a change that touches shared shell components, forms, dialogs, or color tokens:

1. Run the automated gate: `pnpm lint && pnpm type-check && pnpm test && pnpm build && pnpm test:a11y`.
2. Walk the two journeys below with a real screen reader (not just automated tooling) — automated
   axe-core checks catch contrast/name/role/structure issues but cannot verify that an announcement
   actually makes sense out loud, that focus lands somewhere sensible, or that a flow is usable
   without sight.
3. Record a new dated entry below. Do not overwrite prior entries — this is a history, not a status
   flag.

## Journeys to walk

- **Public signup/explore**: land on `/`, use the keyword search without signing in, open
  `/explore`, review a builder card, attempt sign-up (`/auth/sign-up`) through to the onboarding
  welcome step — entirely via keyboard + screen reader, no mouse.
- **Authenticated search/save**: sign in, run a search, save it, open a saved search, track a
  builder, open a builder profile, add a private note — entirely via keyboard + screen reader.

Both journeys: confirm skip-link activation moves focus to `#main-content`, confirm every dialog
(filters, ToS) traps focus and restores it on close, confirm async success/failure (save, track,
note) is announced without an unexpected focus jump.

## Entries

### 2026-08-15 — Segmented landing pages: structural pass, no screen-reader run

- **Commit**: this branch (`feat/phase2-segmented-landing`), plan `phase-2/06-landing-segmentada`
- **Tester**: Claude (automated + browser inspection), unverified by a human
- **Environment**: macOS, Chromium via the in-app browser at 375×812 and desktop, light and dark
- **Scope**: `/for/hiring-teams`, `/for/investors`, `/for/builders` and the selector band on `/`.
  Deliberately narrow — this is a new public surface, not a change to the shell, so the two standing
  journeys below were not re-walked.
- **Structure**: one `<h1>` per page, headings in order (`h1` → three `h2`), and the selector is a
  `<nav>` with an accessible name ("Choose what brings you here") rather than a list of links under
  a heading. A screen-reader user landing here needs to know this is a way *out* of the page, not a
  table of contents for it.
- **Keyboard**: focus order matches reading order — three selector options, then the two CTAs. Every
  selector option carries a `focus-visible:ring`; the page you are on is marked `aria-current="page"`
  rather than offered. Focus + Enter navigating between pages is asserted in
  `tests/e2e/segmented-landing.spec.ts`, not just checked by hand.
- **No JavaScript**: every claim, every limit and every selector `href` is in the served HTML,
  asserted with `request.get` rather than a browser visit. The selector is anchors, which is what
  makes that true.
- **320px reflow**: `scrollWidth` equals the viewport at 375px on all three pages, covered by an
  `@mobile-only` spec and by `responsive-device-matrix.spec.ts`'s five widths.
- **200% zoom**: **not checked.**
- **VoiceOver / manual AT pass**: **not done.** Same gap as every entry below it — automated
  structure checks cannot tell you whether "I'm investing" followed by a heading change announces as
  a navigation that worked.
- **Owner**: unassigned. The screen-reader pass on these three pages is a launch-QA item that stays
  open (plan task 9).

### 2026-07-25 (2) — Final quality-gate smoke run

- **Commit**: work-in-progress on branch `ui-modernization-and-audits` (uncommitted at time of
  writing).
- **Tester**: Claude (agent session), automated tooling only.
- **What was run**: `pnpm lint && pnpm type-check && pnpm test && pnpm build` — all green
  (`lint`: 0 errors, 106 pre-existing warnings unrelated to accessibility; `type-check`: clean;
  `test`: 2006/2006 passing; `build`: succeeds).
- **`pnpm test:a11y`**: could not complete in this sandboxed session — every route timed out
  waiting for `html[data-hydrated="true"]` inside the script's own `chromium.launch()` instance,
  with no other error surfaced. This is **not a real hydration regression**: independently
  confirmed hydration works correctly against the exact same running dev server by checking
  `document.documentElement.getAttribute('data-hydrated')` in a real interactive browser session
  — it returned `"true"`. The failure is isolated to `test-accessibility.mjs`'s own headless
  Chromium launch in this particular sandbox (retried twice, identical uniform failure both
  times — a real, reproducible environment constraint here, not flakiness). Whoever runs this
  gate outside this sandbox should get real pass/fail results; do not trust this entry as
  evidence the axe-core checks themselves pass or fail.
- **Staging/production smoke**: **not done** — this task's own text acknowledges a real
  staging/production deployment is required and is out of scope for a local session. No staging
  environment exists separate from the single production deployment
  (`https://builderhunt.eduardoinerarte.dk`); flagging rather than fabricating a smoke pass
  against it.
- **Still open**: everything listed as open in the 2026-07-25 (1) and 2026-07-24 entries below
  (VoiceOver/manual AT pass, 200% zoom, `test:a11y`'s actual pass/fail result).
- **Owner**: unassigned — needs a human with a normal (non-sandboxed) machine to re-run
  `pnpm test:a11y` and do the VoiceOver pass.

### 2026-07-25 — Accent-contrast design decision resolved

- **Commit**: work-in-progress on branch `ui-modernization-and-audits` (uncommitted at time of
  writing).
- **Tester**: Claude (agent session), automated tooling only — same caveat as the 2026-07-24 entry
  below applies (no human AT pass yet).
- **What changed**: the accent-contrast finding flagged as unresolved on 2026-07-24 (white text on
  the solid terracotta accent fill, 3.14:1) is now fixed — `--color-bh-accent-contrast` changed
  from `#ffffff` to a dark ink (`#1a0f0a`), which clears 4.5:1 against both `--color-bh-accent`
  (5.98:1) and `--color-bh-accent-hover` (4.57:1) without touching the accent color itself, so the
  brand terracotta (badges, links, focus rings, the brand mark) is unaffected. Two call sites that
  hardcoded `bg-bh-accent text-white` instead of the token (`SearchPage.tsx`'s notification-count
  badge, `RecommendationsSection.tsx`'s topic badge) were routed through the token too.
- **Exceptions removed**: the two `accent-contrast`/`bg-bh-accent` entries in
  `tests/regression/test-accessibility.mjs`'s `EXPECTED_EXCEPTIONS`, and the corresponding "known, documented
  exception" test in `src/shared/lib/accessibility.test.ts` (now asserts the pairing passes
  instead of pinning the failure).
- **Verify**: `pnpm test -- src/shared/lib/accessibility.test.ts` and `pnpm test:a11y` — re-run
  after this change to confirm no other `color-contrast` regression.
- **Still open from 2026-07-24**: the decorative-numeral exception, the ThemeToggle glass/blur
  exception, and the "Recent builders" list exception all remain (different, unrelated root
  causes — see `tests/regression/test-accessibility.mjs` for each). VoiceOver/manual AT pass and 200% zoom are
  still not done.
- **Owner**: unassigned — VoiceOver pass and 200% zoom still need a human.

### 2026-07-24 — Automated pass only (this session)

- **Commit**: work-in-progress on branch `ui-modernization-and-audits` (uncommitted at time of
  writing — see git history for the actual commit once landed).
- **Tester**: Claude (agent session), automated tooling only. **No human assistive-technology
  tester has reviewed this build yet** — the macOS/VoiceOver/browser-version fields below are
  intentionally blank because that testing has not happened. Do not treat this entry as a
  substitute for a real manual pass.
- **What was actually run**: `pnpm test:a11y` (axe-core via Playwright) against a local dev build,
  across the public + authenticated route matrix defined in `tests/regression/test-accessibility.mjs`, at
  mobile (390×844) and desktop (1280×800) viewports, signed in as the seeded local admin
  (`edd_admin@local.com`).
- **Result**: all routes clean for `critical`/`serious` axe violations except three documented,
  dated exceptions in `tests/regression/test-accessibility.mjs` (`EXPECTED_EXCEPTIONS`) — all three are the
  same root cause (white text on the solid accent-orange fill measures 3.14:1, short of 4.5:1) plus
  one confirmed-decorative low-opacity numeral. See that file for the exact reasoning; the
  accent-contrast pairing is a **real, unresolved finding** that needs a deliberate design decision
  (darken the accent color, or switch primary-button text to a dark ink) — it was not fixed here
  because it changes the signature brand button's look across the entire product, which is outside
  a mechanical accessibility pass. Whoever makes that call should re-run `pnpm test:a11y` and
  delete the now-obsolete exception entries.
- **320px reflow**: checked live via the Browser tool at 320×600 on `/dashboard`, `/search`, and
  `/builder/$builderId` (the highest-risk page — see the `min-w-0` flexbox gotcha in
  `docs/design/responsive-qa-checklist.md`) — no two-dimensional overflow found.
- **200% zoom**: **not checked this session** — needs a follow-up pass (resize viewport to half the
  target width at 1x scale, or use real browser zoom, and re-walk the two journeys above).
- **VoiceOver / manual AT pass**: **not done**. Needs a real macOS + Safari/Chrome + VoiceOver
  session (or equivalent screen reader) walking both journeys above. This is the primary gap this
  entry exists to name — automated tooling is necessary but not sufficient for a real release gate.
- **Exceptions**: see `EXPECTED_EXCEPTIONS` in `tests/regression/test-accessibility.mjs` — three entries, all
  dated 2026-07-24, all tracing to the same accent-contrast root cause. No expiry set; they expire
  when someone makes the accent-color/button-text design call and re-verifies.
- **Owner**: unassigned — needs a human to claim the accent-contrast decision and the VoiceOver
  pass.

### Template for the next entry

```
### YYYY-MM-DD — <one-line summary>

- **Commit**: <full SHA>
- **Tester**: <name>
- **Environment**: macOS <version>, <browser> <version>, VoiceOver <version>
- **Public signup/explore journey**: pass/fail, notes
- **Authenticated search/save journey**: pass/fail, notes
- **200% zoom**: pass/fail, notes
- **320px reflow**: pass/fail, notes
- **Exceptions**: link to EXPECTED_EXCEPTIONS entries still active, with expiry
- **Owner**: <name>, next re-verification due <date>
```
