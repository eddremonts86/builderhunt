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
}).superRefine((data, context) => {
  if (!data.BETTER_AUTH_SECRET) {
    context.addIssue({
      code: 'custom',
      path: ['BETTER_AUTH_SECRET'],
      message: 'BETTER_AUTH_SECRET is required — generate with: openssl rand -hex 32',
    })
  }

  if (data.NODE_ENV !== 'production') return

  if (!data.DATABASE_AUTH_URL) {
    context.addIssue({ code: 'custom', path: ['DATABASE_AUTH_URL'], message: 'Production DATABASE_AUTH_URL is required' })
  }
  if (!data.DATABASE_WORKER_URL) {
    context.addIssue({ code: 'custom', path: ['DATABASE_WORKER_URL'], message: 'Production DATABASE_WORKER_URL is required' })
  }
  if (!data.DATABASE_PLATFORM_URL) {
    context.addIssue({ code: 'custom', path: ['DATABASE_PLATFORM_URL'], message: 'Production DATABASE_PLATFORM_URL is required' })
  }

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
  if (data.DATABASE_MIGRATION_URL === data.DATABASE_URL) {
    context.addIssue({
      code: 'custom',
      path: ['DATABASE_MIGRATION_URL'],
      message: 'Migration and runtime database identities must be different',
    })
  }
  if (data.DATABASE_AUTH_URL === data.DATABASE_URL || data.DATABASE_AUTH_URL === data.DATABASE_MIGRATION_URL) {
    context.addIssue({
      code: 'custom',
      path: ['DATABASE_AUTH_URL'],
      message: 'Auth, migration, and product database identities must be different',
    })
  }
  if (
    data.DATABASE_WORKER_URL === data.DATABASE_URL
    || data.DATABASE_WORKER_URL === data.DATABASE_AUTH_URL
    || data.DATABASE_WORKER_URL === data.DATABASE_MIGRATION_URL
  ) {
    context.addIssue({
      code: 'custom',
      path: ['DATABASE_WORKER_URL'],
      message: 'Worker, auth, migration, and product database identities must be different',
    })
  }
  if (
    data.DATABASE_PLATFORM_URL === data.DATABASE_URL
    || data.DATABASE_PLATFORM_URL === data.DATABASE_AUTH_URL
    || data.DATABASE_PLATFORM_URL === data.DATABASE_WORKER_URL
    || data.DATABASE_PLATFORM_URL === data.DATABASE_MIGRATION_URL
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
