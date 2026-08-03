import { describe, expect, it } from 'vitest'
import { parseEnvironment } from '~/shared/lib/env'

const productionEnvironment = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://builderhunt_app:runtime-secret@db:5432/builderhunt',
  DATABASE_MIGRATION_URL: 'postgresql://migration_operator:owner-secret@db:5432/builderhunt',
  DATABASE_AUTH_URL: 'postgresql://builderhunt_auth:auth-secret@db:5432/builderhunt',
  DATABASE_WORKER_URL: 'postgresql://builderhunt_worker:worker-secret@db:5432/builderhunt',
  DATABASE_PLATFORM_URL: 'postgresql://builderhunt_platform:platform-secret@db:5432/builderhunt',
  APP_URL: 'https://builderhunt.example',
  VITE_APP_URL: 'https://builderhunt.example',
  BETTER_AUTH_SECRET: 'a-production-secret-with-more-than-32-characters',
}

describe('production environment security', () => {
  it('accepts separated runtime and migration identities', () => {
    const parsed = parseEnvironment(productionEnvironment)
    expect(parsed.DATABASE_WORKER_URL).toContain('builderhunt_worker')
    expect(parsed.DATABASE_URL).toContain('builderhunt_app')
    expect(parsed.DATABASE_MIGRATION_URL).toContain('migration_operator')
    // The retired tenant-migration flags used to be asserted here. They are gone from the schema entirely
    // (2026-08-03), so zod strips them and there is nothing left to pin — see the note in `env.ts`.
    expect(parsed).not.toHaveProperty('TENANT_READ_MODE')
    expect(parsed).not.toHaveProperty('TENANT_CANONICAL_READY')
  })

  it.each([
    ['owner runtime role', { DATABASE_URL: 'postgresql://builderhunt_owner:x@db:5432/builderhunt' }],
    ['postgres runtime role', { DATABASE_URL: 'postgresql://postgres:x@db:5432/builderhunt' }],
    ['shared migration URL', { DATABASE_MIGRATION_URL: productionEnvironment.DATABASE_URL }],
    ['shared auth URL', { DATABASE_AUTH_URL: productionEnvironment.DATABASE_URL }],
    ['shared worker URL', { DATABASE_WORKER_URL: productionEnvironment.DATABASE_URL }],
    ['shared platform URL', { DATABASE_PLATFORM_URL: productionEnvironment.DATABASE_URL }],
    ['weak auth secret', { BETTER_AUTH_SECRET: 'change_me' }],
  ])('rejects %s', (_label, override) => {
    expect(() => parseEnvironment({ ...productionEnvironment, ...override })).toThrow()
  })

  // DATABASE_AUTH_URL/WORKER_URL/PLATFORM_URL are optional in production: the
  // role-separation cutover is a deliberate, sign-off-gated step that has not
  // happened yet. src/shared/lib/db/{auth-db,worker-db,client}.ts fall back
  // to DATABASE_URL when unset, so parsing must not fail on their absence.
  it.each([
    ['auth URL', { DATABASE_AUTH_URL: undefined }],
    ['worker URL', { DATABASE_WORKER_URL: undefined }],
    ['platform URL', { DATABASE_PLATFORM_URL: undefined }],
    ['migration, auth, worker, and platform URLs', {
      DATABASE_MIGRATION_URL: undefined,
      DATABASE_AUTH_URL: undefined,
      DATABASE_WORKER_URL: undefined,
      DATABASE_PLATFORM_URL: undefined,
    }],
  ])('boots with missing %s (falls back to DATABASE_URL)', (_label, override) => {
    expect(() => parseEnvironment({ ...productionEnvironment, ...override })).not.toThrow()
  })
})

