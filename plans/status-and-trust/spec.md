# Feature: Status Page & Trust Signals

## Problem

Sin status page:
1. **Cuando algo cae**, los users se quejan en Twitter en vez de ver "investigando"
2. **No hay transparencia** sobre uptime o incidents
3. **No hay changelog** — los users no saben qué cambió
4. **No hay public roadmap** — no pueden votar features
5. **Pierde confianza** — parece proyecto amateur

## Goal

- **Status page** (`/status`) — tiempo real, incidentes históricos
- **Changelog** (`/changelog`) — qué se shippeó cada semana
- **Public roadmap** (`/roadmap`) — qué viene, qué se está votando

## Non-goals (v1)

- **No es incident management interno.** Para eso usamos Incident.io o similar
- **No es un blog de producto.** Eso es `content-marketing`
- **No es feedback collection system.** Para eso usamos Canny o similar
- **No es un customer support portal.** Para eso usamos Intercom o HelpScout

## User stories

1. **Como user**, cuando algo no funciona, quiero ver "investigando" sin tener que mandar email
2. **Como user**, quiero ver qué cambió en las últimas semanas
3. **Como user**, quiero votar features que quiero que se implementen
4. **Como prospect**, quiero ver que el producto es activo (commits frecuentes, status verde)

## Pages

### 1. `/status` — public status page

**Live indicators**:
- App: operational / degraded / outage
- API: operational
- Search: operational
- Database: operational
- Email (Resend): operational

**Auto-refreshes every 30s** via client-side polling (no WebSocket complexity v1)

**Historical incidents** (last 90 days):
- Date
- Duration
- Title
- Status (resolved / monitoring)
- Postmortem link (if any)

**Subscribe to updates**:
- "Get email when something breaks"
- Form: email → subscribe

**Powered by**: UptimeRobot (free tier, 50 monitors)

**Implementation**:
- Status data from `/api/health` endpoint (checks DB, Redis, Resend, Stripe)
- Incidents table in DB
- Subscribe: insert into `status_subscribers` table

### 2. `/changelog` — public changelog

**Latest 20 entries**:
```
2026-07-16 — Claimable Builder Profiles
   Builders can now claim their profile, get a Verified badge,
   and enrich their data. Open to mentoring, hires, etc.

2026-07-15 — RSS feeds for saved searches
   Every saved search now has a public RSS feed...

2026-07-10 — Stack Overflow integration
   We added Stack Overflow top answerers as a source...
```

**Subscribe**:
- "Get email when we ship"
- RSS feed of changelog

**Implementation**:
- New table: `changelog` (id, title, content, slug, published_at, tags)
- CMS in `/admin/changelog` (basic form)
- Public: `/changelog` and `/changelog/[slug]`

### 3. `/roadmap` — public roadmap

**3 columns**:
- **Planned** (next 1-3 months): "GitLab integration", "Smart alerts", "Code fingerprinting"
- **In progress** (this month): "Pricing tiers", "Onboarding flow", "GDPR data export"
- **Shipped** (last 30 days): link to /changelog

**Each item**:
- Title + 1-line description
- Estimated ship date
- Vote button: "I want this" (anonymous: email; authed: 1-click)
- Comment count

**Implementation**:
- New table: `roadmap_items` (id, title, description, status, ship_estimate, votes_count)
- New table: `roadmap_votes` (item_id, user_id, created_at)
- Or use Canny.io embedded widget (cheaper, no in-house build)

**Recommendation**: Canny.io for v1 ($0/mo free tier, 100 votes/month). Save the in-house build for when we hit 1000 votes.

### 4. Footer updates

Add to `/` and `/dashboard`:
```
[ Pricing ] [ About ] [ Blog ] [ Status ] [ Changelog ] [ Roadmap ]
```

Each link to the corresponding public page.

## Data model

**New tables**:

```sql
CREATE TABLE incidents (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'investigating',  -- 'investigating' | 'identified' | 'monitoring' | 'resolved'
  severity text NOT NULL DEFAULT 'minor',  -- 'minor' | 'major' | 'critical'
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  resolved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE changelog (
  id text PRIMARY KEY,
  title text NOT NULL,
  content text NOT NULL,  -- markdown
  slug text NOT NULL UNIQUE,
  tags jsonb DEFAULT '[]'::jsonb,  -- ['feature', 'bugfix', 'breaking']
  published_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE status_subscribers (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  verified boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone DEFAULT now()
);
```

## API endpoints

- `GET /api/status` — current status (from health checks + open incidents)
- `GET /api/incidents` — list past incidents (last 90 days)
- `POST /api/status/subscribe` — subscribe to status emails
- `GET /api/changelog` — list (paginated)
- `GET /api/changelog/[slug]` — single entry
- `POST /api/admin/incidents` — admin creates incident
- `POST /api/admin/changelog` — admin creates changelog entry

