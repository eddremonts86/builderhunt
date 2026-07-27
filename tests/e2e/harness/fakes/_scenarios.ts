/**
 * Wave 1 Task 4 — single source of truth for every named fake scenario
 * (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md §Step 7).
 *
 * The vocabularies mirror the seams in `src/` exactly:
 *   - billing: `src/shared/lib/billing/fake-provider.ts`'s existing
 *     vocabulary (unchanged — no new scenarios).
 *   - discovery: the deterministic stubs in `src/shared/lib/ai/embeddings.ts`
 *     and `src/shared/lib/ai/enrichment.ts`.
 *   - AI task: the registry seam in `src/shared/lib/ai/tasks.ts`.
 */

export const E2E_BILLING_SCENARIOS = [
  'success',
  'sca_required',
  'decline',
  'timeout',
  'delayed',
  'out_of_order',
] as const
export type E2EBillingScenario = (typeof E2E_BILLING_SCENARIOS)[number]

export const E2E_DISCOVERY_SCENARIOS = [
  'success',
  'empty',
  'malformed',
  'hostile',
  'timeout',
  'rate_limited',
  'fallback',
] as const
export type E2EDiscoveryScenario = (typeof E2E_DISCOVERY_SCENARIOS)[number]

export const E2E_AI_TASK_SCENARIOS = ['success', 'disabled', 'budget_exceeded', 'unsupported'] as const
export type E2EAITaskScenario = (typeof E2E_AI_TASK_SCENARIOS)[number]

export function assertScenario<T extends string>(value: string, allowed: readonly T[], envVar: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Unknown ${envVar} "${value}" — expected one of: ${allowed.join(', ')}`)
  }
  return value as T
}

function requireE2EMode(what: string): void {
  if (process.env.E2E_MODE !== 'true') {
    throw new Error(`${what} is E2E-only (E2E_MODE=true required)`)
  }
}

/** Shared env-var scenario setter used by the per-boundary fake modules. */
export function setScenarioEnv<T extends string>(
  envVar: string,
  value: string,
  allowed: readonly T[],
  what: string,
): T {
  requireE2EMode(what)
  const scenario = assertScenario(value, allowed, envVar)
  process.env[envVar] = scenario
  return scenario
}

/** Reset semantics: unsetting the env var restores the `success` default. */
export function resetScenarioEnv(envVar: string): void {
  delete process.env[envVar]
}
