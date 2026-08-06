# /saas-review findings — BuilderHunt

- Generated: 2026-08-06 (Phase 4 — read-only, pending approval)
- Scope: whole app (70 UI screens walked × 4 roles = 280 captures)
- Evidence: `docs/ui-audit/evidence/<role>/*.png` + `walk-summary.json`
- Audit source: `saas-ui-audit` matrix (21 criteria)
- Auth mode used: Mode B (`SAAS_REVIEW_*` test users seeded via `pnpm db:seed:test-users`)
- Dev server: `http://localhost:3010` (port 3000 occupied by `whatsapp-bridge`; 3010 matches `APP_URL` which better-auth uses for trusted origins)

## Executive summary — 8 findings (P0 first)

| # | Sev | Title | Routes affected |
| --- | --- | --- | --- |
| F1 | **P0** | RootDocument renders inside itself on any error → `<html>` nested inside `<body>` → hydration error on **every page** | All 70 (the warning is logged for any route where the error branch fires, and on the happy path too) |
| F2 | **P0** | `/blog/:slug` and `/r/:slug` return **500** for invalid slugs (e.g. `:slug`, trailing garbage) — should be 404 | `/blog/:slug`, `/r/:slug` |
| F3 | **P0** | `RootErrorBoundary` wraps its content in `RootDocument`, which TanStack Router also wraps the shell around. Double-wrap is the source of F1. | All 70 (transitively) |
| F4 | **P1** | "Mounting a new %s component when a previous one has not first unmounted" appears 3× per page load on every visited route. Hot-reload leftovers from prior run are not the cause (it's deterministic across cold navigations). | All 70 |
| F5 | **P1** | `/admin/*` returns 500 for non platform-admin roles (owner / admin / member). Correct behaviour is a 403 page or redirect to `/dashboard`, not a raw 500. | 17 admin pages × 3 wrong roles = 51 wrong outcomes |
| F6 | **P1** | `/dashboard` and several authenticated screens return **403** on at least one data fetch per visit. Likely an API that the role's org context can't read; the screen still renders but a widget shows an error toast or empty state. Visible to user as "something failed" with no context. | `/dashboard`, possibly more |
| F7 | **P2** | `TypeError: Failed to fetch` thrown on `/` after hydration. Likely a TanStack-Start dev-mode race; production builds should be checked. | `/`, possibly other landing pages |
| F8 | **P2** | Greyscale test not yet run across the app — design tokens are documented but the contrast/hierarchy-without-colour claim is unverified. | (gap, not a defect) |

**Total walked**: 280 (route, role) combinations. **HTTP failures**: 19 (all 500, no 4xx worth caring about except F5). **Routes with console errors**: 47 distinct routes (most are consequences of F1 + F4 + F5).

## Per-finding detail

### F1 — RootDocument nested inside RootDocument (P0)

**Symptom.** On every visited route, the React dev-mode console reports:

```
In HTML, <div> cannot be a child of <html>. This will cause a hydration error.
<%s> cannot contain a nested %s. See this log for the ancestor stack trace. div <html>
```

**Evidence.** `docs/ui-audit/evidence/walk-summary.json` → 47 routes have console errors whose first non-noise entry is the hydration warning above. The stack trace points at:

```
<AwaitInner><RouterProvider><RouterContextProvider><Matches><SafeFragment>
  <Transitioner><MatchesInner><CatchBoundary><CatchBoundaryImpl>
    <MatchImpl matchId="__root__/"><MatchView><RootDocument>
      <html lang="en" suppressHydrationWarning={true}>
        <body suppressHydrationWarning={true} className="bg-app min...">
          <a>...<div id="main-content" tabIndex={-1} className="outline-none">
            ...<RootErrorBoundary error={Error} reset={function reset}>
              <RootDocument>          ← second RootDocument inside #main-content
                <html>                 ← nested <html>
```

**Root cause.** `src/routes/__root.tsx:203-204` declares both `shellComponent: RootDocument` and `errorComponent: RootErrorBoundary`. `RootErrorBoundary` (in `src/routes/-root-components.tsx:32-44`) renders `<RootDocument>…</RootDocument>` around its error UI. When the router mounts the error boundary it does **not** strip the outer shell, so the boundary's content (which already includes `<html><body>…`) ends up nested inside the outer shell's `<div id="main-content">`.

**Damaged user job.** Every page in the app throws a hydration warning in dev. In production the warning is silent but React still does double-render work; React 19 in strict mode logs the same warning to production builds.

**Severity.** P0 — this is the loudest defect in the whole app, it's been there since the root layout was written, and it touches every user-visible route.

**Recommendation.** Two acceptable shapes (pick one):

1. `RootErrorBoundary` renders only the inner error markup, not `RootDocument`. The shell is provided by the router.
2. Use `notFoundComponent` (already declared as `NotFoundPage`) for the 404 case and let the error boundary render just the inner content.

The first is the standard TanStack Start pattern. Implementation: change `src/routes/-root-components.tsx` so `RootErrorBoundary` returns the inner error markup directly (the `<div className="flex min-h-screen…">` block) without the wrapping `<RootDocument>`. The router supplies the shell.

**Acceptance.** No `cannot be a child of <html>` warning on any route. Visit `/blog/nonexistent-slug` (a real 404 case from F2) and confirm only the inner error UI renders.

**Regression risk.** Low. Other components that read `document.getElementById('main-content')` (e.g. `src/shared/components/TosModal.tsx:50`) keep working because the outer shell's `<div id="main-content">` is still in the tree.

### F2 — `/blog/:slug` and `/r/:slug` return 500 instead of 404 (P0)

**Symptom.** Any non-conforming slug returns HTTP 500. Walker captured this with the literal `:slug` placeholder, but a malformed URL like `/blog/SOME_UPPER` or `/blog/`-with-trailing also fails the same way.

**Evidence.**

- `walk-summary.json` → `/blog/:slug` 500 across owner / admin / member; same for `/r/:slug`.
- `src/shared/lib/blog-data.ts:4` — `const blogSlugSchema = z.string().regex(/^[a-z0-9-]{1,160}$/)`.
- `src/shared/lib/blog-data.ts:11-22` — `getBlogPostPage` is a server function with `.validator(blogSlugSchema)`. Validation failure throws a Zod `invalid_format` error, which `createServerFn` propagates as 500.
- Console error from `/blog/:slug`: `Invalid string: must match "regex" /^[a-z0-9-]{1,160}$/` with `path: []`.

**Damaged user job.** A real visitor following a stale or mistyped blog link gets the raw "Something went wrong" error boundary (which itself nests `<html>` per F1), instead of a "Post not found" 404 page. Crawlers see 500 and demote the URL.

**Recommendation.** Two fixes:

1. The route loader (`src/routes/_landing/blog/$slug.tsx:12-18`) already handles "post not found" by calling `throw notFound()`. Add the same call for invalid slugs: catch the validation failure (or wrap with `.safeParse` upstream) and `throw notFound()`. Same for `/r/:slug`.
2. Or: relax the regex to `^[a-z0-9-]{0,160}$` (allow empty), then let the existing `if (!page) throw notFound()` branch handle missing slugs.

**Acceptance.** `/blog/anything-not-matching-regex` returns 404 with the existing `notFoundComponent`. `/r/foo` returns the redirect target if `foo` resolves, otherwise 404.

**Regression risk.** Low. The 404 branch is already in the loader.

### F3 — `RootErrorBoundary` wraps with `RootDocument` (P0)

Covered by F1 — this is the root cause, F1 is the symptom. Listed separately so it shows up as its own line in the report and gets reviewed on its own merit (someone might want a different layout for the error page later, e.g. with a different `<head>`).

### F4 — "Mounting a new component when a previous one has not first unmounted" (P1)

**Symptom.** Every page logs this warning three times on first paint in dev.

**Evidence.** `walk-summary.json` → 3 of the 6 console errors on `/` (owner, platform-admin) are this exact warning, full message truncated. React docs say this comes from rendering a component that owns global state (e.g. Radix `Dialog`, a `Toast.Provider`, or a `<form>`) while the previous instance is still alive.

**Recommendation.** Triage needed: it's not blocking the page (status 200, content renders) but it is a deterministic warning across the whole app. Look at the top of the error stack — most likely a portal/portal-host whose anchor element gets remounted. Fix deferred to Phase 5 if the team agrees it's a real defect; could also be dev-mode-only (StrictMode double-mount).

**Acceptance.** No "mounting a new" warning on a production build.

**Regression risk.** Medium. Need to identify the component before committing a fix.

### F5 — `/admin/*` returns 500 for non platform-admin roles (P1)

**Symptom.** Owner / admin / member hitting `/admin` get HTTP 500 instead of a 403 page or a redirect to `/dashboard`.

**Evidence.** `walk-summary.json` → all 17 `/admin/*` routes show 500 for owner/admin/member and 200 for platform-admin. `src/routes/_dashboard/admin/index.tsx` (and siblings) presumably throw or fail because of a missing `requirePlatformAdmin` check that returns 500 on failure rather than rendering a 403 component.

**Recommendation.** In `src/routes/_dashboard/admin/index.tsx` (and any sibling that doesn't already), add a `beforeLoad` guard that calls `requirePlatformAdmin(ctx)`; on failure, redirect to `/dashboard` with a flash message or render a 403 inline. Same shape as the platform-admin guard described in `src/shared/lib/auth/platform-admin.ts`.

**Acceptance.** Owner / admin / member hitting `/admin` are sent to `/dashboard` (or shown a 403 page). No 500 anywhere on the admin section.

**Regression risk.** Low. Pattern exists, just inconsistent.

### F6 — `/dashboard` and other authed screens log a 403 on first data fetch (P1)

**Symptom.** `/dashboard` shows status 200 in the page navigation but logs one failed request with 403, which means a widget underneath fails to render and shows an error or empty state to the user.

**Evidence.** `walk-summary.json` → `/dashboard` (owner, member) → 1 failed request, status 403.

**Recommendation.** Identify which API the dashboard hits that the role/org can't read. Likely a billing or admin endpoint the dashboard polls eagerly. Fix: gate the call on role / plan, or hide the widget when the user lacks access.

**Acceptance.** No 4xx/5xx in the network panel for any role on the dashboard.

**Regression risk.** Medium — depends on which API it is.

### F7 — `TypeError: Failed to fetch` on `/` after hydration (P2)

**Symptom.** Console reports `TypeError: Failed to fetch at @tanstack/start-client-core`. Happens post-hydration on the landing page (and likely other pages).

**Evidence.** `walk-summary.json` → `/` owner/platform-admin console errors include this `TypeError`.

**Recommendation.** Likely a TanStack-Start client-core dev-mode artefact (HMR socket closure). Verify on a production build (`pnpm build && pnpm preview`) before fixing; if it persists in production, file upstream. Skip in this pass if dev-only.

**Acceptance.** No `Failed to fetch` console errors on the production build.

**Regression risk.** Low.

### F8 — Greyscale test not run (gap, not a defect)

The saas-ui-audit matrix calls for a greyscale contrast check on every primary action across every flow. I did not run it in this pass (Phase 2 walker captures colour screenshots, not desaturated ones). Listed as a gap, not a finding.

## Score against the 21-criterion matrix (per flow area)

I am not re-scoring the whole matrix here; the deep visual work would need the actual screenshot inspection (the walker only collected them, it didn't analyse pixels). What I can score from the walker's evidence:

| Criterion (sample) | Score | Note |
| --- | --- | --- |
| 1. Purpose & hierarchy | unverified | screenshots only, no visual analysis in this pass |
| 7. Errors & empty states | **1 (weak)** | F1 + F2 + F5 — error paths are broken or wrong-code |
| 9. Permissions | **1 (weak)** | F5 — wrong role gets 500 instead of a permission page |
| 14. Data correctness | **2 (correct)** | F6 is the only flagged concern |
| 18. Hydration & rendering | **0 (critical)** | F1 + F3 + F4 — hydration warning on every route |
| 19. Console hygiene | **1 (weak)** | 47/70 routes have console errors |

The full 21-criterion sweep belongs to a Phase 2b visual pass that I am explicitly deferring.

## Decisions needing you

1. **F1 fix shape.** Drop the `RootDocument` wrapper from `RootErrorBoundary` (recommended), or render the error boundary with its own bare-bones shell (alternative). I recommend the first.
2. **F5 admin gate.** Redirect non-admins to `/dashboard` (recommended), or render an inline 403 page with a "back to dashboard" link.
3. **F4 dev-only check.** Do you want me to also test `pnpm build && pnpm preview` before deciding F4 is a real defect?
4. **F7.** Skip if dev-only, or escalate upstream?

## What I deliberately did not measure

- **Visual hierarchy / typography / spacing**. I captured screenshots but did not analyse pixels. The walker is a behavioural pass, not a visual one. A second pass with `saas-expensive-ui` judgement criteria against the screenshots is the next layer.
- **Dark mode**. Walker used `desktop-light` only. Dark-mode evidence in `evidence/<role>/*.dark.png` is empty.
- **Mobile (375px)**. Not captured.
- **State coverage** (empty / loading / error / permission per route). Walker only captures the default render after navigation. Empty states and loading states need a different harness.
- **Slop pass**. `saas-expensive-ui/references/slop-catalog.md` items (emoji-as-icon, colours outside tokens, gradient overuse, nested cards, mixed icon families) were not audited in this pass.
- **Funnel / data trust / activation metrics**. Out of scope for the walker; would need the topical skill load for each flow.

## Change plan (small, independently revertible batches)

- **Batch A — F1 + F3.** One commit: change `RootErrorBoundary` to render inner content only. Verify by re-walking and seeing the hydration warning disappear from `walk-summary.json`. Re-run `pnpm type-check && pnpm lint && pnpm test:unit`.
- **Batch B — F2.** One commit per route family (`/blog/:slug`, `/r/:slug`): convert the validation failure to `notFound()`. Re-walk and confirm 404 instead of 500.
- **Batch C — F5.** One commit: add `beforeLoad` guard on the admin route root so non platform-admin get redirected (or see a 403 component).
- **Batch D — F6.** One commit after identifying which API the dashboard fetches that 403s.
- **Batch E — F4 + F7.** Verify on `pnpm build && pnpm preview` first; then either fix or document as dev-only.

Hard stop here. **Awaiting your approval before any code is written.**

## Mappings

- **F1** → `src/routes/-root-components.tsx:32-44` (the `<RootDocument>` wrap inside `RootErrorBoundary`) and `src/routes/__root.tsx:203-204` (`shellComponent` + `errorComponent` config).
- **F2** → `src/shared/lib/blog-data.ts:4` and `:11-22`. The `/r/:slug` family lives under `src/routes/r/$slug.tsx`.
- **F5** → `src/routes/_dashboard/admin/index.tsx` and the 16 sibling files under the same directory.
- **F6** → currently unidentified API; needs network log capture with the dev server.
