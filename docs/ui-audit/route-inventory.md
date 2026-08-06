# Route inventory — BuilderHunt

- Generated: 2026-08-06
- Stack: TanStack Start (React 19) + TanStack Router (file-based) + Tailwind 4 + Radix UI + better-auth + TanStack Query + Stripe + OpenAI
- Design system: `--color-bh-*` semantic tokens with full light/dark swap, shadcn/ui aliased, terracotta + cream + cyan, Fraunces for display numbers, Inter for UI, JetBrains Mono for literals. See `src/shared/styles/globals.css` + `DESIGN.md`.
- Discovery: `app-route-inventory/scripts/discover-routes.sh .` + manual read of `src/routeTree.gen.ts` and `src/routes/**`.
- Verification gate (fast subset, used as baseline): `pnpm type-check && pnpm lint && pnpm test:unit`. Heavy gate (`pnpm ci:local`) needs Postgres + Redis; not run for this pass.
- Baseline gate result: **GREEN** — `type-check` clean, `lint` 0 errors (113 pre-existing warnings), `test:unit` 5952/5952 passing (23 skipped, 3 test files skipped).
- Routes found: 282 candidates (75 UI screens + 203 API endpoints + 4 sitemap/robots/asset routes)
- UI screens to visit: 75
- Visited: 0 (not yet — Phase 2 pending scope confirmation)
- Skipped: 0

## Auth model

- **Public** (no auth): `/_landing/*`, `/auth/*`, `/onboarding/*`, `/builders/:id`, `/portfolio/:id`, `/r/:slug`, `/schedule/:invitationId`, `/team/invite/:invitationId`, `/blog/atom.xml`, `/sitemap.xml`, `/robots.txt`.
- **Authenticated** (any role): `/_dashboard/*` (all sub-routes except `/admin/*`). Roles: `owner` | `admin` | `member` within an organization.
- **Admin** (platform-level, separate from org role): `/_dashboard/admin/*` (17 pages). Guarded by `requirePlatformAdmin` in `src/shared/lib/auth/platform-admin.ts`.
- **Public scheduling** (token-based, no auth): `/schedule/$invitationId`. Invite links grant scoped access.

## Inventory table

### Public — marketing/legal (`_landing`)

| Route | File | Auth | Params | Kind | Main job | Primary CTA |
| --- | --- | --- | --- | --- | --- | --- |
| `/` | `src/routes/_landing/index.tsx` | public | — | screen | Landing hero — sell BuilderHunt | "Get started" |
| `/pricing` | `src/routes/_landing/pricing.tsx` | public | — | screen | Show plans | "Start free trial" |
| `/security` | `src/routes/_landing/security.tsx` | public | — | screen | Trust page (security posture) | n/a |
| `/status` | `src/routes/_landing/status.tsx` | public | — | screen | Live platform status | n/a |
| `/roadmap` | `src/routes/_landing/roadmap.tsx` | public | — | screen | Public roadmap | "Suggest a feature" |
| `/crawler` | `src/routes/_landing/crawler.tsx` | public | — | screen | Crawler info for SEO/IR | n/a |
| `/changelog` | `src/routes/_landing/changelog/index.tsx` | public | — | screen | Changelog list | "Read post" |
| `/changelog/:slug` | `src/routes/_landing/changelog/$slug.tsx` | public | slug | screen | Changelog post | "Back to changelog" |
| `/blog` | `src/routes/_landing/blog/index.tsx` | public | — | screen | Blog list | "Read post" |
| `/blog/:slug` | `src/routes/_landing/blog/$slug.tsx` | public | slug | screen | Blog post | n/a |
| `/explore` | `src/routes/_landing/explore/index.tsx` | public | q?, filters? | screen | Public builder search (preview) | "View profile" |
| `/legal/cookies` | `src/routes/_landing/legal/cookies.tsx` | public | — | screen | Cookie policy | n/a |
| `/legal/imprint` | `src/routes/_landing/legal/imprint.tsx` | public | — | screen | Imprint | n/a |
| `/legal/privacy` | `src/routes/_landing/legal/privacy.tsx` | public | — | screen | Privacy policy | n/a |
| `/legal/terms` | `src/routes/_landing/legal/terms.tsx` | public | — | screen | Terms of service | n/a |
| `/privacy/remove` | `src/routes/_landing/privacy/remove.tsx` | public | — | screen | Profile removal request | "Submit request" |
| `/blog/atom.xml` | `src/routes/blog/atom[.]xml.ts` | public | — | feed | RSS | n/a |
| `/sitemap.xml` | `src/routes/sitemap[.]xml.ts` | public | — | feed | SEO sitemap | n/a |
| `/robots.txt` | `src/routes/robots[.]txt.ts` | public | — | file | robots | n/a |

### Public — auth + onboarding

