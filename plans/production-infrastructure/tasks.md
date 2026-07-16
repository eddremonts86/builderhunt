# Tasks: Production Infrastructure

## Phase 0 — Audit current state

- [ ] Read `src/lib/search.ts` — find in-memory cache
- [ ] Read `src/server.prod.mjs` — understand current production entry
- [ ] Read `src/routes/api/health.tsx` — current health endpoint
- [ ] Read `Dockerfile` and `docker-compose.yml` — current deploy story
- [ ] Confirm Sentry DSN in .env.example is unused (search code for it)

## Phase 1 — Redis

- [ ] Add Redis to `docker-compose.yml` (image: `redis:7-alpine`, port 6379)
- [ ] `pnpm add ioredis`
- [ ] Create `src/shared/lib/redis.ts` (singleton client, lazy connect)
- [ ] Add `REDIS_URL` to `src/shared/lib/env.ts`
- [ ] Refactor `src/lib/search.ts`: replace `Map<string, ...>` with Redis `get`/`setex`
- [ ] Refactor `src/routes/api/feeds/$searchId.ts`: rate limiter uses Redis
- [ ] Refactor `src/routes/api/builders/$builderId/claim.ts`: rate limiter uses Redis
- [ ] Test: cache hit reduces API calls; rate limit persists across restarts

## Phase 2 — Sentry

- [ ] Sign up at sentry.io, create project
- [ ] `pnpm add @sentry/node @sentry/react`
- [ ] Create `src/shared/lib/sentry.ts` (server init + client init)
- [ ] `vite.config.ts`: add `sentryVitePlugin()` for source maps
- [ ] `src/server.prod.mjs`: Sentry.init() before app boots
- [ ] `src/routes/-root-components.tsx`: wrap routes in `<Sentry.ErrorBoundary>`
- [ ] `src/shared/lib/auth/better-auth.ts`: call `Sentry.setUser()` after session validation
- [ ] Set `SENTRY_DSN` env var
- [ ] Test: trigger an error, verify it appears in Sentry dashboard
- [ ] Configure alert rules (new error type, error rate spike)

## Phase 3 — PostHog

- [ ] Sign up at posthog.com, get API key
- [ ] `pnpm add posthog-js posthog-node`
- [ ] Create `src/shared/lib/analytics.ts` (init + `track()` helper)
- [ ] `src/main.tsx` (or equivalent): init client-side PostHog
- [ ] `src/server.prod.mjs`: init server-side PostHog
- [ ] Set `POSTHOG_API_KEY`, `POSTHOG_HOST` env vars
- [ ] Instrument top 20 events (signup, login, search, save_builder, save_search, claim, etc.)
- [ ] Test: trigger events, verify they appear in PostHog dashboard

## Phase 4 — Database backups

- [ ] Sign up for Cloudflare R2 (or Backblaze B2)
- [ ] Create bucket `builderhunt-backups`
- [ ] Create R2 access key, set env vars: `BACKUP_S3_KEY_ID`, `BACKUP_S3_KEY_SECRET`, `BACKUP_S3_BUCKET`
- [ ] `pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage` (or use `rclone` instead)
- [ ] Create `scripts/db/backup.ts`: pg_dump → gzip → S3 upload
- [ ] Create `scripts/db/restore.ts`: download from S3 → gunzip → pg_restore
- [ ] Create `scripts/db/list-backups.ts`: show available backups
- [ ] Schedule daily: add to crontab or Coolify scheduled task
- [ ] Test: run backup, run restore on a separate DB, verify data
- [ ] Document in `docs/runbook/backup-restore.md`

## Phase 5 — Uptime monitoring

- [ ] Sign up at uptimerobot.com
- [ ] Add monitor: `https://builderhunt.dev/api/health` (5min interval, expects 200)
- [ ] Add alert contacts: email + Slack webhook
- [ ] Create status page: `https://status.builderhunt.dev` (UptimeRobot free tier)
- [ ] Enhance `src/routes/api/health.tsx`:
  - Ping DB
  - Ping Redis
  - Return `{ status: 'ok', db: 'ok', redis: 'ok', version, uptime }`
