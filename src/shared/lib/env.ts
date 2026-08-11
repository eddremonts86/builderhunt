import { z } from 'zod'

// Deploy platforms sometimes inject a protocol-relative URL (e.g. `//host`)
// for their auto-generated domain variable. better-auth's baseURL requires a
// scheme and throws an uncaught error otherwise, crash-looping the server —
// so we always normalize to a full https URL rather than trust the raw value.
export function ensureProtocol(url: string): string {
  return /^https?:\/\//.test(url) ? url : `https://${url.replace(/^\/+/, '')}`
}

const zodEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /**
   * Which database this process is pointed at, declared rather than guessed.
   *
   * Only production sets `production`. It exists so the Stripe cross-check below can tell a production
   * database from any other one without parsing the connection string: a host substring is a guess that is
   * wrong in both directions — a staging host containing "prod" reads as production, and a production host
   * behind a pooler or an IP does not. Getting that wrong here means either charging real cards from staging
   * or writing test-mode objects against real customers, so it is declared explicitly.
   *
   * Absent means "not production", which is the safe default: the check below only ever rejects a
   * live-key/non-prod-marker or test-key/prod-marker pairing, so forgetting to set it can never permit a live
   * key — it can only refuse one.
   */
  DB_ENV_MARKER: z.enum(['production', 'staging', 'development', 'test']).optional(),

  /**
   * Per-role connection-pool caps, overridable for a load run (plan 55 phase 2).
   *
   * Declared here rather than only read from `process.env` so a production process refuses to start on
   * a nonsense value. The pool size is the app's share of a finite `max_connections`: a typo that
   * `postgres.js` reads as unbounded does not fail at startup, it fails hours later as a capacity
   * incident in whichever request happened to be unlucky, with nothing in the logs pointing at the
   * configuration. Outside production the same typo warns and falls back to the default — see
   * `poolOptions` — because it should not stop someone working.
   */
  LOAD_POOL_MAX_RUNTIME: z.string().optional(),
  LOAD_POOL_MAX_AUTH: z.string().optional(),
  LOAD_POOL_MAX_WORKER: z.string().optional(),
  LOAD_POOL_MAX_PLATFORM: z.string().optional(),
  LOAD_POOL_MAX_CAPABILITY: z.string().optional(),
  DATABASE_MIGRATION_URL: z.string().min(1).optional(),
  DATABASE_AUTH_URL: z.string().min(1).optional(),
  DATABASE_WORKER_URL: z.string().min(1).optional(),
  /**
   * The public-capability identity (drizzle/0078). Optional so a deployment that has not provisioned
   * the credential yet still boots — the public scheduling flow then fails closed with a permission
   * error, which is the right failure: it never silently runs with the worker's wider privileges.
   */
  DATABASE_CAPABILITY_URL: z.string().min(1).optional(),
  DATABASE_PLATFORM_URL: z.string().min(1).optional(),
  // Shared secret that lets a VPS crontab trigger the admin run-worker
  // endpoints unattended (see src/shared/lib/auth/cron.ts). Optional: when
  // unset, only a platform-admin session can run the workers.
  CRON_SECRET: z.string().optional(),
  /*
   * `TENANT_READ_MODE` and `TENANT_CANONICAL_READY` are gone (2026-08-03), along with `TENANT_WRITE_MODE`
   * before them. Zod strips any of the three if a deployment still sets one, so nothing fails to boot.
   *
   * The read mode selected between "the saved searches I created" and "my organization's saved searches" on a
   * single route, and existed as the tenant cutover's rollback. It was never a rollback: those two answers
   * diverge by design for any organization with two contributing members, so flipping back to `legacy` would
   * not have recovered from a bug — it would have switched to a different product. Meanwhile the
   * shared-workspace promise silently depended on a deployment remembering to set it.
   *
   * Saved searches are organization-scoped unconditionally now. See `src/routes/api/queries/index.ts`.
   */
  // BETTER_AUTH_SECRET is the canonical name
  BETTER_AUTH_SECRET: z.string().optional(),
  APP_URL: z.string().min(1, 'APP_URL is required').transform(ensureProtocol),
  VITE_APP_URL: z.string().min(1, 'VITE_APP_URL is required').transform(ensureProtocol),
  GITHUB_TOKEN: z.string().optional(),
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  HACKERNEWS_API_URL: z.string().default('https://hacker-news.firebaseio.com/v0'),
  DEVTO_API_URL: z.string().default('https://dev.to/api'),
  STACKOVERFLOW_API_KEY: z.string().optional(),
  HUGGINGFACE_TOKEN: z.string().optional(),
  GITLAB_TOKEN: z.string().optional(),
  CODEBERG_API_URL: z.string().optional(),
  CODEBERG_TOKEN: z.string().optional(),
  // HASHNODE_API_KEY was here and is gone (drizzle/0144): Hashnode moved its public GraphQL API behind a
  // paid plan, so the source is retired. It was documented as *optional*, which is precisely why nobody
  // noticed the connector had stopped returning anything — an optional key that changes nothing looks the
  // same whether it works or not.
  // SOURCEHUT_TOKEN was here and is gone (drizzle/0143): the SourceHut source is retired because sr.ht's
  // robots.txt disallows feeding a machine learning model, so no token could make the connector legitimate.
  // Leaving it in `.env` is harmless — nothing reads it — but nothing here will validate it either.
  PRODUCTHUNT_TOKEN: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  MINIMAX_API_KEY: z.string().optional(),
  MINIMAX_BASE_URL: z.string().default('https://api.minimax.io'),
  MINIMAX_MODEL: z.string().default('MiniMax-M3'),
  // MiniMax M3 list pricing, checked against the published rate card on 2026-08-02: $0.30 per 1M input
  // tokens and $1.20 per 1M output tokens, which is 0.03¢ and 0.12¢ per 1K.
  //
  // These began as rough order-of-magnitude placeholders and the comment said so. They turn out to be
  // exactly right — the guess matched the list price to the digit — so what changes here is the
  // *provenance*, not the numbers: `docs/operations/solutions-cost-certification.md` can now cite a
  // published rate instead of a stand-in.
  //
  // Still list price, not an invoice. Volume tiers, committed-use discounts and currency conversion all
  // move the real figure, so a cost certification signed off a production bill remains a separate step.
  MINIMAX_COST_PER_1K_INPUT_TOKENS_CENTS: z.coerce.number().nonnegative().default(0.03),
  MINIMAX_COST_PER_1K_OUTPUT_TOKENS_CENTS: z.coerce.number().nonnegative().default(0.12),
  // Provider-cost-vs-credit-charged ratio above which `margin_drift` fires (alert only, never
  // auto-blocks — a real margin problem needs a pricing/rate-card fix, not a runtime block).
  CREDIT_MARGIN_ALERT_RATIO: z.coerce.number().positive().default(1),
  // Max promotional/manual-trial credit grants allowed across one linked-account identity cluster
  // (G1) — guards against claiming the same signup bonus repeatedly via near-identical accounts.
  PROMO_GRANT_MAX_PER_CLUSTER: z.coerce.number().int().positive().default(3),
  AI_EMBEDDING_URL: z.string().optional(),
  AI_EMBEDDING_MODEL: z.string().optional(),
  AI_EMBEDDING_API_KEY: z.string().optional(),
  // 768 = nomic-embed-text, the model docker-compose provisions and every .env example sets. It
  // is also the literal the one and only pgvector migration created the column with
  // (drizzle/0013_*.sql: `vector(768)`), so it is the only value a migrated database can hold.
  // This default was 1536 until 2026-08-01 (plan 43 Phase 2) — a value nothing in the repo used,
  // which meant an unset AI_EMBEDDING_DIM silently disagreed with the actual column.
  // `assertEmbeddingDimensionMatchesDatabase` now catches that disagreement at first use.
  AI_EMBEDDING_DIM: z.coerce.number().int().positive().default(768),
  AI_EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // Kill switch for the claimable-profiles source-bound verification flow
  // (bio-challenge fetches against GitHub/GitLab/Codeberg/DEV.to).
  CLAIMABLE_PROFILES_ENABLED: z.enum(['true', 'false']).default('true'),
  // Kill switch for the verified-owner portfolio feature (public /portfolio/$claimId pages).
  PORTFOLIOS_ENABLED: z.enum(['true', 'false']).default('true'),
  // Plan: audit-trust — profile-removal/global-suppression subsystem. Off by default: a new
  // security-critical flow that hashes requester email/challenge with a dedicated key distinct
  // from BETTER_AUTH_SECRET (spec.md: "must not reuse BETTER_AUTH_SECRET").
  PROFILE_REMOVAL_ENABLED: z.enum(['true', 'false']).default('false'),
  // 64 hex chars (32 bytes), same shape/convention as WEBHOOK_PAYLOAD_ENCRYPTION_KEY.
  PROFILE_REMOVAL_HMAC_KEY: z.string().optional(),
  // Set only while rotating PROFILE_REMOVAL_HMAC_KEY — pending removal requests hashed under the
  // previous key remain matchable until they expire, same overlap-window convention as
  // STRIPE_WEBHOOK_SECRET_PREVIOUS. Suppressions themselves are matched by plaintext
  // (source, sourceId), not a hash, so rotation never affects already-verified suppressions.
  PROFILE_REMOVAL_HMAC_KEY_PREVIOUS: z.string().optional(),
  // Kill switch for the landing-funnel conversion-event collector (plan: audit-conversion).
  // Off by default — instrumentation only starts recording once explicitly turned on, after
  // cookie/privacy copy is updated (see docs/conversion-baseline.md).
  CONVERSION_EVENTS_ENABLED: z.enum(['true', 'false']).default('false'),
  // Plan: solutions-intelligence — seven independent capability flags (spec.md/design doc:
  // "Feature flags independently control catalog ingestion, public scraping, live enrichment,
  // LLM interpretation, external human profiles, and paid generation"). All off by default;
  // each turns on only after its own prerequisite review (source register sign-off, billing
  // cost-benchmark certification, etc. — see solutions/config.ts).
  SOLUTIONS_CATALOG_INGESTION_ENABLED: z.enum(['true', 'false']).default('false'),
  SOLUTIONS_PUBLIC_SCRAPE_ENABLED: z.enum(['true', 'false']).default('false'),
  SOLUTIONS_LIVE_ENRICHMENT_ENABLED: z.enum(['true', 'false']).default('false'),
  SOLUTIONS_INTERPRETATION_ENABLED: z.enum(['true', 'false']).default('false'),
  SOLUTIONS_EXPLANATION_ENABLED: z.enum(['true', 'false']).default('false'),
  SOLUTIONS_EXTERNAL_HUMAN_ENABLED: z.enum(['true', 'false']).default('false'),
  SOLUTIONS_PAID_GENERATION_ENABLED: z.enum(['true', 'false']).default('false'),
  AI_DISABLED: z.enum(['true', 'false']).default('false'),
  AI_DISABLED_TASKS: z.string().default(''),
  // Plan: proactive-discovery
  DISCOVERY_CELLS_PER_RUN: z.coerce.number().int().positive().default(2),
  DISCOVERY_DAILY_STUB_CAP: z.coerce.number().int().positive().default(1500),
  // Plan: devpost-integration — headless-browser scraping worker. Disabled by
  // default: this is the first source that scrapes a bot-protected site with
  // a real Chromium instance rather than a plain API fetch, so it stays off
  // until explicitly turned on in each environment (see
  // docs/operations/deploy-runbook.md). Caps below are the per-run
  // politeness budget, not a rate limit — kept small since Devpost has no
  // published API and every request risks a ban.
  DEVPOST_ENABLED: z.enum(['true', 'false']).default('false'),
  DEVPOST_PROJECTS_PER_RUN: z.coerce.number().int().positive().default(8),
  DEVPOST_PROFILES_PER_RUN: z.coerce.number().int().positive().default(20),
  DEVPOST_REQUEST_DELAY_MS: z.coerce.number().int().nonnegative().default(1500),
  // Plan: stealth-scraping (Public Profile Enrichment) — spec §12. Disabled by
  // default; enabling requires the source register + legal copy to be
  // reviewed first (see docs/operations/public-enrichment-source-register.md).
  ENRICHMENT_ENABLED: z.enum(['true', 'false']).default('false'),
  ENRICHMENT_ALLOWED_CONNECTORS: z.string().default(''),
  ENRICHMENT_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  ENRICHMENT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  ENRICHMENT_LEASE_SECONDS: z.coerce.number().int().positive().default(300),
  ENRICHMENT_RAW_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  ENRICHMENT_ACCEPTED_RETENTION_DAYS: z.coerce.number().int().positive().default(180),
  ENRICHMENT_USER_AGENT: z.string().default('BuilderHuntBot/1.0 (+https://builderhunt.dev/crawler)'),
  // Plan: stripe-billing-platform. Disabled by default; enabling requires
  // every gate in docs/operations/stripe-launch-register.md to have
  // evidence first. Test/live key mismatch, or enabling with any of these
  // unset, must fail closed — never silently fall back to a stub provider.
  STRIPE_BILLING_ENABLED: z.enum(['true', 'false']).default('false'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Set only while rotating the webhook endpoint secret — the receipt endpoint accepts a signature
  // verified by either secret during the overlap window, then this is unset once rotation completes.
  STRIPE_WEBHOOK_SECRET_PREVIOUS: z.string().optional(),
  STRIPE_API_VERSION: z.string().optional(),
  // AES-256-GCM key (64 hex chars = 32 bytes) for the minimized webhook payload retained in
  // `billing_webhook_events.payload_encrypted` (spec.md §Operations: "encrypted where retained").
  WEBHOOK_PAYLOAD_ENCRYPTION_KEY: z.string().optional(),
  // Plan: abuse-and-usage-integrity. All optional, fail-open to the safe default so unset config
  // never changes existing behavior — `observe` only emits signals, nothing is ever blocked or
  // throttled until an operator deliberately moves this past `observe` (see Phase 5's
  // `resolveEnforcement()`, not built yet as of this gate).
  ABUSE_ENFORCEMENT_MODE: z.enum(['observe', 'warn', 'enforce']).default('observe'),
  // Concurrent-session caps, one per tier — defaults sized to comfortably allow a single person
  // signed in on a laptop + phone at once, not to police normal multi-device use.
  SESSION_MAX_CONCURRENT_FREE: z.coerce.number().int().positive().default(2),
  SESSION_MAX_CONCURRENT_PRO: z.coerce.number().int().positive().default(3),
  SESSION_MAX_CONCURRENT_TEAM_PER_SEAT: z.coerce.number().int().positive().default(2),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(10080), // 7 days
  SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce.number().int().positive().default(720), // 30 days
  // Per-seat, per-UTC-day ceilings on the core actions that were never metered at all before this
  // plan (unlike AI credits, which the existing ledger already governs).
  SEAT_DAILY_SEARCHES: z.coerce.number().int().positive().default(200),
  SEAT_DAILY_REVEALS: z.coerce.number().int().positive().default(100),
  SEAT_DAILY_EXPORTS: z.coerce.number().int().positive().default(20),
  SEAT_DAILY_MESSAGES: z.coerce.number().int().positive().default(100),
  SIGNUP_REQUIRE_VERIFIED_EMAIL: z.enum(['true', 'false']).default('false'),
  SIGNUP_BLOCK_DISPOSABLE_EMAILS: z.enum(['true', 'false']).default('false'),
  /**
   * Invite-only sign-up (waitlist-launch plan). When `true`, an email may create an account only if
   * `access_requests` holds an `approved` row for it.
   *
   * Defaults to `false`, and that default is load-bearing rather than lazy: local development and the
   * e2e harness create users constantly, and a default of `true` would break every fixture while
   * looking like a test failure. Production opts in explicitly.
   */
  ACCESS_ALLOWLIST_ENABLED: z.enum(['true', 'false']).default('false'),
  // Comma-separated ASNs (e.g. known corporate/VPN egress ranges) to suppress IP-churn signals for —
  // per the OWASP NAT/proxy caveat, shared-IP alone must never be treated as suspicious on its own.
  ABUSE_ALLOWLIST_ASNS: z.string().default(''),
  // How many tenant-membership-denied attempts a single user may rack up within the window before
  // it's treated as a cluster (probing for another tenant's data) rather than isolated noise (an
  // expired invite link, a stale bookmark) — emits `cross_tenant_denied`, detection only.
  ABUSE_CROSS_TENANT_DENIAL_THRESHOLD: z.coerce.number().int().positive().default(5),
  ABUSE_CROSS_TENANT_DENIAL_WINDOW_MINUTES: z.coerce.number().int().positive().default(10),
  // Sign-ups from the same first-party device cookie, per day — survives IP rotation (unlike
  // better-auth's own built-in per-IP sign-up limiter), catching multi-accounting from one browser.
  SIGNUP_DEVICE_DAILY_LIMIT: z.coerce.number().int().positive().default(3),
  // Per-seat share of a Team's pooled daily credit consumption before `pool_drain` fires — never
  // applies to a single-seat org (there's no one else's pool to protect). `observe` only signals;
  // `enforce` also refuses to reserve further credits for that seat once its own daily total
  // would cross this, independent of whether the org's overall pool still has balance.
  CREDIT_SEAT_DAILY_UNITS: z.coerce.number().int().positive().default(2000),
  // First-payer credit-consumption cap (G6) — a "new payer" is an organization whose earliest
  // paid-source credit grant (pack/subscription, never promotional/trial/manual) is younger than
  // this window; once outside the window they're no longer capped by this rule. Guards against a
  // stolen card/new payment method being used to burn through credits before a chargeback lands —
  // coordinates with, but doesn't duplicate, `billing/risk.ts`'s payment-*failure*-velocity gate
  // (this one caps *consumption* of already-granted credits, not new purchases).
  CREDIT_FIRST_PAYER_WINDOW_HOURS: z.coerce.number().int().positive().default(48),
  CREDIT_FIRST_PAYER_CAP_UNITS: z.coerce.number().int().positive().default(500),
  // Refund-farming cap + signal (G4) — a rolling 24h cap on how many credit units one organization
  // can refund via `refundUsage` (`enforce` mode only), plus a wider ratio check: if refunded units
  // over `CREDIT_REFUND_FARMING_WINDOW_HOURS` (default 30 days) exceed
  // `CREDIT_REFUND_FARMING_RATIO_THRESHOLD` of settled units in that same window, emit
  // `refund_farming` regardless of mode. `CREDIT_REFUND_FARMING_MIN_SETTLED_UNITS` guards a
  // brand-new org with a tiny sample (e.g. 1 settle + 1 refund) from tripping the ratio spuriously.
  CREDIT_REFUND_MAX_PER_DAY: z.coerce.number().int().positive().default(300),
  CREDIT_REFUND_FARMING_WINDOW_HOURS: z.coerce.number().int().positive().default(720),
  CREDIT_REFUND_FARMING_RATIO_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  CREDIT_REFUND_FARMING_MIN_SETTLED_UNITS: z.coerce.number().int().positive().default(100),
  // Plan: calendar-scheduling-interview-intelligence. Eight independently-togglable release
  // flags (plan.md "Release flags") — all off by default. Turning one off blocks new actions
  // but preserves authorized read/export/delete access; it never removes saved data.
  CALENDAR_ENABLED: z.enum(['true', 'false']).default('false'),
  SCHEDULING_ENABLED: z.enum(['true', 'false']).default('false'),
  CANDIDATE_UPLOADS_ENABLED: z.enum(['true', 'false']).default('false'),
  CANDIDATE_WEB_IMPORT_ENABLED: z.enum(['true', 'false']).default('false'),
  SENSITIVE_AI_ENABLED: z.enum(['true', 'false']).default('false'),
  INTERVIEW_TRANSCRIPTION_ENABLED: z.enum(['true', 'false']).default('false'),
  INTERVIEW_CONTEXTUAL_QUESTIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  CALENDAR_OPERATIONAL_LAYERS_ENABLED: z.enum(['true', 'false']).default('false'),
  // Object storage for candidate documents (spec.md: "private bucket, EU jurisdiction") — required
  // in production when CANDIDATE_UPLOADS_ENABLED=true. `INTERVIEW_R2_JURISDICTION` is fixed to 'eu';
  // the schema rejects any other value rather than silently accepting a non-EU bucket.
  // The backing store is **self-hosted MinIO**, not Cloudflare R2
  // (`docs/operations/interview-provider-register.md` chose it to avoid a paid vendor and a
  // sub-processor entry). The `INTERVIEW_R2_*` names are kept on purpose so switching to R2 later
  // is env-only — e.g. `INTERVIEW_R2_ENDPOINT=http://minio:9000`.
  INTERVIEW_R2_ENDPOINT: z.string().optional(),
  INTERVIEW_R2_ACCOUNT_ID: z.string().optional(),
  INTERVIEW_R2_BUCKET: z.string().optional(),
  INTERVIEW_R2_ACCESS_KEY_ID: z.string().optional(),
  INTERVIEW_R2_SECRET_ACCESS_KEY: z.string().optional(),
  INTERVIEW_R2_JURISDICTION: z.enum(['eu']).default('eu'),
  // ClamAV (spec.md: "Stream every object through ClamAV before moving/copying to the clean
  // private prefix") — required in production when CANDIDATE_UPLOADS_ENABLED=true.
  INTERVIEW_CLAMAV_HOST: z.string().optional(),
  INTERVIEW_CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  // Deepgram EU endpoint (spec.md: "Speech-to-text: Deepgram EU first") — required in production
  // when INTERVIEW_TRANSCRIPTION_ENABLED=true. Default base URL is already the EU endpoint so an
  // operator cannot accidentally point at the global one by simply omitting the var.
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_BASE_URL: z.string().default('https://api.eu.deepgram.com'),
  // Sensitive-text AI provider. spec.md's rule is unchanged — "Never silently fall back to
  // MiniMax" — but the vendor is now selectable, because provisioning proved the residency
  // guarantee is a property of the *provider*, not of our config. See
  // docs/operations/interview-provider-register.md §4.
  //
  // `mistral` is primary: EU processing is its default and there is no per-deployment switch that
  // can silently move processing outside the EU. `azure` is the retained fallback.
  SENSITIVE_AI_PROVIDER: z.enum(['mistral', 'azure']).default('mistral'),
  // Mistral La Plateforme. The base URL default is the EU endpoint, and the check below pins it
  // exactly rather than pattern-matching, because Mistral's US endpoint is an opt-in and the only
  // safe posture is to reject anything that is not the known-EU host.
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_BASE_URL: z.string().default('https://api.mistral.ai'),
  // Pin an explicit dated model id (e.g. `mistral-medium-2604`), never a floating alias like
  // `mistral-medium-latest`: these models write candidate-evaluation material, and an unannounced
  // model change that shifts how candidates are assessed is a fairness and auditability problem,
  // not just a quality one. `SensitiveAICompletionResult.model` records what actually ran.
  MISTRAL_MODEL: z.string().optional(),
  // Azure OpenAI regional EU deployment — retained fallback, required when
  // SENSITIVE_AI_PROVIDER=azure.
  AZURE_OPENAI_ENDPOINT: z.string().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
  AZURE_OPENAI_API_VERSION: z.string().optional(),
  // Retention defaults (spec.md "Consent, privacy, and retention" → "Defaults"). Organizations
  // may select shorter periods; these are the operator-wide ceiling the retention worker enforces.
  INTERVIEW_TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().positive().max(90).default(90),
  INTERVIEW_DOCUMENT_RETENTION_DAYS: z.coerce.number().int().positive().max(180).default(180),
  INTERVIEW_CONSENT_RETENTION_MONTHS: z.coerce.number().int().positive().max(24).default(24),
}).superRefine((data, context) => {
  /**
   * A pool cap that is not a usable integer, refused in production and only there.
   *
   * The asymmetry is the point. In production an unusable value has to stop the process, because
   * `postgres.js` treats a `NaN` max as unbounded and the consequence arrives much later as
   * `too many clients already` in an unrelated request. Locally the same mistake should warn and carry
   * on, which is what `poolOptions` does — this check is what makes the local warning safe to have.
   */
  if (data.NODE_ENV === 'production') {
    for (const role of ['RUNTIME', 'AUTH', 'WORKER', 'PLATFORM', 'CAPABILITY'] as const) {
      const key = `LOAD_POOL_MAX_${role}` as const
      const raw = data[key]
      if (raw === undefined || raw === '') continue
      const parsed = Number(raw)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} must be an integer between 1 and 100 — postgres.js reads an unusable value as an unbounded pool`,
        })
      }
    }
  }

  if (!data.BETTER_AUTH_SECRET) {
    context.addIssue({
      code: 'custom',
      path: ['BETTER_AUTH_SECRET'],
      message: 'BETTER_AUTH_SECRET is required — generate with: openssl rand -hex 32',
    })
  }

  // Unlike the enrichment/production-only checks below, this must fail
  // closed in every environment (dev/test/production) — sandbox testing
  // with real Stripe test keys is expected well before Phase 15's live
  // rollout, so "enabled but misconfigured" must never silently degrade.
  if (data.STRIPE_BILLING_ENABLED === 'true') {
    if (!data.STRIPE_SECRET_KEY) {
      context.addIssue({ code: 'custom', path: ['STRIPE_SECRET_KEY'], message: 'STRIPE_SECRET_KEY is required when STRIPE_BILLING_ENABLED=true' })
    } else if (!/^sk_(test|live)_/.test(data.STRIPE_SECRET_KEY)) {
      context.addIssue({ code: 'custom', path: ['STRIPE_SECRET_KEY'], message: 'STRIPE_SECRET_KEY must start with sk_test_ or sk_live_' })
    }
    if (!data.STRIPE_WEBHOOK_SECRET) {
      context.addIssue({ code: 'custom', path: ['STRIPE_WEBHOOK_SECRET'], message: 'STRIPE_WEBHOOK_SECRET is required when STRIPE_BILLING_ENABLED=true' })
    } else if (!/^whsec_/.test(data.STRIPE_WEBHOOK_SECRET)) {
      context.addIssue({ code: 'custom', path: ['STRIPE_WEBHOOK_SECRET'], message: 'STRIPE_WEBHOOK_SECRET must start with whsec_' })
    }
    if (!data.STRIPE_API_VERSION) {
      context.addIssue({ code: 'custom', path: ['STRIPE_API_VERSION'], message: 'STRIPE_API_VERSION is required when STRIPE_BILLING_ENABLED=true — pin the exact version the SDK/webhook endpoint/fixtures share' })
    }
    if (!data.WEBHOOK_PAYLOAD_ENCRYPTION_KEY) {
      context.addIssue({ code: 'custom', path: ['WEBHOOK_PAYLOAD_ENCRYPTION_KEY'], message: 'WEBHOOK_PAYLOAD_ENCRYPTION_KEY is required when STRIPE_BILLING_ENABLED=true — generate with: openssl rand -hex 32' })
    } else if (!/^[0-9a-f]{64}$/i.test(data.WEBHOOK_PAYLOAD_ENCRYPTION_KEY)) {
      context.addIssue({ code: 'custom', path: ['WEBHOOK_PAYLOAD_ENCRYPTION_KEY'], message: 'WEBHOOK_PAYLOAD_ENCRYPTION_KEY must be 64 hex characters (32 bytes) — generate with: openssl rand -hex 32' })
    }
    // Mixed test/live mode: a live secret key paired with a webhook secret
    // minted for a different (test-mode) endpoint — or vice versa — is a
    // classic misconfiguration Stripe's own dashboard won't catch for you.
    // We can't verify the webhook secret's mode from its value alone (it's
    // an opaque token), so the key/env-name mismatch is checked unconditionally
    // below rather than here.
  }

  /*
   * A live key outside production, checked whatever the billing flag says.
   *
   * This lived inside the `STRIPE_BILLING_ENABLED === 'true'` block above, which meant the one
   * configuration it exists to catch slipped through: a `.env` carrying `sk_live_…` with
   * `STRIPE_BILLING_ENABLED=false` never reached the check at all. That was the real state of this
   * repo on 2026-07-29, and `pnpm stripe:provision` / `pnpm billing:check-readiness` load exactly
   * that file (`tsx --env-file=.env`) — so running either would have created catalog objects
   * against the live Stripe account from a developer's laptop.
   *
   * The flag gates whether billing is *used*. It must not gate whether a live credential is
   * *allowed to be present*, because a key that is loaded is a key that can be used by the next
   * line of code someone writes.
   */
  if (data.STRIPE_SECRET_KEY?.startsWith('sk_live_') && data.NODE_ENV !== 'production') {
    context.addIssue({
      code: 'custom',
      path: ['STRIPE_SECRET_KEY'],
      message:
        'A live Stripe secret key must never be present outside NODE_ENV=production — remove it from '
        + 'the local env file and use the sk_test_ key (production reads its own from Coolify)',
    })
  }

  /**
   * The Stripe key's mode and the database it will write against must agree.
   *
   * `NODE_ENV` is not enough, and that is the whole reason this exists. It says how the *code* is built, not
   * which data the process is holding: `NODE_ENV=production` is exactly what a staging deployment runs, and a
   * developer investigating a production incident may legitimately set it locally. Neither says whether
   * `DATABASE_URL` names the real customer database.
   *
   * The two failures this closes are asymmetric but both irreversible:
   *
   * - **`sk_live_` against a non-production database.** Real cards get charged for objects nobody can
   *     reconcile, because the subscriptions and grants they belong to live in a database that is not the one
   *     support and finance read. A copy-pasted secret into staging is all it takes; staging *is* built with
   *     `NODE_ENV=production`, so the guard above waves it through.
   * - **`sk_test_` against the production database.** Test-mode Stripe objects are written against real
   *     customers' rows. Nothing is charged, which is what makes it insidious: the damage is a production
   *     ledger quietly carrying references to objects that only exist in test mode, discovered at
   *     reconciliation.
   *
   * `DB_ENV_MARKER` is a declaration rather than a substring match on the connection string — see its own
   * comment for why guessing is wrong in both directions. Absent is treated as "not production", so a missing
   * marker can only ever refuse a live key, never permit one.
   *
   * Both directions abort at boot. A misconfiguration that is caught on the first request has already had a
   * chance to move money.
   */
  const stripeKeyMode = data.STRIPE_SECRET_KEY?.startsWith('sk_live_')
    ? 'live'
    : data.STRIPE_SECRET_KEY?.startsWith('sk_test_')
      ? 'test'
      : null
  const databaseIsProduction = data.DB_ENV_MARKER === 'production'

  if (stripeKeyMode === 'live' && !databaseIsProduction) {
    context.addIssue({
      code: 'custom',
      path: ['STRIPE_SECRET_KEY'],
      message:
        'A live Stripe secret key is paired with a database that is not marked production '
        + `(DB_ENV_MARKER=${data.DB_ENV_MARKER ?? 'unset'}). Real cards would be charged against rows the `
        + 'production ledger does not contain. Set DB_ENV_MARKER=production only on the deployment that owns '
        + 'the real customer database, and use sk_test_ everywhere else.',
    })
  }

  if (stripeKeyMode === 'test' && databaseIsProduction) {
    context.addIssue({
      code: 'custom',
      path: ['STRIPE_SECRET_KEY'],
      message:
        'A test-mode Stripe secret key is paired with the production database (DB_ENV_MARKER=production). '
        + 'Nothing would be charged, but the production ledger would accumulate references to Stripe objects '
        + 'that exist only in test mode. Use the sk_live_ key against the production database.',
    })
  }

  if (data.PROFILE_REMOVAL_ENABLED === 'true') {
    if (!data.PROFILE_REMOVAL_HMAC_KEY) {
      context.addIssue({ code: 'custom', path: ['PROFILE_REMOVAL_HMAC_KEY'], message: 'PROFILE_REMOVAL_HMAC_KEY is required when PROFILE_REMOVAL_ENABLED=true — generate with: openssl rand -hex 32' })
    } else if (!/^[0-9a-f]{64}$/i.test(data.PROFILE_REMOVAL_HMAC_KEY)) {
      context.addIssue({ code: 'custom', path: ['PROFILE_REMOVAL_HMAC_KEY'], message: 'PROFILE_REMOVAL_HMAC_KEY must be 64 hex characters (32 bytes) — generate with: openssl rand -hex 32' })
    } else if (data.BETTER_AUTH_SECRET && data.PROFILE_REMOVAL_HMAC_KEY === data.BETTER_AUTH_SECRET) {
      context.addIssue({ code: 'custom', path: ['PROFILE_REMOVAL_HMAC_KEY'], message: 'PROFILE_REMOVAL_HMAC_KEY must not reuse BETTER_AUTH_SECRET' })
    }
    if (data.PROFILE_REMOVAL_HMAC_KEY_PREVIOUS && !/^[0-9a-f]{64}$/i.test(data.PROFILE_REMOVAL_HMAC_KEY_PREVIOUS)) {
      context.addIssue({ code: 'custom', path: ['PROFILE_REMOVAL_HMAC_KEY_PREVIOUS'], message: 'PROFILE_REMOVAL_HMAC_KEY_PREVIOUS must be 64 hex characters (32 bytes)' })
    }
  }

  if (data.NODE_ENV !== 'production') return

  // DATABASE_AUTH_URL/WORKER_URL/PLATFORM_URL are intentionally optional in
  // production: the role-separation cutover (DATABASE_URL -> per-role users)
  // is a deliberate, sign-off-gated step (see security-and-multitenancy plan)
  // that has not happened yet. src/shared/lib/db/{auth-db,worker-db,client}.ts
  // already fall back to DATABASE_URL when these are unset, so they must not
  // be hard-required here — doing so crash-loops every request in prod.

  let runtimeUsername = ''
  try {
    runtimeUsername = decodeURIComponent(new URL(data.DATABASE_URL).username).toLowerCase()
  } catch {
    context.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'DATABASE_URL must be a valid PostgreSQL URL' })
  }

  if (['postgres', 'builderhunt_owner'].includes(runtimeUsername)) {
    context.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message: 'Production DATABASE_URL must use the non-owner application role',
    })
  }

  // The list above is a name blocklist, which cannot see a managed resource's
  // own owner: Coolify names ours `bhuser`, so a superuser with BYPASSRLS
  // passes it and every RLS policy silently stops applying. Comparing *roles*
  // catches that whatever the owner is called. The URL comparison further down
  // does not: it needs host, password and database to match as well, so two
  // URLs for the same role but different hosts slip through it.
  //
  // This stays a string check on purpose — validation happens before any
  // connection exists. `scripts/deploy/orchestrate.mjs` asks the database for
  // rolsuper/rolbypassrls, which is the check that actually holds.
  let migrationUsername = ''
  if (data.DATABASE_MIGRATION_URL) {
    try {
      migrationUsername = decodeURIComponent(new URL(data.DATABASE_MIGRATION_URL).username).toLowerCase()
    } catch {
      context.addIssue({ code: 'custom', path: ['DATABASE_MIGRATION_URL'], message: 'DATABASE_MIGRATION_URL must be a valid PostgreSQL URL' })
    }
  }
  if (runtimeUsername && migrationUsername && runtimeUsername === migrationUsername) {
    context.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message:
        `Production DATABASE_URL and DATABASE_MIGRATION_URL both connect as "${runtimeUsername}". The migration `
        + 'role owns the schema, so serving requests with it gives every request owner privileges and makes '
        + 'Row-Level Security inert. Point DATABASE_URL at the application role.',
    })
  }
  // Only enforce "must be different" once a role URL is actually set — an
  // unset var (undefined) must never be compared as equal to another unset
  // var, or every optional role URL falsely collides with every other one.
  if (data.DATABASE_MIGRATION_URL && data.DATABASE_MIGRATION_URL === data.DATABASE_URL) {
    context.addIssue({
      code: 'custom',
      path: ['DATABASE_MIGRATION_URL'],
      message: 'Migration and runtime database identities must be different',
    })
  }
  if (
    data.DATABASE_AUTH_URL
    && (data.DATABASE_AUTH_URL === data.DATABASE_URL || data.DATABASE_AUTH_URL === data.DATABASE_MIGRATION_URL)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['DATABASE_AUTH_URL'],
      message: 'Auth, migration, and product database identities must be different',
    })
  }
  if (
    data.DATABASE_WORKER_URL
    && (
      data.DATABASE_WORKER_URL === data.DATABASE_URL
      || data.DATABASE_WORKER_URL === data.DATABASE_AUTH_URL
      || data.DATABASE_WORKER_URL === data.DATABASE_MIGRATION_URL
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['DATABASE_WORKER_URL'],
      message: 'Worker, auth, migration, and product database identities must be different',
    })
  }
  if (
    data.DATABASE_CAPABILITY_URL
    && (
      data.DATABASE_CAPABILITY_URL === data.DATABASE_URL
      || data.DATABASE_CAPABILITY_URL === data.DATABASE_AUTH_URL
      || data.DATABASE_CAPABILITY_URL === data.DATABASE_WORKER_URL
      || data.DATABASE_CAPABILITY_URL === data.DATABASE_MIGRATION_URL
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['DATABASE_CAPABILITY_URL'],
      // Sharing an identity with any other role would silently hand the public flow that role's
      // grants, which is the entire thing drizzle/0078 exists to prevent.
      message: 'Capability, worker, auth, migration, and product database identities must be different',
    })
  }
  if (
    data.DATABASE_PLATFORM_URL
    && (
      data.DATABASE_PLATFORM_URL === data.DATABASE_URL
      || data.DATABASE_PLATFORM_URL === data.DATABASE_AUTH_URL
      || data.DATABASE_PLATFORM_URL === data.DATABASE_WORKER_URL
      || data.DATABASE_PLATFORM_URL === data.DATABASE_MIGRATION_URL
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['DATABASE_PLATFORM_URL'],
      message: 'Platform, worker, auth, migration, and product database identities must be different',
    })
  }
  if (!data.BETTER_AUTH_SECRET || data.BETTER_AUTH_SECRET.length < 32 || /change[_-]?me|dev-secret|example/i.test(data.BETTER_AUTH_SECRET)) {
    context.addIssue({
      code: 'custom',
      path: ['BETTER_AUTH_SECRET'],
      message: 'Production BETTER_AUTH_SECRET must be a strong generated secret',
    })
  }

  if (data.ENRICHMENT_ENABLED === 'true') {
    const allowedConnectors = data.ENRICHMENT_ALLOWED_CONNECTORS.split(',').map((v) => v.trim()).filter(Boolean)
    if (allowedConnectors.length === 0) {
      context.addIssue({ code: 'custom', path: ['ENRICHMENT_ALLOWED_CONNECTORS'], message: 'ENRICHMENT_ALLOWED_CONNECTORS must be non-empty when enrichment is enabled' })
    }
    if (!/^\+?https?:\/\//.test(data.ENRICHMENT_USER_AGENT.match(/\(([^)]*)\)/)?.[1] ?? '')) {
      context.addIssue({ code: 'custom', path: ['ENRICHMENT_USER_AGENT'], message: 'ENRICHMENT_USER_AGENT must include a contact/info URL in parentheses' })
    }
    if (data.ENRICHMENT_RAW_RETENTION_DAYS > 90 || data.ENRICHMENT_ACCEPTED_RETENTION_DAYS > 365) {
      context.addIssue({ code: 'custom', path: ['ENRICHMENT_RAW_RETENTION_DAYS'], message: 'Enrichment retention windows exceed policy bounds' })
    }
  }

  if (data.CANDIDATE_UPLOADS_ENABLED === 'true') {
    // Two acceptable object stores (docs/operations/interview-provider-register.md):
    //   1. Self-hosted MinIO on the internal network — the chosen default. No third party is
    //      involved at all, so there is no jurisdiction to police; what matters is that the
    //      endpoint is NOT a public host, which `isPrivateStorageHost` checks.
    //   2. Cloudflare R2, EU jurisdiction only — `*.eu.r2.cloudflarestorage.com`.
    // Anything else (a non-EU R2 bucket, some other public S3 endpoint) is rejected: candidate
    // CVs are personal data and must not land in an unreviewed third country by a typo.
    const storageHost = (() => {
      if (!data.INTERVIEW_R2_ENDPOINT) return null
      try {
        const raw = data.INTERVIEW_R2_ENDPOINT
        return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.toLowerCase()
      } catch {
        return null
      }
    })()
    const isEuR2Host = storageHost !== null && /\.eu\.r2\.cloudflarestorage\.com$/i.test(storageHost)
    // Internal Docker/Coolify service name (no dot), localhost, or a private IPv4 range.
    const isPrivateStorageHost = storageHost !== null && (
      !storageHost.includes('.')
      || storageHost === 'localhost'
      || /^127\./.test(storageHost)
      || /^10\./.test(storageHost)
      || /^192\.168\./.test(storageHost)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(storageHost)
    )
    if (!isEuR2Host && !isPrivateStorageHost) {
      context.addIssue({
        code: 'custom',
        path: ['INTERVIEW_R2_ENDPOINT'],
        message: 'INTERVIEW_R2_ENDPOINT must be either a self-hosted private endpoint (MinIO) or a *.eu.r2.cloudflarestorage.com EU-jurisdiction bucket when CANDIDATE_UPLOADS_ENABLED=true',
      })
    }
    if (!data.INTERVIEW_R2_ACCOUNT_ID) context.addIssue({ code: 'custom', path: ['INTERVIEW_R2_ACCOUNT_ID'], message: 'INTERVIEW_R2_ACCOUNT_ID is required when CANDIDATE_UPLOADS_ENABLED=true' })
    if (!data.INTERVIEW_R2_BUCKET) context.addIssue({ code: 'custom', path: ['INTERVIEW_R2_BUCKET'], message: 'INTERVIEW_R2_BUCKET is required when CANDIDATE_UPLOADS_ENABLED=true' })
    if (!data.INTERVIEW_R2_ACCESS_KEY_ID) context.addIssue({ code: 'custom', path: ['INTERVIEW_R2_ACCESS_KEY_ID'], message: 'INTERVIEW_R2_ACCESS_KEY_ID is required when CANDIDATE_UPLOADS_ENABLED=true' })
    if (!data.INTERVIEW_R2_SECRET_ACCESS_KEY) context.addIssue({ code: 'custom', path: ['INTERVIEW_R2_SECRET_ACCESS_KEY'], message: 'INTERVIEW_R2_SECRET_ACCESS_KEY is required when CANDIDATE_UPLOADS_ENABLED=true' })
    if (!data.INTERVIEW_CLAMAV_HOST) context.addIssue({ code: 'custom', path: ['INTERVIEW_CLAMAV_HOST'], message: 'INTERVIEW_CLAMAV_HOST is required when CANDIDATE_UPLOADS_ENABLED=true' })
  }

  if (data.INTERVIEW_TRANSCRIPTION_ENABLED === 'true') {
    if (!data.DEEPGRAM_API_KEY) {
      context.addIssue({ code: 'custom', path: ['DEEPGRAM_API_KEY'], message: 'DEEPGRAM_API_KEY is required when INTERVIEW_TRANSCRIPTION_ENABLED=true' })
    }
    if (!/^https:\/\/api\.eu\.deepgram\.com/i.test(data.DEEPGRAM_BASE_URL)) {
      context.addIssue({ code: 'custom', path: ['DEEPGRAM_BASE_URL'], message: 'DEEPGRAM_BASE_URL must be the EU endpoint (api.eu.deepgram.com) when INTERVIEW_TRANSCRIPTION_ENABLED=true' })
    }
  }

  if (data.SENSITIVE_AI_ENABLED === 'true' && data.SENSITIVE_AI_PROVIDER === 'mistral') {
    if (!data.MISTRAL_API_KEY) {
      context.addIssue({ code: 'custom', path: ['MISTRAL_API_KEY'], message: 'MISTRAL_API_KEY is required when SENSITIVE_AI_ENABLED=true and SENSITIVE_AI_PROVIDER=mistral' })
    }
    // Exact match, not a substring or suffix test. Mistral's EU platform is this one host; its US
    // endpoint is an explicit opt-in. Pinning the value means a typo, a proxy or a deliberate
    // redirection all fail closed instead of quietly moving candidate data out of the EU. This is
    // the check the Azure equivalent could not express: there, EU-ness was a per-deployment
    // property the env could not see (interview-provider-register.md §4).
    if (data.MISTRAL_BASE_URL.replace(/\/+$/, '') !== 'https://api.mistral.ai') {
      context.addIssue({ code: 'custom', path: ['MISTRAL_BASE_URL'], message: 'MISTRAL_BASE_URL must be exactly https://api.mistral.ai (the EU platform) when SENSITIVE_AI_ENABLED=true' })
    }
    // Reject floating aliases: candidate-facing evaluation output must be attributable to a known
    // model version. `mistral-medium-latest` silently changes what assessed a candidate.
    if (!data.MISTRAL_MODEL) {
      context.addIssue({ code: 'custom', path: ['MISTRAL_MODEL'], message: 'MISTRAL_MODEL is required when SENSITIVE_AI_ENABLED=true and SENSITIVE_AI_PROVIDER=mistral' })
    } else if (/latest$/i.test(data.MISTRAL_MODEL)) {
      context.addIssue({ code: 'custom', path: ['MISTRAL_MODEL'], message: 'MISTRAL_MODEL must pin an explicit dated model id (e.g. mistral-medium-2604), not a floating *-latest alias' })
    }
  }

  if (data.SENSITIVE_AI_ENABLED === 'true' && data.SENSITIVE_AI_PROVIDER === 'azure') {
    const EU_AZURE_REGIONS = ['westeurope', 'northeurope', 'francecentral', 'germanywestcentral', 'swedencentral', 'switzerlandnorth']
    const endpointHost = (() => {
      try {
        return new URL(data.AZURE_OPENAI_ENDPOINT ?? '').hostname.toLowerCase()
      } catch {
        return ''
      }
    })()
    // NOTE: this remains a substring test on the hostname, which is weaker than it looks — it can
    // be satisfied by resource naming alone and cannot see the deployment type, so a Global
    // Standard deployment (processing outside the EU) passes. Tracked for replacement with an
    // explicit AZURE_OPENAI_REGION var; see interview-provider-register.md §4b.
    if (!data.AZURE_OPENAI_ENDPOINT || !EU_AZURE_REGIONS.some((region) => endpointHost.includes(region))) {
      context.addIssue({ code: 'custom', path: ['AZURE_OPENAI_ENDPOINT'], message: 'AZURE_OPENAI_ENDPOINT must be a regional EU Azure OpenAI deployment when SENSITIVE_AI_ENABLED=true' })
    }
    if (!data.AZURE_OPENAI_API_KEY) context.addIssue({ code: 'custom', path: ['AZURE_OPENAI_API_KEY'], message: 'AZURE_OPENAI_API_KEY is required when SENSITIVE_AI_ENABLED=true' })
    if (!data.AZURE_OPENAI_DEPLOYMENT) context.addIssue({ code: 'custom', path: ['AZURE_OPENAI_DEPLOYMENT'], message: 'AZURE_OPENAI_DEPLOYMENT is required when SENSITIVE_AI_ENABLED=true' })
    if (!data.AZURE_OPENAI_API_VERSION) context.addIssue({ code: 'custom', path: ['AZURE_OPENAI_API_VERSION'], message: 'AZURE_OPENAI_API_VERSION is required when SENSITIVE_AI_ENABLED=true' })
  }
})

// Plan: calendar-scheduling-interview-intelligence. These provider secrets must never leak to
// the client via a stray VITE_-prefixed copy — checked against the raw input in every
// environment, not just production, since it's a static shape mistake rather than a runtime
// dependency check.
const INTERVIEW_SECRET_KEYS = [
  'INTERVIEW_R2_ACCESS_KEY_ID', 'INTERVIEW_R2_SECRET_ACCESS_KEY',
  'INTERVIEW_CLAMAV_HOST', 'DEEPGRAM_API_KEY', 'AZURE_OPENAI_API_KEY',
  'MISTRAL_API_KEY',
]

export function parseEnvironment(input: Record<string, unknown>) {
  for (const key of INTERVIEW_SECRET_KEYS) {
    if (typeof input[`VITE_${key}`] !== 'undefined') {
      throw new Error(`VITE_${key} must never be set — this is a server-only secret`)
    }
  }
  return zodEnv.parse(input)
}

// In the browser, the server-only env vars aren't available. Provide safe
// defaults so importing this module on the client doesn't crash. The actual
// server runtime always has these set (see .env).
const isBrowser = typeof window !== 'undefined'

const safeProcessEnv = isBrowser
  ? {
      // Non-empty placeholders so zod's .min(1) check passes. The real values
      // are never read on the client; server functions go over the wire.
      DATABASE_URL: 'postgres://placeholder:placeholder@localhost:5432/placeholder',
      NODE_ENV: 'development',
      APP_URL: window.location.origin,
      VITE_APP_URL: window.location.origin,
      BETTER_AUTH_SECRET: 'browser-stub-not-used',
    }
  : process.env

export const env = parseEnvironment(safeProcessEnv)
