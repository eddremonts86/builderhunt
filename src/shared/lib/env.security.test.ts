import { describe, expect, it } from 'vitest'
import { parseEnvironment } from './env'

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
    expect(parsed).toMatchObject({
      TENANT_READ_MODE: 'legacy',
      TENANT_WRITE_MODE: 'legacy',
      TENANT_CANONICAL_READY: false,
    })
  })

  it('parses explicit tenant migration gates without permissive boolean coercion', () => {
    expect(parseEnvironment({ ...productionEnvironment, TENANT_CANONICAL_READY: 'true' }).TENANT_CANONICAL_READY).toBe(true)
    expect(() => parseEnvironment({ ...productionEnvironment, TENANT_CANONICAL_READY: 'yes' })).toThrow()
    expect(() => parseEnvironment({ ...productionEnvironment, TENANT_READ_MODE: 'on' })).toThrow()
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
