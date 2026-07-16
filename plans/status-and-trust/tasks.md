# Tasks: Status & Trust

## Phase 0 — Research

- [ ] Check UptimeRobot free tier (50 monitors, 5min interval)
- [ ] Decide: Canny.io (free tier) vs in-house roadmap
- [ ] Read `src/routes/api/health.tsx` — current health endpoint

## Phase 1 — Data model

- [ ] Add `incidents`, `changelog`, `status_subscribers` tables to schema
- [ ] Generate + apply migration

## Phase 2 — Status page

File: `src/routes/status.tsx` (new, public)

- [ ] Hero: "All systems operational" or active incident summary
- [ ] Component list: App, API, Database, Email, Search, Redis, Stripe, Auth
- [ ] Each: green ✓ if healthy, yellow ⚠ if degraded, red ✗ if down
- [ ] Auto-refresh every 30s (client-side `setInterval`)
- [ ] 30-day uptime percentage
- [ ] Recent incidents list (last 5)
- [ ] Subscribe form

File: `src/routes/api/status/index.ts` (new, GET)

- [ ] Runs all health checks (DB, Redis, Resend, Stripe)
- [ ] Queries open incidents from DB
- [ ] Returns aggregated status

File: `src/routes/api/status/subscribe.ts` (new, POST)

- [ ] Body: `{ email }`
- [ ] Insert into `status_subscribers` (with verification email)

## Phase 3 — Incidents

File: `src/routes/api/incidents/index.ts` (new, GET)

- [ ] Returns incidents from last 90 days

File: `src/routes/api/admin/incidents/index.ts` (new, POST)

- [ ] Auth required (admin role)
- [ ] Body: `{ title, description, severity }`
- [ ] Insert incident, set status='investigating'
- [ ] Send email to all status_subscribers
- [ ] Return incident id

File: `src/routes/api/admin/incidents/$id.ts` (new, PATCH)

- [ ] Auth required
- [ ] Update status, resolved_at
- [ ] Send resolution email to subscribers

## Phase 4 — Changelog

File: `src/routes/changelog.tsx` (new, public)

- [ ] List latest 20 entries
- [ ] Each: date, title, excerpt, tags
- [ ] RSS link

File: `src/routes/changelog/$slug.tsx` (new, public)

- [ ] Full entry, rendered from markdown

File: `src/routes/api/changelog/index.ts` (new, GET)

- [ ] List (paginated)

File: `src/routes/api/changelog/$slug.ts` (new, GET)

- [ ] Single entry by slug

File: `src/routes/api/admin/changelog/index.ts` (new, POST)

- [ ] Auth required
- [ ] Create entry
- [ ] Trigger weekly digest (Sunday 9am) — set up cron

File: `src/routes/api/admin/changelog/$id.ts` (new, PATCH/DELETE)

- [ ] Auth required
- [ ] Edit or delete

## Phase 5 — Roadmap

Decision: use Canny.io free tier

- [ ] Sign up at canny.io
- [ ] Create BuilderHunt board
- [ ] Seed 10 items (matches existing /plans/ folder)
- [ ] Get embed code
- [ ] File: `src/routes/roadmap.tsx` (new, public) — Canny embed

## Phase 6 — Subscription emails

File: `src/shared/lib/email-templates/status-incident.tsx`

- [ ] "🚨 BuilderHunt is experiencing [incident]"
- [ ] Body: title, description, what to do

File: `src/shared/lib/email-templates/status-resolved.tsx`

- [ ] "✅ [Incident] has been resolved"
- [ ] Body: duration, postmortem link

File: `src/shared/lib/email-templates/changelog-weekly.tsx`

- [ ] "This week in BuilderHunt"
- [ ] List of last week's changelog entries

**Cron**:
- `scripts/jobs/send-changelog-digest.ts` — Sunday 9am UTC, find changelog entries from last 7 days, send to subscribers
- `scripts/jobs/check-incidents.ts` — every 5min, check for newly-resolved incidents, send emails

## Phase 7 — Admin CMS

File: `src/routes/_dashboard/admin/incidents.tsx` (new)

- [ ] List incidents
- [ ] "Create new" form: title, severity, description
- [ ] Click incident → edit form: update status, add postmortem
- [ ] "Resolved at" datetime picker

File: `src/routes/_dashboard/admin/changelog.tsx` (new)

- [ ] List changelog entries
- [ ] "New entry" form: title, content (markdown editor), tags
- [ ] Click entry → edit
- [ ] Publish/draft toggle

## Phase 8 — Footer updates

File: `src/shared/components/Footer.tsx` (new or extend)

- [ ] Links: Pricing, About, Blog, **Status**, **Changelog**, **Roadmap**
- [ ] Legal: Terms, Privacy, Cookies, Imprint

## Phase 9 — UptimeRobot setup

- [ ] Sign up at uptimerobot.com
- [ ] Add monitor: `https://builderhunt.dev/api/status` (5min interval, expects 200)
- [ ] Add contact: email + Slack webhook
- [ ] Create status page: `https://status.builderhunt.dev` (UptimeRobot free tier)
- [ ] Add DNS CNAME for `status.builderhunt.dev` → UptimeRobot

## Phase 10 — Verification

### Manual
- [ ] /status shows all green when healthy
- [ ] /status shows red when DB down (test: stop docker, check)
- [ ] Create incident in /admin/incidents → status page updates within 30s
- [ ] Subscribe to status → receive email
- [ ] Create changelog entry in /admin/changelog → /changelog shows it
- [ ] /roadmap shows Canny board

### Automated
- [ ] Playwright: /status renders
- [ ] Playwright: /changelog renders
- [ ] /api/status returns valid JSON

### Performance
- [ ] /status TTFB < 300ms
- [ ] Auto-refresh doesn't cause flicker

## Phase 11 — Rollout

- [ ] Deploy with `ENABLE_STATUS_PAGE=true`
- [ ] Add to footer on all public pages
- [ ] Add to landing page
- [ ] Email existing users: "We added a status page and changelog"

## Edge cases

- **Health check flaky**: require 3 consecutive failures before marking down
- **Incident during deploy**: auto-mark as investigating, then resolved when deploy done
- **Changelog with no content**: don't publish (require both title and content)
- **Roadmap vote fraud**: rate limit (1 vote per user per item per day)
- **Subscriber email bounces**: remove from list

## Dependencies

- New tables: 3 (`incidents`, `changelog`, `status_subscribers`)
- New package: none
- Schema migrations: 3 new tables
- New env vars: `STATUS_PAGE_URL`
- New services: UptimeRobot (free), Canny.io (free)
- New background jobs: 2 (changelog digest, incident emails)
- New pages: 5 routes (status, changelog, changelog/$slug, roadmap, admin/*)

## Estimated effort: 2-3 days
