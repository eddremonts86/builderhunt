# Feature: Production Infrastructure

## Problem

BuilderHunt está diseñado para correr en localhost con un dev server. Para ir a prod:

1. **In-memory cache** (search.ts) no escala — multi-instance = stale data, single instance = single point of failure
2. **No error tracking** — si algo rompe en prod, nos enteramos cuando un user se queja
3. **No analytics** — no sabemos qué hacen los usuarios
4. **No rate limiting** en endpoints — un bad actor puede hacer scraping masivo
5. **No backups** automatizados de la DB
6. **No uptime monitoring** — si el server cae, no nos enteramos
7. **Sentry DSN está en .env.example** pero no wired en el código
8. **No CDN** — assets servidos directo desde el server

## Goal

Infraestructura de producción battle-tested:

- **Redis** para cache (shared entre instances) + rate limiting + sessions opcionales
- **Sentry** para error tracking + performance monitoring
- **PostHog** (o Plausible) para product analytics
- **Automated DB backups** (daily, 30-day retention)
- **Uptime monitoring** (UptimeRobot, free tier)
- **CDN** (Cloudflare free tier) para assets y DDoS protection
- **Rate limiting** en endpoints públicos

## Non-goals

- **No es Kubernetes.** Coolify/Docker Compose is fine hasta 10k users
- **No es multi-region.** Single region (us-east-1) suficiente para v1
- **No es SOC2 / GDPR-certified infra.** v1: self-hosted en Hetzner o Coolify
- **No es Prometheus + Grafana.** Sentry + UptimeRobot son suficiente
- **No es un CDN para el HTML.** Solo assets (JS, CSS, images, fonts)

## Architecture

```
                    ┌─────────────────────┐
                    │  Cloudflare (CDN)    │ ← DDoS, assets cache
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Coolify / VPS       │ ← Docker, 1 server
                    │  (Hetzner CCX23)      │
                    └──────────┬──────────┘
                               │
            ┌──────────────────┼──────────────────┐
            │                  │                  │
     ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
     │  App        │   │  Postgres   │   │  Redis      │
     │  (Vite/Node)│   │  (Docker)   │   │  (Docker)   │
     └─────────────┘   └─────────────┘   └─────────────┘
            │                  │
            │           ┌──────▼──────┐
            │           │  Backups    │ ← daily, S3-compatible
            │           │  (cron)     │
            │           └─────────────┘
            │
     ┌──────▼──────────────┐
     │  Sentry (errors)    │ ← server + client
     │  PostHog (events)   │ ← product analytics
     │  UptimeRobot        │ ← every 5min
     └─────────────────────┘
```

## Components

### 1. Redis (Upstash or self-hosted)

**Why**: shared cache, rate limiting, future job queue
**Self-hosted**: 1 Docker container, 100MB RAM
**Upstash**: serverless, free tier 10k req/day

**Recommendation**: Self-host on same server (simpler, no extra vendor)

**Use cases**:
- Cache `searchBuilders` results (5min TTL)
- Rate limiting: `INCR rate_limit:{ip}:{endpoint}` with EXPIRE
- Future: BullMQ job queue for background indexing
- Future: session storage (if we move away from Better Auth cookies)

**Files to change**:
- `src/lib/search.ts`: replace in-memory `cache` Map with Redis GET/SET
- `src/routes/api/feeds/$searchId.ts`: rate limiter uses Redis
- `src/routes/api/builders/$builderId/claim.ts`: rate limiter uses Redis

### 2. Sentry (errors + performance)

**Why**: catch production errors before users complain
**Free tier**: 5k events/month
**Setup**: ~30min, env vars only

**What to track**:
- Server errors (uncaught exceptions in API routes)
- Client errors (React render errors, unhandled promise rejections)
- Slow API responses (> 1s, configurable)
- Source map upload for readable stack traces

**Files to add**:
- `src/shared/lib/sentry.ts`: Sentry init (server + client)
- `vite.config.ts`: source maps plugin
- `src/routes/-root-components.tsx`: wrap app in `<Sentry.ErrorBoundary>`
- `src/server.prod.mjs`: Sentry init before app boot

**Key features to use**:
- `Sentry.setUser({ id, email })` after auth
- `Sentry.setTag('plan', 'pro')` for filtering
- Custom performance transaction per API route
- Source maps for both client and server

### 3. PostHog (product analytics)

**Why**: understand what users do, where they drop off
**Free tier**: 1M events/month, self-hostable
**Alternatives**: Plausible (simpler, no events), Mixpanel (richer)

**Recommendation**: PostHog (richer, free tier is enough)

**Events to track** (top 20):
1. `signup` (userId, source)
2. `login` (userId, method)
3. `search` (query, sources, results_count)
4. `save_builder` (builderId, source, query_context)
5. `save_search` (query, sources)
6. `view_builder_profile` (builderId, source)
7. `claim_submitted` (builderId, email_domain)
8. `claim_verified` (builderId)
9. `pricing_view` (userId, currentPlan)
10. `upgrade_clicked` (userId, fromPlan, toPlan)
11. `upgrade_completed` (userId, plan, mrr)
12. `recommendation_impression` (builderId, recId)
13. `recommendation_save` (builderId, recId)
14. `recommendation_dismiss` (builderId, recId)
15. `rss_feed_subscribed` (searchId, reader)
16. `export_people` (count, format)
17. `onboarding_step_complete` (step, timeToComplete)
18. `onboarding_skipped` (step)
19. `invite_team_member` (email)
20. `feature_flag_used` (flag, value)

