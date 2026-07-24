/**
 * Wave 1 Task 1 — strict E2E environment parser.
 *
 * Mirrors the discipline of `src/shared/lib/env.ts` (fail closed on
 * missing/misconfigured values) but for the E2E harness: every test-only
 * seam is gated behind `E2E_MODE=true`, and the parser refuses to
 * resolve if the seam is reachable in production mode. The singleton
 * `e2eEnv()` is intentionally exported as a function — multiple test
 * files can call it after `process.env` is mutated, and the result
 * reflects the current process state, not a cached snapshot.
 *
 * The E2E seams this file protects (delegated out to the consumer):
 *   - per-worker disposable databases created by `database.ts`
 *   - per-worker Redis namespace acquired by `cache.ts`
 *   - worker-prefixed rate-limit buckets in `src/shared/lib/rate-limit.ts`
 *
 * If any of those seams can be reached without `E2E_MODE=true`, this
 * codebase has an isolation bug — fail loud, not silent.
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'

const e2eEnvSchema = z.object({
  E2E_MODE: z.enum(['true', 'false']).default('false'),
  // E2E always requires Redis — process-global in-memory rate-limit
  // fallback is forbidden in E2E mode (spec §"Coverage manifest" /
  // global constraints: "E2E requires Redis; the in-memory rate-limit
  // fallback must fail closed in E2E mode").
  REDIS_URL: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_MIGRATION_URL: z.string().min(1, 'DATABASE_MIGRATION_URL is required'),
  DATABASE_AUTH_URL: z.string().min(1).optional(),
  DATABASE_WORKER_URL: z.string().min(1).optional(),
  DATABASE_PLATFORM_URL: z.string().min(1).optional(),
  E2E_RUN_ID: z.string().min(1).optional(),
  E2E_FIXED_TIME: z.string().optional(),
  // Wave 1 Task 4 — external-service fake seams
  // (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md).
  // All optional; every consumer of these vars is additionally gated on
  // E2E_MODE=true, so they are inert in any other mode.
  E2E_BILLING_SCENARIO: z.enum(['success', 'sca_required', 'decline', 'timeout', 'delayed', 'out_of_order']).optional(),
  E2E_STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  E2E_STRIPE_WEBHOOK_SECRET_PREVIOUS: z.string().min(1).optional(),
  E2E_EMBEDDINGS_SCENARIO: z.enum(['success', 'empty', 'malformed', 'hostile', 'timeout', 'rate_limited', 'fallback']).optional(),
  E2E_ENRICHMENT_SCENARIO: z.enum(['success', 'empty', 'malformed', 'hostile', 'timeout', 'rate_limited', 'fallback']).optional(),
  E2E_AI_TASK_SCENARIO: z.enum(['success', 'disabled', 'budget_exceeded', 'unsupported']).optional(),
  E2E_OUTBOX_MODE: z.enum(['memory']).default('memory'),
  // Playwright sets TEST_PARALLEL_INDEX to the worker index (0-based) for
  // every test file and worker process. We surface it for the harness
  // but never require it: unit-style E2E tests that don't run under
  // Playwright still get a deterministic default.
  TEST_PARALLEL_INDEX: z.string().optional(),
  CI: z.string().optional(),
})

export type E2EEnv = z.infer<typeof e2eEnvSchema>

/**
 * File path written by `globalSetup` and read by the worker process at
 * the first import of `env.ts`. Workers inherit a copy of the parent's
 * env, but Playwright does not propagate every custom var the dev
 * server receives — and dynamic `process.env` mutation in `globalSetup`
 * is not visible to workers, so we use a side-channel JSON file.
 */
const E2E_ENV_FILE = `${process.cwd()}/e2e/harness/.e2e-run-id`

function loadFromFile(): void {
  try {
    const raw = readFileSync(E2E_ENV_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, string | undefined>
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined && process.env[key] === undefined) {
        process.env[key] = value
      }
    }
  } catch {
    // No file — caller is on its own for E2E_MODE/REDIS_URL.
  }
}

export function e2eEnv(): E2EEnv {
  // Load the file once per call so fixtures that mutate `process.env`
  // between tests still see the initial values.
  loadFromFile()
  const result = e2eEnvSchema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`E2E environment is invalid:\n${issues}`)
  }
  if (result.data.E2E_MODE !== 'true') {
    throw new Error(
      'E2E_MODE is not "true" — the E2E harness refuses to run in production mode. ' +
        'Set E2E_MODE=true in the Playwright config when starting the test server.',
    )
  }
  if (!result.data.REDIS_URL) {
    throw new Error(
      'REDIS_URL is required when E2E_MODE=true — the in-memory rate-limit fallback is forbidden in E2E mode.',
    )
  }
  const parsed = result.data
  return parsed
}

/** Convenience guards for non-test code paths that want to short-circuit. */
export function isE2EMode(): boolean {
  return process.env.E2E_MODE === 'true'
}

export function workerIndex(): number {
  const raw = process.env.TEST_PARALLEL_INDEX
  if (raw === undefined || raw === '') return 0
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

export function runId(): string {
  const explicit = process.env.E2E_RUN_ID
  if (explicit) return explicit
  // Default to the worker index + a short timestamp so repeat runs in
  // the same playwright invocation don't collide.
  return `e2e-${workerIndex()}-${Date.now().toString(36)}`
}
