/**
 * Wave 1 Task 4 — E2E billing scenario selector
 * (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md).
 *
 * The provider seam itself lives in
 * `src/shared/lib/billing/stripe-provider.ts`: under `E2E_MODE=true`,
 * `getBillingProvider()` returns the deterministic `FakeBillingProvider`
 * and `E2E_BILLING_SCENARIO` supplies the DEFAULT `scenario` for every
 * create call (a per-call `scenario` still wins — no new parameter shape).
 * This module is the harness-side control surface for that env var, using
 * the existing scenario vocabulary only.
 */
import { E2E_BILLING_SCENARIOS, resetScenarioEnv, setScenarioEnv, type E2EBillingScenario } from './_scenarios'
import { redis } from '../cache'

export { E2E_BILLING_SCENARIOS }
export type { E2EBillingScenario }

const ENV_VAR = 'E2E_BILLING_SCENARIO'

/** Sets the default billing scenario for subsequent provider create calls. */
export function setBillingScenario(scenario: E2EBillingScenario): E2EBillingScenario {
  return setScenarioEnv(ENV_VAR, scenario, E2E_BILLING_SCENARIOS, 'setBillingScenario')
}

/** Reset semantics: back to the `success` default (env var unset). */
export function resetBillingScenario(): void {
  resetScenarioEnv(ENV_VAR)
}

/** The scenario currently in force (`success` when unset). */
export function currentBillingScenario(): E2EBillingScenario {
  const raw = process.env[ENV_VAR]
  if (!raw) return 'success'
  if (!(E2E_BILLING_SCENARIOS as readonly string[]).includes(raw)) {
    throw new Error(`Unknown ${ENV_VAR} "${raw}" — expected one of: ${E2E_BILLING_SCENARIOS.join(', ')}`)
  }
  return raw as E2EBillingScenario
}

/**
 * Sets the scenario for the *running app server*, mid-test.
 *
 * `setBillingScenario` above mutates this process's environment, which the app server — a child spawned
 * before the test began — cannot see. That made a scenario fixed for the life of the server and forced the
 * billing matrix into one file per scenario.
 *
 * The server reads `${prefix}:e2e:billing-scenario` from the worker's own Redis namespace before falling back
 * to its inherited env var (see `currentE2EDefaultScenario` in `src/shared/lib/billing/stripe-provider.ts`),
 * so writing that key here takes effect on the very next request. Pass `null` to hand control back to the
 * env default.
 */
export async function setServerBillingScenario(
  redisPrefix: string,
  scenario: E2EBillingScenario | null,
): Promise<void> {
  const client = await redis.client(redisPrefix)
  try {
    const key = `${redisPrefix}:e2e:billing-scenario`
    if (scenario === null) await client.del(key)
    // Self-expiring, so a crashed run cannot leave a scenario pinned for the next one.
    else await client.set(key, scenario, 'EX', 900)
  } finally {
    await client.quit()
  }
}
