# /fix-ui-ux consolidated findings. BuilderHunt

- Generated: 2026-08-07 (Phase 1 → Phase 2 checkpoint)
- Source: `docs/impeccable/audit.md` (5-dim technical) + `docs/impeccable/critique.md` (design review, ⚠️ DEGRADED. see below) + `docs/ui-audit/findings.md` (saas-review, already closed) + `docs/ui-audit/verification.md` (saas-review, before/after with commit hashes)
- Surface scope: 5 core surfaces. `/`, `/builders/:builderId`, `/dashboard`, `/admin/metrics`, `/interviews/:interviewId/live`

## Provenance

- **Audit** (Assessment A in fix-ui-ux terms) ran as 3 parallel sub-agents and completed; saved to `docs/impeccable/audit.md`.
- **Critique** attempted to run as 3 parallel sub-agents but failed with `HTTP 429 Token Plan rate limit reached`. Fell back to sequential single-context (Assessment A inline + Assessment B skipped because puppeteer is not installed). Banner at top of `docs/impeccable/critique.md` reads `⚠️ DEGRADED: single-context (sub-agent spawn failed: HTTP 429 Token Plan rate limit)`. Findings should be re-verified when the rate-limit window clears.
- **Saas-review** F1–F8 already closed in the prior pass (commits `1f7e9cc8`, `b94fa7c9`, `cddcd6cac`, `dbbb38c1e`, `9a495663f`); kept here only as historical context, marked **fixed**.

## Scoring summary

| Source | Score / band |
| --- | --- |
| Audit (5-dim) | 15/20. Good. Weak dimensions: dark-mode evidence, mobile evidence, slop pass, visual hierarchy judgment. |
| Critique (Nielsen 10) | 2.6/4 average over applicable heuristics. Acceptable, not strong. |
| Saas-review (defects) | 0 open P0/P1. All closed + verified. |

## Consolidated findings. P0 → P3

