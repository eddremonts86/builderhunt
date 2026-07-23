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
  DATABASE_MIGRATION_URL: z.string().min(1).optional(),
  DATABASE_AUTH_URL: z.string().min(1).optional(),
  DATABASE_WORKER_URL: z.string().min(1).optional(),
  DATABASE_PLATFORM_URL: z.string().min(1).optional(),
  TENANT_READ_MODE: z.enum(['legacy', 'shadow', 'canonical']).default('legacy'),
  TENANT_WRITE_MODE: z.enum(['legacy', 'dual', 'canonical']).default('legacy'),
  TENANT_CANONICAL_READY: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
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
  HASHNODE_API_KEY: z.string().optional(),
  SOURCEHUT_TOKEN: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  MINIMAX_API_KEY: z.string().optional(),
  MINIMAX_BASE_URL: z.string().default('https://api.minimax.io'),
  MINIMAX_MODEL: z.string().default('MiniMax-M3'),
  AI_EMBEDDING_URL: z.string().optional(),
  AI_EMBEDDING_MODEL: z.string().optional(),
  AI_EMBEDDING_API_KEY: z.string().optional(),
  AI_EMBEDDING_DIM: z.coerce.number().int().positive().default(1536),
  AI_EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  AI_DISABLED: z.enum(['true', 'false']).default('false'),
  AI_DISABLED_TASKS: z.string().default(''),
  // Plan: proactive-discovery
  DISCOVERY_CELLS_PER_RUN: z.coerce.number().int().positive().default(2),
  DISCOVERY_DAILY_STUB_CAP: z.coerce.number().int().positive().default(1500),
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
  STRIPE_API_VERSION: z.string().optional(),
}).superRefine((data, context) => {
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
    // Mixed test/live mode: a live secret key paired with a webhook secret
    // minted for a different (test-mode) endpoint — or vice versa — is a
    // classic misconfiguration Stripe's own dashboard won't catch for you.
    // We can't verify the webhook secret's mode from its value alone (it's
    // an opaque token), so this only catches the key/env-name mismatch: a
    // live key outside NODE_ENV=production is never intentional here.
    if (data.STRIPE_SECRET_KEY?.startsWith('sk_live_') && data.NODE_ENV !== 'production') {
      context.addIssue({ code: 'custom', path: ['STRIPE_SECRET_KEY'], message: 'A live Stripe secret key must never be used outside NODE_ENV=production' })
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
})

export function parseEnvironment(input: Record<string, unknown>) {
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
