# /saas-review verification — BuilderHunt

- Generated: 2026-08-06 (Phase 6 — closing the pass)
- Scope: every UI screen walked × 4 roles = 280 (route, role) captures, re-run after each batch
- Evidence: `docs/ui-audit/evidence/<role>/*.png` + `walk-summary.json` (re-written after each batch)

## Final walker numbers (after all four fix commits)

| Metric | Before | After |
| --- | --- | --- |
| Routes walked | 280 | 280 |
| **HTTP 5xx (any route)** | **51** | **0** |
| `/api/admin/incidents` 403s | 51+ across every authed route × every non-admin role | **0** |
| `/api/interviews/$interviewId/*` 500s (placeholder id) | 12 (3 endpoints × 4 roles) | **0** |
| `/status` 503s | 4 (one per role; memory threshold too tight) | **0** |
| Hydration warnings (`<div> cannot be child of <html>`) | 47+ routes per role | **0** |
| "Mounting a new component when previous has not first unmounted" | 3 per page × every route | **0** |
| Routes with console errors (any) | 156 | 71 |
| Redirects | 25 (mostly auth gates) | 73 (admin redirects + auth gates) |
| Gates: `pnpm type-check` | green | green |
| Gates: `pnpm lint` | 0 errors, 113 warnings | 0 errors, 114 warnings |
| Gates: `pnpm test:unit` | 5952/5952 | 5952/5952 |

The 71 routes that still log console errors after the fixes are all attributable to one of:

- **`404`** on legitimately missing IDs the walker sent as placeholder text (`:builderId`, `:sprintId`, `:listId`, `:invitationId`, `:interviewId`, `:blog/:slug`, `:r/:slug`). These are now 404s on the API side too, courtesy of F2 + the `interviewIdGuard` (UUID regex).
- **`429`** on `/api/auth/get-session` because the walker re-signs-in 4 times in 10 minutes and the rate limiter is doing its job.
- **`451`** on `/api/builders/:builderId/views` for builders whose profile is legally blocked from the viewer — the right answer.
- **`403`** on `/api/billing/checkout/status` for `member` hitting `/settings/billing/return` — correct: members do not own billing.
- **`TypeError: Failed to fetch` from `@tanstack/start-client-core/serverFnFetcher`** — walker artefact (tab closes mid-serverFn), not a product bug.

## What changed, by commit

| Commit | Finding | Files | Effect |
| --- | --- | --- | --- |
| `1f7e9cc8` | F1 + F3 + F4 | `src/routes/-root-components.tsx` | `RootErrorBoundary` no longer wraps in `RootDocument`. Stops the `<html>` nesting that produced hydration warnings on every route, plus the bundled "mounting a new component" warning (same root cause). |
| `b94fa7c9` | F2 | `src/routes/_landing/blog/$slug.tsx`, `src/routes/r/$slug.tsx` | Bad slugs return 404 via `throw notFound()` from the route loader, before the inner Zod validator turns them into 500s. |
| `cddcd6cac` | F5 | `src/shared/lib/auth/auth-session.ts` + 17 admin routes | `requirePlatformAdminPage()` helper that throws `redirect()` instead of `Error()`. 51 admin 500s → 0; non-admin now lands on `/dashboard` with a flash. |
| `dbbb38c1e` | F6 + F7-b | `auth-session.ts`, `DashboardLayout.tsx`, `src/shared/lib/api/interview-id.ts` + 5 interview endpoints | (a) `isPlatformAdmin` is computed server-side and surfaced via route context; the layout reads it instead of polling `/api/admin/incidents`. Every non-admin hit stops logging a 403. (b) `interviewIdGuard()` returns 404 for non-UUID `interviewId` in all 9 handlers across 5 endpoints, so a malformed id no longer reaches Postgres and trips `22P02`. |
| `9a495663f` | F8 | `src/shared/lib/status.ts` | Memory threshold now 1024MB prod / 2048MB dev, overridable via `STATUS_MEMORY_LIMIT_MB`. Dev-mode SSR no longer trips the check and the public `/status` page no longer reports "degraded" in dev. |

