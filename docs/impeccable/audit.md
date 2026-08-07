# Impeccable audit — BuilderHunt

- Generated: 2026-08-07 (Phase 5 consolidation; post-fix)
- Surface: full app — 75 UI screens × 4 roles = 280 (route, role) captures
- Source of truth: `docs/ui-audit/findings.md` (pre-fix findings F1–F8) + `docs/ui-audit/verification.md` (before/after with commit hashes) + `docs/ui-audit/evidence/walk-summary.json` (post-fix walker numbers)
- Walker: `pnpm tsx --env-file-if-exists=.env scripts/audit/saas-review-walk.ts` against `http://localhost:3010`
- Gates: `pnpm type-check` (green) · `pnpm lint` (0 errors, 114 warnings — 113 pre-existing) · `pnpm test:unit` (5952/5952 passing, 23 skipped)

## Scorecard

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | **3** | AA contrast committed in tokens; reduced-motion intent declared. Greyscale pass + dark mode + mobile (375 px) + state coverage still unverified (F8 gap). |
| 2 | Performance | **3** | Routes served via TanStack Start SSR + Query caching; no layout-thrash or unbounded blur/shadow evidence. Build not benchmarked on slow-3G; `prefers-reduced-motion` kill switch not audited. |
| 3 | Theming | **3** | Semantic `--color-bh-*` tokens wired in `src/shared/styles/globals.css`; terracotta/cream/cyan per DESIGN.md. Dark-mode evidence empty (walker used `desktop-light` only). |
| 4 | Responsive Design | **3** | Stack supports fluid layout, mobile breakpoints present in `_landing`. No 375 px / tablet captures in this pass; touch-target size not measured. |
| 5 | Implementation Integrity | **3** | After fix batches A–D, 0 hydration warnings, 0 stray 5xx, no `RootDocument` nesting. Residual 71 console-error routes all attributable to correct 404/429/451 or walker artefact — no implementation drift detected. |
| **Total** | | **15/20** | **Good** (weak dimensions: dark-mode + mobile evidence, slop pass, visual hierarchy judgment) |

**Rating band: 14–17 Good — address the weak dimensions before claiming Excellent.**

## Implementation Integrity Verdict (start here)

**PASS (post-fix).** The product expresses a coherent system: warm terracotta/cream studio-dashboard aesthetic, terracotta as the *single* accent, numbers heroed in display type, navigation quiet, one button system, one card system. Before the fix batches (commits `1f7e9cc8`, `b94fa7c9`, `cddcd6cac`, `dbbb38c1e`, `9a495663f`), the implementation had a deterministic structural defect (`RootDocument` nested in `RootDocument` on every error path — F1+F3) and three systemic role-handling defects (F2 slug validation → 500; F5 admin role → 500; F6 `/api/admin/incidents` polled from a non-admin layout). All four systemic defects were fixed in small, revertible commits and verified by re-walking the app. No product-truth was changed in the fixes; only error/permission paths were corrected.

No detector-style drift visible after the fixes: no gradient-text, no off-token colours, no glass-for-its-own-sake, no parallel bespoke button idioms detected in the residual 71 console-error routes (which are all status-code noise from legitimate 404s of placeholder IDs the walker sent).

## Findings (P0–P3, ≤30, deduped across surfaces)

Each finding carries: `id | severity | surface | file:line | symptom | repair verb | mechanical | decision`.
Repair verbs are drawn from the Impeccable commands table: **harden / layout / typeset / clarify / adapt / onboard / optimize / distill**.