- [ ] Test: kill Redis, verify health check returns 503, UptimeRobot alerts

## Phase 6 — Cloudflare

- [ ] Add domain to Cloudflare (free tier)
- [ ] Update nameservers at registrar
- [ ] DNS: A record `builderhunt.dev` → server IP
- [ ] DNS: CNAME `www` → `builderhunt.dev`
- [ ] SSL: Full (strict) mode
- [ ] Caching rules:
  - `*.css`, `*.js`, `*.woff2`, `*.png`, `*.svg` → cache 1 year
  - `*.html` (homepage, pricing) → cache 1 hour
  - `/api/*` → no cache
- [ ] Enable "Bot Fight Mode" (DDoS protection)
- [ ] Enable "Email Obfuscation"
- [ ] Test: check `Cf-Cache-Status` header on assets

## Phase 7 — Rate limiting

- [ ] Create `src/shared/lib/rate-limit.ts`:
  - `checkRate(key, limit, windowMs)`: Redis-backed
  - `getRateLimitKey(identifier, endpoint)`: standard format
- [ ] Apply to:
  - `src/routes/api/search/builders.ts`: 60/min per IP
  - `src/routes/api/recommendations/index.ts`: 30/min per user
  - `src/routes/api/auth/$.ts`: 20/min per IP (signin), 10/day (signup)
  - `src/routes/api/queries/index.ts`: 20/day per user (saved search creation)
  - `src/routes/api/builders/$builderId/claim.ts`: 5/day per IP (already implemented in-memory, switch to Redis)
- [ ] Return 429 with `Retry-After` header
- [ ] Test: 70 search requests in 1 min, verify last 10 return 429

## Phase 8 — Verification

### Smoke test (post-deploy)
- [ ] Health check returns 200
- [ ] Search returns results
- [ ] Signup creates user
- [ ] Sentry receives a test event
- [ ] PostHog receives a test event
- [ ] Backup runs successfully
- [ ] Rate limiting blocks excess requests

### Performance test
- [ ] k6 or Apache Bench: 100 RPS for 60s, P95 < 500ms, no errors
- [ ] Redis cache hit rate > 80% under load

### Disaster recovery drill
- [ ] Simulate DB loss: restore from backup, verify data integrity
- [ ] Simulate server crash: verify UptimeRobot alerts, DNS failover (if multi-region)

## Phase 9 — Runbook

File: `docs/runbook/incidents.md`

- [ ] "Redis is down" → restart, check connection
- [ ] "Sentry spike" → check recent deploys
- [ ] "Postgres down" → check disk, restart
- [ ] "Webhook queue stuck" → drain manually
- [ ] "Backup failed" → alert ops, retry manually

File: `docs/runbook/deploy.md`

- [ ] Step-by-step deploy procedure
- [ ] Rollback procedure
- [ ] Post-deploy smoke tests

## Edge cases

- **Redis cache miss during deploy**: warm cache on startup or accept slow first request
- **Sentry DSN empty in dev**: silent no-op, don't crash
- **PostHog rate-limited**: drop events, log warning
- **Backup too large**: split into multiple files
- **Cloudflare 522**: server is up but unreachable, check origin
- **Rate limit false positives**: legitimate users on shared IPs (corporate, university)

## Dependencies

- New packages: `ioredis`, `@sentry/node`, `@sentry/react`, `posthog-js`, `posthog-node`, `@aws-sdk/client-s3`
- New env vars: `REDIS_URL`, `SENTRY_DSN`, `POSTHOG_API_KEY`, `POSTHOG_HOST`, `BACKUP_S3_*`
- New accounts: Sentry, PostHog, Cloudflare, R2, UptimeRobot
- Refactor: `src/lib/search.ts` (in-memory → Redis)

## Estimated effort: 3 days