## Incident management

**Admin flow** (manual for v1):
1. Something breaks
2. Admin goes to `/admin/incidents/new`
3. Creates incident: title, severity, description
4. Status page auto-updates
5. Subscribers get email
6. When fixed, admin updates status='resolved'
7. Subscribers get resolution email
8. Postmortem (optional): admin adds markdown postmortem

**Auto-detection** (v2):
- Sentry spike → auto-create incident
- Health check fails 3 times → auto-create incident
- Stripe webhook failed → auto-create incident

## Changelog workflow

**Admin creates entry** when shipping a feature:
- Title: "Stack Overflow integration"
- Content: markdown description, screenshots, links
- Tags: ['feature', 'breaking']
- Publish: immediately

**Public sees**:
- `/changelog` shows all entries (newest first)
- RSS feed: `/changelog/rss`
- Email: weekly digest (Sunday) of all entries from past 7 days

## Subscription emails

- Status incidents: immediate when created, immediate when resolved
- Changelog: weekly digest
- Both opt-in via separate forms

## UX flow

### /status

```
┌─────────────────────────────────────────────────┐
│  All systems operational                          │
│  Updated 2 minutes ago                            │
│                                                  │
│  ✓ App    ✓ API    ✓ Database    ✓ Email        │
│  ✓ Search ✓ Redis  ✓ Stripe      ✓ Auth         │
│                                                  │
│  30-day uptime: 99.94%                           │
│  [ View history ]                                │
│                                                  │
│  Recent incidents:                                │
│  2026-07-12  Resolved  3h outage  [Postmortem]   │
│  2026-06-28  Resolved  20m slow responses        │
│                                                  │
│  [ Get email alerts when something breaks ]      │
└─────────────────────────────────────────────────┘
```

### /changelog

```
┌─────────────────────────────────────────────────┐
│  Changelog                                       │
│  What we shipped. Subscribe to the RSS feed.   │
│                                                  │
│  2026-07-16                                      │
│  ━━━━━━━━━━━━━━                                 │
│  Claimable Builder Profiles                     │
│  Builders can now claim their profile...         │
│  [feature]                                       │
│                                                  │
│  2026-07-15                                      │
│  ━━━━━━━━━━━━━━                                 │
│  RSS feeds for saved searches                    │
│  ...                                             │
│                                                  │
│  [ Subscribe via RSS ]                           │
└─────────────────────────────────────────────────┘
```

### /roadmap

```
┌─────────────────────────────────────────────────┐
│  Roadmap                                         │
│  What we're building. Vote on what matters.    │
│                                                  │
│  PLANNED          IN PROGRESS     SHIPPED        │
│  ━━━━━━━          ━━━━━━━━━━━     ━━━━━━━        │
│  □ Code           ⚙ Pricing       ✓ Claimable    │
│    fingerprint     tiers           profiles       │
│    [24 votes]                                     │
│  □ Smart          ⚙ Onboarding    ✓ RSS feeds    │
│    alerts          [12 votes]                    │
│  □ Team           ⚙ Production                   │
│    features        infra                         │
│    [8 votes]                                      │
│                                                  │
│  [ Submit an idea ]                              │
└─────────────────────────────────────────────────┘
```

## Success metrics

- **Primary**: 99.5% uptime (3.6h downtime/month)
- **Secondary**: Mean time to acknowledge (MTTA) < 15 min during incidents
- **Tertiary**: Changelog open rate > 25%
- **Roadmap votes**: > 100 votes in first month

## Out of scope (v1)

- Auto-detection of incidents from Sentry/Stripe
- Postmortem template system
- Customer support integration (Intercom)
- In-app notification of incidents
- Per-component status (we'll just have app-wide)
- Public API for status (other services consuming us)

## Open questions

- **Canny.io or in-house roadmap?** Canny for v1 ($0 free tier), in-house if we hit 1000 votes
- **Auto-detect incidents?** v1: manual. v2: Sentry + Stripe webhooks
- **Public roadmap editing?** Admin only for v1, no community submission

## Dependencies

- New tables: 3 (`incidents`, `changelog`, `status_subscribers`)
- New package: none
- Schema migrations: 3 new tables
- New env vars: `STATUS_PAGE_URL`
- Optional: Canny.io account ($0/mo free tier)
- New pages: 3 routes (`/status`, `/changelog`, `/roadmap`)
- New admin: 2 routes (`/admin/incidents`, `/admin/changelog`)

## Estimated effort

| Phase | Effort |
|-------|--------|
| 1 — Status page | S (3-4h) |
| 2 — Changelog | S (3-4h) |
| 3 — Roadmap (with Canny embed) | XS (1-2h) |
| 4 — Subscription emails | S (2-3h) |
| 5 — Admin CMS | M (4-6h) |
| 6 — Footer updates | XS (1h) |
| **Total** | **~2-3 days** |