| id | sev | source | surface | file:line | symptom | repair verb | mech / decision |
|---|---|---|---|---|---|---|---|
| **C1** | **P1** | critique | `/` hero | `src/routes/_landing/index.tsx` (CTAs row) | Two CTAs ("Start hunting" + "Try it without an account") compete for the same first-click decision. Secondary CTA naming implies anonymous browse. copy and intent should align. | clarify | **mechanical** |
| **C2** | **P1** | critique | `/` mid-page | `src/routes/_landing/index.tsx` (~ "How it works" section) | "How it works" describes 3 steps in text without a product screenshot in that section. Recognition-not-recall gap (Nielsen #6). | layout | **decision** |
| **C3** | **P1** | critique | `/` mid-page | `src/routes/_landing/index.tsx` | ~9 sections; "How it works" + "Features" + "Sources" mid-block compete. 6-feature grid is dense at 1280 px. | distill | **decision** |
| **C4** | **P1** | critique | `/` mid-page | `src/routes/_landing/index.tsx` (persona tabs) | Persona tabs (4) visually undifferentiated. No persona-specific proof (screenshot, stat). | layout | **decision** |
| **C5** | **P1** | critique | `/` hero | `src/routes/_landing/index.tsx` (paragraph under H1) | Differentiator (activity scoring + builder-as-actor) buried in supporting paragraph, not above the fold. | clarify | **decision** |
| **C6** | **P1** | audit + critique | `/` mobile | mobile capture missing | Landing's 6-feature grid + 4-col footer untested at 375 px. Walker harness change first, then re-walk. | adapt | **mechanical** (capture) |
| **C7** | **P1** | critique | `/dashboard` | `src/routes/_dashboard/dashboard/index.tsx` | Widget order/priority signal not visible to a returning member; first-screen widget may not be the persona-relevant one. | onboard | **decision** |
| **C8** | **P2** | audit + critique | `/dashboard` | empty / loading / permission states not captured | Walker only captures default render. | onboard + clarify | **mechanical** (capture) |
| **C9** | **P2** | critique | `/admin/metrics` | empty / degraded states not captured | Operator-facing dashboard needs explicit healthy / degraded / no-data states. | onboard | **decision** |
| **C10** | **P2** | critique | `/interviews/:interviewId/live` | live console error recovery | Failed segment append must show in-session retry, not a silent toast. | harden | **decision** |
| **C11** | **P2** | critique | whole app | forms + error copy | Sign-up / forgot / reset / billing / remove-profile forms, 404 page, 403 flash, 429 toasts, error boundary copy. not systematically audited. | clarify | **decision** |
| **C12** | **P2** | audit + critique | whole app | slop catalog pass | emoji-as-icon, off-token colours, gradient overuse, mixed icon families. not yet evaluated against screenshots. | clarify + distill | **decision** |
| **C13** | **P3** | critique | `/admin/metrics` | counter labels | Re-verify on populated walk after `2b0aa726d`. | clarify | mechanical |
| **C14** | **P3** | audit + critique | walker harness | `scripts/audit/saas-review-walk.ts` | Dev-only filter so `client-rpc/serverFnFetcher` errors are not counted as product bugs (closes saas-review F7 cleanly). | harden | **mechanical** |
| **C15** | **P3** | audit + critique | walker harness | `scripts/audit/saas-review-walk.ts` | Turn on `SAAS_REVIEW_VIEWPORTS=both` so dark + mobile + tablet become baseline. | adapt | **mechanical** |
| F9 | P1 | audit | whole app | visual hierarchy judgment | Pixel-level typography / spacing analysis of the 280 existing screenshots. | typeset + layout | decision |
| F10 | P1 | audit | whole app | dark mode evidence empty | `*.dark.png` evidence empty; DESIGN.md dark-mode claim unverified. | adapt | decision |
| F11 | P1 | audit | whole app | mobile 375 px + tablet | not captured; touch-target ≥44×44 not measured | adapt | decision |
| F12 | P1 | audit | whole app | state coverage | loading / empty / error / permission not systematically captured | onboard + clarify | decision |
| F17 | P3 | audit | walker harness | (same as C14) |. | harden | mechanical |
| F18 | P3 | audit | walker harness | (same as C15) |. | adapt | mechanical |

(F1–F8 collapsed. already fixed and verified, see `docs/ui-audit/verification.md`.)

## Repair-verb ownership map

Per `fix-ui-ux` Phase 2 mapping:

| verb | owns |
| --- | --- |
| `harden` | C10, C14 |
| `layout` | C2, C4, F9 |
| `typeset` | F9 |
| `clarify` | C1, C5, C8, C9 (partial), C11, C12 (partial), C13 |
| `adapt` | C6, C15, F10, F11, F18 |
| `onboard` | C7, C8, C9, C12 |
| `optimize` | (none raised) |
| `distill` | C3, C12 (partial) |

**Excluded by fix-ui-ux rules** (aesthetic direction changes. not defects; offer only as follow-up):
`bolder`, `quieter`, `colorize`, `delight`, `animate`, `overdrive`, `craft`, `shape`, `extract`, `live`.

## Mechanical vs decision split

**Mechanical (safe to auto-apply once approved):** C1, C6, C13, C14, C15.

**Decision (needs product / aesthetic sign-off):** C2, C3, C4, C5, C7, C8 (states), C9, C10, C11, C12, F9, F10, F11, F12.

## Proposed batches (small, revertible)

| Batch | Findings | Verb | Notes |
| --- | --- | --- | --- |
| **D** | C14 + C15 | harden + adapt | walker harness. `dev-only` filter + multi-viewport capture. Mechanical. No UI change. |
| **E** | C6 | adapt | re-walk with dark + 375 + tablet viewports now that walker supports it (depends on Batch D). |
| **F** | C1 + C13 | clarify | mechanical copy fixes on landing CTA + admin counter labels. |
| **G** | C5 | clarify | move "activity scoring + builder-as-actor" differentiator above the feature-grid fold. Decision needed on exact wording. |
| **H** | C3 + C4 | distill + layout | trim landing sections + differentiate persona panels. Decisions needed on which section to drop. |
| **I** | C2 | layout | insert product screenshot into "How it works". Decision: which surface to capture. |
| **J** | C7 | onboard | dashboard widget priority signal. Decision: which widget goes first per persona. |
| **K** | C8 + C9 + C10 | onboard + harden | empty / loading / error / permission state coverage across dashboard, admin metrics, live console. Largely mechanical once harness exists; copy decisions per state. |
| **L** | C11 + C12 | clarify + distill | form copy + error-message audit + slop catalog pass. Decision-heavy; do last. |
| **M** | F9, F10, F11, F12 | typeset + adapt + onboard | visual pass + dark + mobile evidence + state coverage. Requires populated re-walks. |

**Hard stop.** Awaiting your approval on which batches to apply, and any product decisions (C5 wording, C7 priority, C10 in-session retry shape, etc.) before any code is written.

## Gaps and what could not be measured

- Critique ran degraded (no parallel sub-agents, no detector). Re-run when the rate-limit window clears.
- Mobile + dark + tablet evidence still empty until Batch E runs.
- State coverage (empty / loading / error / permission) still uncaptured.
- Slop catalog pass not run.
- Funnel / data trust / activation metrics out of scope.
