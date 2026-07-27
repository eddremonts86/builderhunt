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