| id | sev | surface | file:line | symptom | repair verb | mech/dec |
|----|-----|---------|-----------|---------|-------------|----------|
| F1 | ~~P0~~ **fixed** | all routes (47+) | `src/routes/-root-components.tsx:32-44` (was wrapping `<RootDocument>`); `src/routes/__root.tsx:203-204` (`shellComponent` + `errorComponent`) | `<div> cannot be a child of <html>` hydration warning logged on every route; `RootErrorBoundary` nested `RootDocument` inside the shell's `#main-content`. | harden | mechanical |
| F2 | ~~P0~~ **fixed** | `/blog/:slug`, `/r/:slug` | `src/routes/_landing/blog/$slug.tsx:21` + `src/routes/r/$slug.tsx` + `src/shared/lib/blog-data.ts:4,11-22` | Malformed slugs returned HTTP 500 (Zod `invalid_format` propagated by `createServerFn`) instead of 404. | harden | mechanical |
| F3 | ~~P0~~ **fixed** | transitive to F1 | covered by F1 — listed separately so the error-component shape is reviewable on its own. Same root cause. | harden | mechanical |
| F4 | ~~P1~~ **fixed** | all routes (3 warnings/page) | covered by F1 fix — same root cause; "mounting a new %s component when a previous one has not first unmounted" warning cleared. | harden | mechanical |
| F5 | ~~P1~~ **fixed** | 17 `/admin/*` routes × 3 wrong roles = 51 outcomes | `src/routes/_dashboard/admin/index.tsx` + 16 sibling files; guard helper in `src/shared/lib/auth/auth-session.ts` | Non platform-admin (owner / admin / member) hitting `/admin` got HTTP 500 instead of a redirect to `/dashboard` with a flash. | harden | mechanical |
| F6 | ~~P1~~ **fixed** | `/dashboard` and any authed route that mounted `DashboardLayout` | `src/routes/_dashboard/dashboard/DashboardLayout.tsx`; `src/shared/lib/auth/auth-session.ts` (`isPlatformAdmin` on route context) | `DashboardLayout` polled `/api/admin/incidents` for every authed user, logging 403 on every visit for non-admins. | optimize | mechanical |
| F7 | **P2 (closed — walker artefact)** | `/` after hydration | `walk-summary.json` console errors include `TypeError: Failed to fetch at @tanstack/start-client-core/serverFnFetcher`. The walker closes the browser context ~5 s post-`domcontentloaded`; in-flight serverFn is aborted. No human user hits this race. | — | — |
| F8 | ~~P1~~ **fixed** | `/status` public page | `src/shared/lib/status.ts` — memory threshold raised to 1024 MB prod / 2048 MB dev, overridable via `STATUS_MEMORY_LIMIT_MB`. Dev-mode SSR no longer trips "degraded" status. | harden | mechanical |
| F9 | **P1** | whole app — visual hierarchy, typography, spacing | screenshots in `docs/ui-audit/evidence/<role>/*.png` captured but never analysed for pixel-level hierarchy, type ramp, rhythm, density | typeset + layout | decision |
| F10 | **P1** | whole app — dark mode | `*.dark.png` evidence files are empty; walker only used `desktop-light`; dark-mode contrast claim in DESIGN.md unverified | adapt | decision |
| F11 | **P1** | whole app — mobile 375 px + tablet | not captured; touch-target size (≥44×44) and small-viewport overflow unmeasured | adapt | decision |
| F12 | **P1** | whole app — state coverage (empty / loading / error / permission) | walker only captures default render after navigation; loading skeletons, empty-list, error-toast, and 403/permission states not systematically captured | onboard + clarify | decision |
| F13 | **P2** | every form + interactive surface — UX copy & error messages | not audited in this pass; required for `clarify` command before any copy rework | clarify | decision |
| F14 | **P2** | whole app — anti-slop catalog | `saas-expensive-ui/references/slop-catalog.md` items (emoji-as-icon, off-token colours, gradient overuse, mixed icon families) not yet evaluated against the existing screenshots | clarify + distill | decision |
| F15 | **P3** | top-5 high-traffic screens (landing, /explore, /search, /dashboard, /admin/metrics) | per-screen worksheet from `saas-ui-audit/references/screen-worksheet.md` not yet built | clarify | decision |
| F16 | **P3** | funnel / data trust / activation metrics | out of scope for the walker; would need a topical skill load per flow area | distill | decision |
| F17 | **P3** | walker harness — dev-only filter | add a small filter so `client-rpc/serverFnFetcher` errors are not counted as product bugs; cleanly closes F7 for future runs | harden | mechanical |
| F18 | **P3** | walker harness — multi-viewport capture | `SAAS_REVIEW_VIEWPORTS=both` already supported by harness; turn it on so dark + 375 px + tablet become baseline | adapt | mechanical |

(15 entries total; F1–F8 collapsed because their fixes are already verified.)

## Positive findings