**Files**:
- `src/shared/lib/analytics.ts`: PostHog init + `track()` helper
- Call `track()` from each event site

### 4. Database backups

**Why**: lose the DB = lose the company
**Cadence**: daily full + hourly incremental (if supported)
**Retention**: 30 daily + 12 monthly
**Storage**: S3-compatible (Backblaze B2, $0.005/GB/month, or Cloudflare R2)

**Script**: `scripts/db/backup.ts`
- Dump with `pg_dump`
- Compress with `gzip`
- Upload to S3 with versioning
- Clean up old backups (>30 days)

**Cron**: daily at 03:00 UTC
- Self-hosted: `crontab` entry
- Coolify: scheduled task

**Restore drill**: monthly, verify backups can be restored

**Files**:
- `scripts/db/backup.ts`
- `scripts/db/restore.ts`
- `docs/runbook/backup-restore.md`

### 5. Uptime monitoring

**UptimeRobot** (free tier, 50 monitors, 5min interval):
- Monitor `https://builderhunt.dev/health`
- Alert via email, Slack, Discord
- 1 status page (`status.builderhunt.dev`)

**Files**:
- `src/routes/api/health.tsx`: already exists, ensure it returns OK with DB ping + Redis ping

### 6. Cloudflare (CDN + DDoS)

**Free tier**:
- Unlimited bandwidth
- 5 DNS rules
- Universal SSL

**What to put behind Cloudflare**:
- All static assets (cache 1 year)
- HTML pages (cache 1 min, with revalidation)
- API routes: pass-through (don't cache dynamic)

**DNS**:
- A record: `builderhunt.dev` → server IP
- A record: `www.builderhunt.dev` → server IP
- CNAME: `api.builderhunt.dev` → server IP
- CNAME: `status.builderhunt.dev` → uptimerobot status page

### 7. Rate limiting (Redis-backed)

**Files to add**: `src/shared/lib/rate-limit.ts`

```ts
async function checkRate(key, limit, windowMs) {
  const count = await redis.incr(key)
  if (count === 1) await redis.expire(key, Math.ceil(windowMs / 1000))
  return count <= limit
}
```

**Limits to enforce** (per IP):
- Search API: 60 req/min
- Recommendations: 30 req/min
- RSS feeds: 60 req/h (already implemented)
- Claim submissions: 5/day (already implemented in-memory)
- Sign up: 10/day
- Sign in: 20/day

**Limits per user**:
- Saved searches creation: 20/day (anti-spam)
- Builder saves: 100/day
- Notes: 50/day

## Data model

**No schema changes** for infra. All in env vars + config.

## API surface

- `src/routes/api/health.tsx` — enhanced health check (DB ping, Redis ping, version)
- `src/shared/lib/sentry.ts` — Sentry init
- `src/shared/lib/redis.ts` — Redis client
- `src/shared/lib/rate-limit.ts` — rate limiting helpers
- `src/shared/lib/analytics.ts` — PostHog init + track

## Success metrics

- **Primary**: 99.5% uptime (3.6h downtime/month acceptable)
- **Secondary**: P95 API response time < 500ms
- **Tertiary**: 0 silent errors (every error logged to Sentry)
- **Guardrail**: Rate limit hits < 1% of legitimate traffic

## Out of scope (v1)

- Multi-region deployment
- Kubernetes / auto-scaling
- SOC2 / ISO27001
- Custom analytics dashboards (use PostHog's UI)
- A/B testing framework
- Feature flags beyond env-based toggles

## Open questions

- **Self-hosted Redis vs Upstash?** Self-host (simpler, no extra vendor, no egress fees)
- **Sentry vs Rollbar vs Bugsnag?** Sentry (best DX, generous free tier)
- **PostHog cloud vs self-host?** Cloud (free tier is enough, no ops burden)
- **Backup storage?** Cloudflare R2 (no egress fees, S3-compatible)

## Dependencies

- New packages: `ioredis` (Redis client), `@sentry/node`, `@sentry/react`, `posthog-js`, `posthog-node`
- New env vars: `REDIS_URL`, `SENTRY_DSN`, `POSTHOG_API_KEY`, `POSTHOG_HOST`, `BACKUP_S3_*`
- New services: Upstash Redis (or self-host), Sentry account, PostHog account, UptimeRobot account, Cloudflare account

## Estimated effort

| Phase | Effort |
|-------|--------|
| 1 — Redis + cache | S (3-4h) |
| 2 — Sentry | S (2-3h) |
| 3 — PostHog | S (3-4h) |
| 4 — Backups | S (2-3h) |
| 5 — UptimeRobot + health check | XS (1-2h) |
| 6 — Cloudflare | S (2-3h) |
| 7 — Rate limiting | S (3-4h) |
| **Total** | **~3 days** |