| Route | File | Auth | Params | Kind | Main job | Primary CTA |
| --- | --- | --- | --- | --- | --- | --- |
| `/auth/sign-in` | `src/routes/auth/sign-in.tsx` | public | redirect? | screen | Sign in | "Sign in" |
| `/auth/sign-up` | `src/routes/auth/sign-up.tsx` | public | redirect? | screen | Sign up | "Create account" |
| `/auth/forgot` | `src/routes/auth/forgot.tsx` | public | — | screen | Password reset request | "Send reset link" |
| `/auth/reset` | `src/routes/auth/reset.tsx` | public | token? | screen | Set new password | "Reset password" |
| `/onboarding/welcome` | `src/routes/onboarding/welcome.tsx` | public (gated post-redirect) | — | screen | Onboarding intro | "Get started" |
| `/onboarding/search` | `src/routes/onboarding/search.tsx` | public (gated) | — | screen | First search | "Search" |
| `/onboarding/save` | `src/routes/onboarding/save.tsx` | public (gated) | — | screen | Save first result | "Save" |
| `/onboarding/success` | `src/routes/onboarding/success.tsx` | public (gated) | — | screen | Onboarding done | "Go to dashboard" |

### Public — third-party entry points

| Route | File | Auth | Params | Kind | Main job | Primary CTA |
| --- | --- | --- | --- | --- | --- | --- |
| `/builders/:builderId` | `src/routes/builders/$builderId.tsx` | public | builderId | screen | Public builder profile | "Claim profile" |
| `/portfolio/:claimId` | `src/routes/portfolio/$claimId.tsx` | public | claimId | screen | Public portfolio view | n/a |
| `/r/:slug` | `src/routes/r/$slug.tsx` | public | slug | redirect | Short-link redirector | n/a |
| `/schedule/:invitationId` | `src/routes/schedule/$invitationId.tsx` | public (token) | invitationId | screen | Schedule an interview | "Pick a time" |
| `/team/invite/:invitationId` | `src/routes/team/invite/$invitationId.tsx` | public (token) | invitationId | screen | Accept team invite | "Accept" |

### Authenticated — dashboard core

| Route | File | Auth | Params | Kind | Main job | Primary CTA |
| --- | --- | --- | --- | --- | --- | --- |
| `/dashboard` | `src/routes/_dashboard/dashboard/index.tsx` | authed | — | screen | Overview / KPIs | "Search" |
| `/search` | `src/routes/_dashboard/search/index.tsx` | authed | q?, filters? | screen | Builder search | "Save" |
| `/alerts` | `src/routes/_dashboard/alerts.tsx` | authed | filters? | screen | Alerts inbox | "Mark read" |
| `/calendar` | `src/routes/_dashboard/calendar/index.tsx` | authed | date? | screen | Calendar view | "New event" |
| `/lists` | `src/routes/_dashboard/lists/index.tsx` | authed | — | screen | Saved builder lists | "New list" |
| `/lists/:listId` | `src/routes/_dashboard/lists/$listId.tsx` | authed | listId | screen | List detail | "Add builder" |
| `/sprints` | `src/routes/_dashboard/sprints/index.tsx` | authed | — | screen | Sprints list | "New sprint" |
| `/sprints/new` | `src/routes/_dashboard/sprints/new.tsx` | authed | — | screen | Create sprint | "Create" |
| `/sprints/:sprintId` | `src/routes/_dashboard/sprints/$sprintId/index.tsx` | authed | sprintId | screen | Sprint detail | "Run" |
| `/interviews` | `src/routes/_dashboard/interviews/index.tsx` | authed | — | screen | Interviews list | "Schedule" |
| `/interviews/invitations` | `src/routes/_dashboard/interviews/invitations.tsx` | authed | — | screen | My invitations | "Open" |
| `/interviews/:interviewId` | `src/routes/_dashboard/interviews/$interviewId/index.tsx` | authed | interviewId | screen | Interview detail | "Open report" |
| `/interviews/:interviewId/live` | `src/routes/_dashboard/interviews/$interviewId/live.tsx` | authed | interviewId | screen | Live interview console | "Start recording" |
| `/exports` | `src/routes/_dashboard/exports/index.tsx` | authed | — | screen | Data exports | "New export" |
| `/solutions` | `src/routes/_dashboard/solutions/index.tsx` | authed | — | screen | Solutions (auto-proposals) | "Generate" |
| `/me` | `src/routes/_dashboard/me/index.tsx` | authed | — | screen | My profile | "Edit" |
| `/builder/:builderId` | `src/routes/_dashboard/builder/$builderId/index.tsx` | authed | builderId | screen | Internal builder detail | "Add to list" |
| `/team/activity` | `src/routes/_dashboard/team/activity.tsx` | authed | — | screen | Team activity log | n/a |