describe('production enrichment security (plan: stealth-scraping)', () => {
  it('boots with enrichment disabled and no enrichment env set (default-safe)', () => {
    const parsed = parseEnvironment(productionEnvironment)
    expect(parsed.ENRICHMENT_ENABLED).toBe('false')
  })

  it('accepts a fully valid enabled configuration', () => {
    const parsed = parseEnvironment({
      ...productionEnvironment,
      ENRICHMENT_ENABLED: 'true',
      ENRICHMENT_ALLOWED_CONNECTORS: 'github',
      ENRICHMENT_USER_AGENT: 'BuilderHuntBot/1.0 (+https://builderhunt.dev/crawler)',
      ENRICHMENT_RAW_RETENTION_DAYS: '30',
      ENRICHMENT_ACCEPTED_RETENTION_DAYS: '180',
    })
    expect(parsed.ENRICHMENT_ENABLED).toBe('true')
  })

  it.each([
    ['empty allowlist while enabled', { ENRICHMENT_ENABLED: 'true', ENRICHMENT_ALLOWED_CONNECTORS: '' }],
    ['user agent without a contact URL', { ENRICHMENT_ENABLED: 'true', ENRICHMENT_ALLOWED_CONNECTORS: 'github', ENRICHMENT_USER_AGENT: 'BuilderHuntBot/1.0' }],
    ['raw retention beyond policy bounds', { ENRICHMENT_ENABLED: 'true', ENRICHMENT_ALLOWED_CONNECTORS: 'github', ENRICHMENT_RAW_RETENTION_DAYS: '365' }],
    ['accepted retention beyond policy bounds', { ENRICHMENT_ENABLED: 'true', ENRICHMENT_ALLOWED_CONNECTORS: 'github', ENRICHMENT_ACCEPTED_RETENTION_DAYS: '3650' }],
  ])('rejects %s', (_label, override) => {
    expect(() => parseEnvironment({ ...productionEnvironment, ...override })).toThrow()
  })
})