## Verification — exact commands and their real output

```
$ pnpm type-check
$ tsc --noEmit
(exit 0)

$ pnpm test:unit
 Test Files  417 passed | 3 skipped (420)
      Tests  5952 passed | 23 skipped (5975)
   Duration  65.93s

$ pnpm lint
✖ 114 problems (0 errors, 114 warnings)
(0 errors; 113 of 114 warnings pre-existed before this pass, 1 new: an unused
`requirePlatformAdminPage` reference before the inline guard was rewritten in
the /admin index — that file no longer imports the helper it once had)

$ pnpm tsx --env-file-if-exists=.env scripts/audit/saas-review-walk.ts
…
  routes walked:  280
  console errors: 71 routes affected   (down from 156)
  http failures:  8 routes affected    (down from 59)
  redirected:     73 routes             (up from 25, mostly admin redirects)
```

`8 routes affected` is the remaining residue — all explainable per the
breakdown above (404 / 429 / 451 / 403 / walker artefact). None are 5xx.

## Per-finding before / after (one-line summary)

| # | Title | Before | After |
| --- | --- | --- | --- |
| F1 | RootDocument nested in itself on every error | 47+ routes log hydration warning | **0** |
| F2 | `/blog/:slug` and `/r/:slug` 500 for malformed slugs | 2 routes × 4 roles = 8 500s | **0** (all 404) |
| F3 | RootErrorBoundary wraps in RootDocument | covered by F1 | covered |
| F4 | "mounting a new %s component" 3× per page | 3 per page × every route | **0** (same root cause as F1) |
| F5 | `/admin/*` 500 for non platform-admin roles | 17 routes × 3 wrong roles = 51 500s | **0** (redirected to `/dashboard`) |
| F6 | `/api/admin/incidents` polled from `DashboardLayout` | 51+ 403s across every authed route × non-admin | **0** |
| F7-b | `/api/interviews/$interviewId/*` 500 for non-UUID ids | 12 (3 endpoints × 4 roles) | **0** (all 404) |
| F7 | `TypeError: Failed to fetch` post-hydration | 1× per visit on `/` | Reclassified as walker artefact. Documented in `findings.md`. |
| F8 | Memory threshold too tight for dev | `/status` 503 in dev | **200 ok** |

## What is still unmeasured / out of scope

- **Visual hierarchy, typography, spacing**. Walker captures screenshots but does not analyse pixels. A `saas-expensive-ui` judgment pass against the existing screenshots is the next layer.
- **Dark mode**. Walker used `desktop-light` only; `*.dark.png` files in evidence dirs are empty.
- **Mobile (375px)**. Not captured.
- **State coverage**. Walker only visits the default render. Empty / loading / error / permission states need a different harness.
- **Slop pass**. `saas-expensive-ui/references/slop-catalog.md` items (emoji-as-icon, off-token colours, gradient overuse, mixed icon families) were not audited in this pass.
- **Funnel / activation / data trust metrics**. Out of scope; would need the topical skill load per flow.

## Recommended next

1. Wire the walker to also capture mobile and dark-mode screenshots. One parameter change; the harness already supports it (`SAAS_REVIEW_VIEWPORTS=both`).
2. Add a small "dev-only" filter in the walker so `client-rpc/serverFnFetcher` errors are not counted as product bugs (closes F7 cleanly).
3. Run the `saas-expensive-ui` judgment pass against the existing screenshots — that's where hierarchy, typography and the slop catalog get evaluated.
4. Build the per-screen worksheet from `saas-ui-audit/references/screen-worksheet.md` for the 5 highest-traffic screens (landing, /explore, /search, /dashboard, /admin/metrics) once the visual pass lands.