### Authenticated — settings (per-role)

| Route | File | Auth | Params | Kind | Main job | Primary CTA |
| --- | --- | --- | --- | --- | --- | --- |
| `/settings/team` | `src/routes/_dashboard/settings/team.tsx` | authed (admin) | — | screen | Team members | "Invite" |
| `/settings/billing` | `src/routes/_dashboard/settings/billing.tsx` | authed (owner) | — | screen | Billing overview | "Manage plan" |
| `/settings/billing` | `src/routes/_dashboard/settings/billing/index.tsx` | authed (owner) | — | screen | Billing (alt) | "Manage plan" |
| `/settings/billing/return` | `src/routes/_dashboard/settings/billing/return.tsx` | authed (owner) | — | screen | Stripe return | n/a |
| `/settings/privacy` | `src/routes/_dashboard/settings/privacy.tsx` | authed | — | screen | Privacy / data export | "Export" |
| `/settings/security` | `src/routes/_dashboard/settings/security.tsx` | authed | — | screen | Security (sessions, 2FA) | "Sign out devices" |

### Authenticated — admin (platform-admin role)

| Route | File | Auth | Params | Kind | Main job | Primary CTA |
| --- | --- | --- | --- | --- | --- | --- |
| `/admin` | `src/routes/_dashboard/admin/index.tsx` | admin | — | screen | Admin home | n/a |
| `/admin/abuse` | `src/routes/_dashboard/admin/abuse.tsx` | admin | — | screen | Abuse signals | "Triage" |
| `/admin/access-requests` | `src/routes/_dashboard/admin/access-requests.tsx` | admin | — | screen | Access requests | "Approve" |
| `/admin/billing` | `src/routes/_dashboard/admin/billing.tsx` | admin | — | screen | Billing ops | "Reconcile" |
| `/admin/changelog` | `src/routes/_dashboard/admin/changelog.tsx` | admin | — | screen | Changelog CMS | "Publish" |
| `/admin/claims` | `src/routes/_dashboard/admin/claims.tsx` | admin | — | screen | Builder claims | "Approve" |
| `/admin/content` | `src/routes/_dashboard/admin/content.tsx` | admin | — | screen | Content CMS | "Publish" |
| `/admin/disputes` | `src/routes/_dashboard/admin/disputes.tsx` | admin | — | screen | Payment disputes | "Resolve" |
| `/admin/incidents` | `src/routes/_dashboard/admin/incidents.tsx` | admin | — | screen | Incidents | "Resolve" |
| `/admin/integrations` | `src/routes/_dashboard/admin/integrations.tsx` | admin | — | screen | Integrations | "Connect" |
| `/admin/metrics` | `src/routes/_dashboard/admin/metrics.tsx` | admin | — | screen | Metrics | n/a |
| `/admin/operations` | `src/routes/_dashboard/admin/operations.tsx` | admin | — | screen | Job runner | "Run now" |
| `/admin/refunds` | `src/routes/_dashboard/admin/refunds.tsx` | admin | — | screen | Refunds | "Issue" |
| `/admin/roadmap` | `src/routes/_dashboard/admin/roadmap.tsx` | admin | — | screen | Roadmap CMS | "Publish" |
| `/admin/solutions-gold-set` | `src/routes/_dashboard/admin/solutions-gold-set.tsx` | admin | — | screen | Gold solutions | "Approve" |
| `/admin/sources` | `src/routes/_dashboard/admin/sources.tsx` | admin | — | screen | Search sources | "Probe" |
| `/admin/users` | `src/routes/_dashboard/admin/users.tsx` | admin | — | screen | Users | "Impersonate" |

## Surfaces that are not routes

- **Modals**: `/dashboard` opens a "create sprint" modal; `/sprints/:id` opens a "shortlist" modal; `/builders/:id` (internal) opens an "evidence" drawer. Need to grep `searchParams`, `?modal=`, `useSearchParams` to enumerate.
- **Tab query params**: `/admin/*` pages appear to use `?tab=` for sub-views. To be confirmed.
- **Onboarding wizard**: 4-step flow above — treat as one flow with 4 screens.
- **Toasts / inline drawers**: not enumerated statically; will catch in Phase 2 walk-through.

## Runtime problems found while walking

(none yet — Phase 2 not started)

## What is NOT in scope by default

- 203 API routes under `src/routes/api/**` — backend only, not UI screens.
- Sitemap/robots/atom — feeds, not screens.
- Error boundaries and redirects (e.g. `/r/:slug`).
- Storybook (not present in this repo).

## Scope decision needed before Phase 2

The full inventory has 75 UI screens across 5 audience buckets (marketing/legal, auth/onboarding, third-party, dashboard core, admin). Visiting all of them in browser with screenshots + state coverage is a multi-hour pass. The skill requires a scope check here.