describe('stripe billing security (plan: stripe-billing-platform)', () => {
  it('boots with billing disabled and no stripe env set (default-safe)', () => {
    const parsed = parseEnvironment(productionEnvironment)
    expect(parsed.STRIPE_BILLING_ENABLED).toBe('false')
  })

  const VALID_ENCRYPTION_KEY = 'a'.repeat(64)

  it('accepts a fully valid enabled test-mode configuration', () => {
    const parsed = parseEnvironment({
      ...productionEnvironment,
      STRIPE_BILLING_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'sk_test_abc123',
      STRIPE_WEBHOOK_SECRET: 'whsec_abc123',
      STRIPE_API_VERSION: '2025-01-01.acacia',
      WEBHOOK_PAYLOAD_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
    })
    expect(parsed.STRIPE_BILLING_ENABLED).toBe('true')
  })

  it.each([
    ['missing secret key', { STRIPE_BILLING_ENABLED: 'true', STRIPE_WEBHOOK_SECRET: 'whsec_abc123', STRIPE_API_VERSION: '2025-01-01.acacia', WEBHOOK_PAYLOAD_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY }],
    ['malformed secret key', { STRIPE_BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'not-a-real-key', STRIPE_WEBHOOK_SECRET: 'whsec_abc123', STRIPE_API_VERSION: '2025-01-01.acacia', WEBHOOK_PAYLOAD_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY }],
    ['missing webhook secret', { STRIPE_BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_abc123', STRIPE_API_VERSION: '2025-01-01.acacia', WEBHOOK_PAYLOAD_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY }],
    ['malformed webhook secret', { STRIPE_BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_abc123', STRIPE_WEBHOOK_SECRET: 'not-a-real-secret', STRIPE_API_VERSION: '2025-01-01.acacia', WEBHOOK_PAYLOAD_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY }],
    ['missing API version', { STRIPE_BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123', WEBHOOK_PAYLOAD_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY }],
    ['live key outside production', { STRIPE_BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_live_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123', STRIPE_API_VERSION: '2025-01-01.acacia', WEBHOOK_PAYLOAD_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY, NODE_ENV: 'development' }],
    ['missing webhook payload encryption key', { STRIPE_BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123', STRIPE_API_VERSION: '2025-01-01.acacia' }],
    ['malformed webhook payload encryption key (too short)', { STRIPE_BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123', STRIPE_API_VERSION: '2025-01-01.acacia', WEBHOOK_PAYLOAD_ENCRYPTION_KEY: 'abc123' }],
    ['malformed webhook payload encryption key (non-hex)', { STRIPE_BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123', STRIPE_API_VERSION: '2025-01-01.acacia', WEBHOOK_PAYLOAD_ENCRYPTION_KEY: 'z'.repeat(64) }],
  ])('rejects %s (fails closed)', (_label, override) => {
    expect(() => parseEnvironment({ ...productionEnvironment, ...override })).toThrow()
  })

  /**
   * The Stripe key mode must agree with the database the process is pointed at
   * (`plans/phase-1/30-stripe-billing-platform/staging-test-plan.md` §7).
   *
   * `NODE_ENV` cannot carry this, which is the whole reason the check exists: staging is *built* with
   * `NODE_ENV=production`, so the pre-existing "live key outside production" guard waves a copy-pasted
   * `sk_live_` through on any staging deployment. What matters is which data the process holds, and that is
   * declared by `DB_ENV_MARKER` rather than guessed from the connection host — a staging host containing
   * "prod" would read as production, and a production host behind a pooler would not.
   *
   * Both directions are asserted because they fail differently. A live key on a non-production database
   * charges real cards for rows the production ledger does not contain. A test key on the production database
   * charges nothing, which is what makes it insidious: the real ledger accumulates references to Stripe
   * objects that exist only in test mode, and nobody finds out until reconciliation.
   */
  const STRIPE_ENABLED = {
    STRIPE_BILLING_ENABLED: 'true',
    STRIPE_WEBHOOK_SECRET: 'whsec_abc123',
    STRIPE_API_VERSION: '2025-01-01.acacia',
    WEBHOOK_PAYLOAD_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
  }

  it('rejects a live key against a database that is not marked production', () => {
    // NODE_ENV=production on purpose: this is exactly the staging shape the older guard cannot catch.
    expect(() => parseEnvironment({
      ...productionEnvironment,
      ...STRIPE_ENABLED,
      STRIPE_SECRET_KEY: 'sk_live_abc123',
      DB_ENV_MARKER: 'staging',
    })).toThrow(/not marked production/)
  })

  it('rejects a live key when the marker is missing entirely', () => {
    // Absent means "not production", so forgetting the marker refuses a live key rather than permitting one.
    expect(() => parseEnvironment({
      ...productionEnvironment,
      ...STRIPE_ENABLED,
      STRIPE_SECRET_KEY: 'sk_live_abc123',
    })).toThrow(/DB_ENV_MARKER=unset/)
  })

  it('rejects a test key against the production database', () => {
    expect(() => parseEnvironment({
      ...productionEnvironment,
      ...STRIPE_ENABLED,
      STRIPE_SECRET_KEY: 'sk_test_abc123',
      DB_ENV_MARKER: 'production',
    })).toThrow(/exist only in test mode/)
  })

  it('accepts the two configurations that actually make sense', () => {
    // Production: live key, production database.
    expect(() => parseEnvironment({
      ...productionEnvironment,
      ...STRIPE_ENABLED,
      STRIPE_SECRET_KEY: 'sk_live_abc123',
      DB_ENV_MARKER: 'production',
    })).not.toThrow()

    // Everywhere else: test key, anything but the production database.
    for (const marker of ['staging', 'development', 'test'] as const) {
      expect(() => parseEnvironment({
        ...productionEnvironment,
        ...STRIPE_ENABLED,
        STRIPE_SECRET_KEY: 'sk_test_abc123',
        DB_ENV_MARKER: marker,
      }), `sk_test_ with DB_ENV_MARKER=${marker} must be allowed`).not.toThrow()
    }
  })

  it('says nothing about the pairing when no Stripe key is configured', () => {
    // The check is about a key's mode, not about `DB_ENV_MARKER` on its own. A production deployment with
    // billing still switched off must boot.
    expect(() => parseEnvironment({ ...productionEnvironment, DB_ENV_MARKER: 'production' })).not.toThrow()
  })

  // Unlike enrichment, this must fail closed in every environment, not just
  // production — sandbox testing with real Stripe test keys happens well
  // before the plan's live-rollout phase.
  it('fails closed outside production too (not gated behind the production-only checks)', () => {
    expect(() => parseEnvironment({
      ...productionEnvironment,
      NODE_ENV: 'development',
      STRIPE_BILLING_ENABLED: 'true',
      // no STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET/STRIPE_API_VERSION/WEBHOOK_PAYLOAD_ENCRYPTION_KEY set
    })).toThrow()
  })

  it('accepts a valid enabled test-mode configuration outside production', () => {
    const parsed = parseEnvironment({
      ...productionEnvironment,
      NODE_ENV: 'development',
      STRIPE_BILLING_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'sk_test_abc123',
      STRIPE_WEBHOOK_SECRET: 'whsec_abc123',
      STRIPE_API_VERSION: '2025-01-01.acacia',
      WEBHOOK_PAYLOAD_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
    })
    expect(parsed.STRIPE_BILLING_ENABLED).toBe('true')
  })

  it('accepts an optional STRIPE_WEBHOOK_SECRET_PREVIOUS during a rotation window', () => {
    const parsed = parseEnvironment({
      ...productionEnvironment,
      STRIPE_BILLING_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'sk_test_abc123',
      STRIPE_WEBHOOK_SECRET: 'whsec_abc123',
      STRIPE_WEBHOOK_SECRET_PREVIOUS: 'whsec_previous123',
      STRIPE_API_VERSION: '2025-01-01.acacia',
      WEBHOOK_PAYLOAD_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
    })
    expect(parsed.STRIPE_WEBHOOK_SECRET_PREVIOUS).toBe('whsec_previous123')
  })
})

describe('abuse-and-usage-integrity environment (plan: abuse-and-usage-integrity)', () => {
  it('defaults to observe-only with every threshold set, when nothing is configured', () => {
    const parsed = parseEnvironment(productionEnvironment)
    expect(parsed.ABUSE_ENFORCEMENT_MODE).toBe('observe')
    expect(parsed.SIGNUP_REQUIRE_VERIFIED_EMAIL).toBe('false')
    expect(parsed.SIGNUP_BLOCK_DISPOSABLE_EMAILS).toBe('false')
    expect(parsed.ABUSE_ALLOWLIST_ASNS).toBe('')
    expect(parsed).toMatchObject({
      SESSION_MAX_CONCURRENT_FREE: 2,
      SESSION_MAX_CONCURRENT_PRO: 3,
      SESSION_MAX_CONCURRENT_TEAM_PER_SEAT: 2,
      SESSION_IDLE_TIMEOUT_MINUTES: 10080,
      SESSION_ABSOLUTE_TIMEOUT_HOURS: 720,
      SEAT_DAILY_SEARCHES: 200,
      SEAT_DAILY_REVEALS: 100,
      SEAT_DAILY_EXPORTS: 20,
      SEAT_DAILY_MESSAGES: 100,
    })
  })

  it('rejects an enforcement mode outside the fixed enum, never permissively coercing', () => {
    expect(() => parseEnvironment({ ...productionEnvironment, ABUSE_ENFORCEMENT_MODE: 'block' })).toThrow()
  })

  it('coerces numeric thresholds from string env values, and rejects a non-numeric override', () => {
    const parsed = parseEnvironment({ ...productionEnvironment, SESSION_MAX_CONCURRENT_FREE: '5' })
    expect(parsed.SESSION_MAX_CONCURRENT_FREE).toBe(5)
    expect(() => parseEnvironment({ ...productionEnvironment, SESSION_MAX_CONCURRENT_FREE: 'unlimited' })).toThrow()
  })

  it('accepts warn/enforce explicitly, never assuming observe silently means the same thing', () => {
    expect(parseEnvironment({ ...productionEnvironment, ABUSE_ENFORCEMENT_MODE: 'warn' }).ABUSE_ENFORCEMENT_MODE).toBe('warn')
    expect(parseEnvironment({ ...productionEnvironment, ABUSE_ENFORCEMENT_MODE: 'enforce' }).ABUSE_ENFORCEMENT_MODE).toBe('enforce')
  })
})

describe('calendar-scheduling-interview-intelligence environment (plan: calendar-scheduling-interview-intelligence)', () => {
  const VALID_MINIO = {
    CANDIDATE_UPLOADS_ENABLED: 'true',
    INTERVIEW_R2_ENDPOINT: 'http://minio:9000',
    INTERVIEW_R2_ACCOUNT_ID: 'minio',
    INTERVIEW_R2_BUCKET: 'builderhunt-interview-documents',
    INTERVIEW_R2_ACCESS_KEY_ID: 'minio-key',
    INTERVIEW_R2_SECRET_ACCESS_KEY: 'minio-secret',
    INTERVIEW_CLAMAV_HOST: 'clamav',
  }
  const VALID_R2 = {
    CANDIDATE_UPLOADS_ENABLED: 'true',
    INTERVIEW_R2_ENDPOINT: 'https://accountid.eu.r2.cloudflarestorage.com',
    INTERVIEW_R2_ACCOUNT_ID: 'accountid',
    INTERVIEW_R2_BUCKET: 'interview-uploads',
    INTERVIEW_R2_ACCESS_KEY_ID: 'r2-access-key',
    INTERVIEW_R2_SECRET_ACCESS_KEY: 'r2-secret-key',
    INTERVIEW_CLAMAV_HOST: 'clamav.internal',
  }
  const VALID_DEEPGRAM = {
    INTERVIEW_TRANSCRIPTION_ENABLED: 'true',
    DEEPGRAM_API_KEY: 'deepgram-key',
  }
  // Mistral is the default sensitive-AI provider (interview-provider-register.md §4).
  const VALID_MISTRAL = {
    SENSITIVE_AI_ENABLED: 'true',
    MISTRAL_API_KEY: 'mistral-key',
    MISTRAL_MODEL: 'mistral-medium-2604',
  }
  // Azure is the retained fallback and only validated when explicitly selected.
  const VALID_AZURE = {
    SENSITIVE_AI_ENABLED: 'true',
    SENSITIVE_AI_PROVIDER: 'azure',
    AZURE_OPENAI_ENDPOINT: 'https://my-deployment.westeurope.api.cognitive.microsoft.com',
    AZURE_OPENAI_API_KEY: 'azure-key',
    AZURE_OPENAI_DEPLOYMENT: 'gpt-eu-deployment',
    AZURE_OPENAI_API_VERSION: '2024-08-01-preview',
  }

  it('boots with every calendar-scheduling flag disabled and no provider config set (default-safe)', () => {
    const parsed = parseEnvironment(productionEnvironment)
    expect(parsed).toMatchObject({
      CALENDAR_ENABLED: 'false',
      SCHEDULING_ENABLED: 'false',
      CANDIDATE_UPLOADS_ENABLED: 'false',
      CANDIDATE_WEB_IMPORT_ENABLED: 'false',
      SENSITIVE_AI_ENABLED: 'false',
      INTERVIEW_TRANSCRIPTION_ENABLED: 'false',
      INTERVIEW_CONTEXTUAL_QUESTIONS_ENABLED: 'false',
      CALENDAR_OPERATIONAL_LAYERS_ENABLED: 'false',
      INTERVIEW_R2_JURISDICTION: 'eu',
      DEEPGRAM_BASE_URL: 'https://api.eu.deepgram.com',
      INTERVIEW_TRANSCRIPT_RETENTION_DAYS: 90,
      INTERVIEW_DOCUMENT_RETENTION_DAYS: 180,
      INTERVIEW_CONSENT_RETENTION_MONTHS: 24,
    })
  })

  it('accepts a self-hosted MinIO endpoint — the chosen default, no third party involved', () => {
    // docs/operations/interview-provider-register.md: storage is self-hosted; there is no
    // jurisdiction to police because no third party receives the data.
    expect(() => parseEnvironment({ ...productionEnvironment, ...VALID_MINIO })).not.toThrow()
  })

  it.each([
    ['a bare docker service name', 'http://minio:9000'],
    ['localhost', 'http://localhost:9000'],
    ['a 10.x private address', 'http://10.0.0.5:9000'],
    ['a 192.168.x private address', 'http://192.168.1.20:9000'],
    ['a 172.16-31.x private address', 'http://172.20.0.4:9000'],
  ])('accepts %s as a self-hosted storage endpoint', (_label, endpoint) => {
    expect(() => parseEnvironment({ ...productionEnvironment, ...VALID_MINIO, INTERVIEW_R2_ENDPOINT: endpoint })).not.toThrow()
  })

  it.each([
    ['a non-EU R2 bucket', 'https://accountid.r2.cloudflarestorage.com'],
    ['some other public S3 host', 'https://s3.us-east-1.amazonaws.com'],
    ['a public domain pretending to be internal', 'https://minio.example.com'],
  ])('still rejects %s — a typo must not send candidate CVs to an unreviewed third country', (_label, endpoint) => {
    expect(() => parseEnvironment({ ...productionEnvironment, ...VALID_MINIO, INTERVIEW_R2_ENDPOINT: endpoint })).toThrow()
  })

  it('accepts a fully valid enabled configuration for each dependency', () => {
    const parsed = parseEnvironment({ ...productionEnvironment, ...VALID_R2, ...VALID_DEEPGRAM, ...VALID_MISTRAL })
    expect(parsed.CANDIDATE_UPLOADS_ENABLED).toBe('true')
    expect(parsed.INTERVIEW_TRANSCRIPTION_ENABLED).toBe('true')
    expect(parsed.SENSITIVE_AI_ENABLED).toBe('true')
    expect(parsed.SENSITIVE_AI_PROVIDER).toBe('mistral')
    expect(parsed.MISTRAL_BASE_URL).toBe('https://api.mistral.ai')
  })

  it('accepts the retained Azure fallback when it is explicitly selected', () => {
    const parsed = parseEnvironment({ ...productionEnvironment, ...VALID_AZURE })
    expect(parsed.SENSITIVE_AI_PROVIDER).toBe('azure')
    expect(parsed.SENSITIVE_AI_ENABLED).toBe('true')
  })

  it('does not require Azure config when the provider is Mistral, or vice versa', () => {
    // The two providers must not leak requirements into each other: selecting one must not make the
    // other's vars mandatory, otherwise the fallback is impossible to configure independently.
    expect(() => parseEnvironment({ ...productionEnvironment, ...VALID_MISTRAL })).not.toThrow()
    expect(() => parseEnvironment({ ...productionEnvironment, ...VALID_AZURE })).not.toThrow()
  })

  it.each([
    ['R2 endpoint missing when uploads enabled', { ...VALID_R2, INTERVIEW_R2_ENDPOINT: undefined }],
    ['R2 endpoint outside the EU jurisdiction', { ...VALID_R2, INTERVIEW_R2_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com' }],
    ['R2 account id missing when uploads enabled', { ...VALID_R2, INTERVIEW_R2_ACCOUNT_ID: undefined }],
    ['R2 bucket missing when uploads enabled', { ...VALID_R2, INTERVIEW_R2_BUCKET: undefined }],
    ['R2 access key missing when uploads enabled', { ...VALID_R2, INTERVIEW_R2_ACCESS_KEY_ID: undefined }],
    ['R2 secret key missing when uploads enabled', { ...VALID_R2, INTERVIEW_R2_SECRET_ACCESS_KEY: undefined }],
    ['ClamAV host missing when uploads enabled', { ...VALID_R2, INTERVIEW_CLAMAV_HOST: undefined }],
    ['Deepgram key missing when transcription enabled', { ...VALID_DEEPGRAM, DEEPGRAM_API_KEY: undefined }],
    ['Deepgram base URL overridden to a non-EU endpoint', { ...VALID_DEEPGRAM, DEEPGRAM_BASE_URL: 'https://api.deepgram.com' }],
    ['Mistral key missing when sensitive AI enabled', { ...VALID_MISTRAL, MISTRAL_API_KEY: undefined }],
    ['Mistral model missing when sensitive AI enabled', { ...VALID_MISTRAL, MISTRAL_MODEL: undefined }],
    // The residency guard: anything that is not exactly the EU platform host must fail closed.
    ['Mistral base URL pointed at the US endpoint', { ...VALID_MISTRAL, MISTRAL_BASE_URL: 'https://api.us.mistral.ai' }],
    ['Mistral base URL pointed at an arbitrary proxy', { ...VALID_MISTRAL, MISTRAL_BASE_URL: 'https://proxy.example.com' }],
    // A host that merely *contains* the EU host must not pass — this is the class of bug the Azure
    // substring check has (interview-provider-register.md §4).
    ['Mistral base URL on a lookalike host', { ...VALID_MISTRAL, MISTRAL_BASE_URL: 'https://api.mistral.ai.evil.example' }],
    // Floating aliases are rejected: candidate-evaluation output must be attributable to a version.
    ['Mistral model pinned to a floating alias', { ...VALID_MISTRAL, MISTRAL_MODEL: 'mistral-medium-latest' }],
    ['Azure endpoint missing when sensitive AI enabled', { ...VALID_AZURE, AZURE_OPENAI_ENDPOINT: undefined }],
    ['Azure endpoint outside an EU region', { ...VALID_AZURE, AZURE_OPENAI_ENDPOINT: 'https://my-deployment.eastus.api.cognitive.microsoft.com' }],
    ['Azure key missing when sensitive AI enabled', { ...VALID_AZURE, AZURE_OPENAI_API_KEY: undefined }],
    ['Azure deployment missing when sensitive AI enabled', { ...VALID_AZURE, AZURE_OPENAI_DEPLOYMENT: undefined }],
    ['Azure API version missing when sensitive AI enabled', { ...VALID_AZURE, AZURE_OPENAI_API_VERSION: undefined }],
    ['malformed transcript retention (exceeds 90-day ceiling)', { INTERVIEW_TRANSCRIPT_RETENTION_DAYS: '91' }],
    ['malformed document retention (exceeds 180-day ceiling)', { INTERVIEW_DOCUMENT_RETENTION_DAYS: '181' }],
    ['malformed consent retention (exceeds 24-month ceiling)', { INTERVIEW_CONSENT_RETENTION_MONTHS: '25' }],
  ])('rejects %s (fails closed)', (_label, override) => {
    expect(() => parseEnvironment({ ...productionEnvironment, ...override })).toThrow()
  })

  it.each([
    ['INTERVIEW_R2_ACCESS_KEY_ID', 'leaked-r2-key'],
    ['INTERVIEW_R2_SECRET_ACCESS_KEY', 'leaked-r2-secret'],
    ['INTERVIEW_CLAMAV_HOST', 'leaked-clamav-host'],
    ['DEEPGRAM_API_KEY', 'leaked-deepgram-key'],
    ['AZURE_OPENAI_API_KEY', 'leaked-azure-key'],
    ['MISTRAL_API_KEY', 'leaked-mistral-key'],
  ])('rejects a stray VITE_-prefixed copy of %s (client-secret leakage)', (key, value) => {
    expect(() => parseEnvironment({ ...productionEnvironment, [`VITE_${key}`]: value })).toThrow()
  })

  it('does not require provider config outside production (dependency checks are production-only, like enrichment)', () => {
    expect(() => parseEnvironment({
      ...productionEnvironment,
      NODE_ENV: 'development',
      CANDIDATE_UPLOADS_ENABLED: 'true',
      // no R2/ClamAV config set
    })).not.toThrow()
  })
})