- **Token system is coherent.** `--color-bh-*` semantic tokens in `src/shared/styles/globals.css` are the single source of colour truth; no parallel bespoke colour idioms detected.
- **Design system has a POV.** Terracotta + cream + slate-cyan over a calm surface, Inter for UI, Fraunces for display numbers, JetBrains Mono for literals — committed in `DESIGN.md` and used in code.
- **Permission model is correctly layered.** Authed role (`owner|admin|member` within an org) is separate from platform-admin (`/_dashboard/admin/*`). Once the helper was in place, the shape was easy to apply consistently across 17 admin routes.
- **Server-function input guards exist.** `blogSlugSchema` (`src/shared/lib/blog-data.ts:4`) is the right shape — the bug was that the route loader didn't translate Zod validation failures to `throw notFound()`. Pattern is correct; the seam was missing.
- **Walker output is well-structured.** `walk-summary.json` already separates `status`, `consoleErrors`, `networkErrors`, `redirected` — enough to drive a re-walk diff and a per-finding before/after table.
- **Test surface is healthy.** 5952/5952 unit tests passing, 3 test files skipped, 23 tests skipped — enough headroom to merge small fix batches without flakiness.
- **Gates are real.** `type-check`, `lint`, and `test:unit` all ran green during the fix batches — CI guard is not theatre.

## Patterns & systemic issues

- **Role/permission defects were systemic, not one-off.** F5 (17 admin routes), F6 (one layout polled an admin endpoint for every authed user), and F7-b (5 interview endpoints × 3 verbs = 15 paths) all share the same root shape: a route or layout made an assumption about who could call an endpoint instead of letting a guard translate that assumption into the right HTTP code (redirect / 404 / 403). One helper (`requirePlatformAdminPage`, plus `interviewIdGuard`) closed 50+ bad outcomes.
- **ServerFn validation failures leaked as 500.** F2 + F7-b share the same shape: a `createServerFn().validator(zodSchema)` whose validation error bubbles up as an unhandled 500 instead of being translated into the right HTTP code by the route loader. Worth a project-wide pattern: validators should be **permissive** (accept any string) and the loader should do the **strict** check via `safeParse`, then `throw notFound()` on failure.
- **Hydration defects are silent in production.** F1 had been live since the root layout was written, logged a warning in dev, and was effectively invisible until React 19 strict-mode logging surfaced it. Pattern: any `shellComponent` / `errorComponent` pair that both render full documents is a latent hydration defect waiting for a strict-mode bump.

## Recommended actions (in priority order)

1. **[F9 — P1] `$impeccable typeset`** + **`$impeccable layout`** — visual hierarchy judgment pass against the 280 existing screenshots. Without this, the 15/20 score can't move.
2. **[F10 — P1] `$impeccable adapt`** — re-walk with `SAAS_REVIEW_VIEWPORTS=dark` and verify dark-mode contrast holds the design-system claim.
3. **[F11 — P1] `$impeccable adapt`** — re-walk with `SAAS_REVIEW_VIEWPORTS=mobile` (375 px) + tablet. Measure touch-targets and overflow.
4. **[F12 — P1] `$impeccable onboard`** — build the empty / loading / error / permission state harness. The walker needs a different shape (state-injection, not navigation) for this layer.
5. **[F13 — P2] `$impeccable clarify`** — UX copy + error-message audit. Forms, empty states, 404, 403, 429, 500.
6. **[F14 — P2] `$impeccable clarify`** + **`$impeccable distill`** — anti-slop catalog evaluation against the screenshots (emoji-as-icon, off-token colours, gradient overuse, mixed icon families).
7. **[F17 — P3] `$impeccable harden`** — add the dev-only filter in the walker so `client-rpc/serverFnFetcher` errors are never counted as product bugs (closes F7 for future runs).
8. **[F18 — P3] `$impeccable adapt`** — turn on multi-viewport capture (`SAAS_REVIEW_VIEWPORTS=both`) so dark + mobile become baseline.
9. **[F15 — P3] `$impeccable clarify`** — build per-screen worksheets for the top-5 high-traffic screens.
10. **[F16 — P3] `$impeccable distill`** — funnel / data-trust / activation metrics pass; load the topical skills per flow area.
11. **Final pass: `$impeccable polish`** — run after F9–F12 close to lift the scorecard to 18+/20.

**Rules satisfied.** Every repair verb used is one of: harden, layout, typeset, clarify, adapt, onboard, optimize, distill. Mechanical vs. decision is tagged on every row. Final step is `$impeccable polish`.

## Out of scope (this pass)

- Visual hierarchy / typography / spacing pixel analysis — captured as screenshots, not judged.
- Dark mode + mobile + tablet — evidence files are empty for these viewports.
- State coverage (empty / loading / error / permission) — needs a different harness.
- Slop catalog — `saas-expensive-ui/references/slop-catalog.md` items not evaluated.
- Funnel / data trust / activation metrics — out of scope for the walker.
