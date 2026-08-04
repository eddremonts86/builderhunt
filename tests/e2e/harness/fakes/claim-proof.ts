/**
 * E2E claim-proof scenario selector — the harness side of the seam in
 * `src/shared/lib/claim-sources/index.ts`.
 *
 * Why a fake exists here at all: every claim-source adapter verifies by fetching a live profile page
 * (`api.github.com/users/...` and equivalents). Two independent things make the verified state unreachable in
 * a test otherwise —
 *
 *   1. the egress guard (`./egress.ts`) blocks every non-local host under `E2E_MODE`, so a real fetch raises
 *      `EgressBlockedError`, which the adapters catch and report as `not_found`; and
 *   2. even with the network open it could not be arranged, because the challenge string is minted per claim
 *      and no real profile's bio contains a value that did not exist when the test started.
 *
 * The vocabulary is `ClaimProofFailureReason` plus `success` and nothing more, so the fake can only produce
 * answers a real adapter could produce.
 *
 * Use `setServerClaimProofScenario` for anything that goes through the app server, which is everything the
 * claim flow does — the env-var setter below only reaches code evaluated inside the runner process.
 */
import { redis } from '../cache'
import { E2E_CLAIM_PROOF_SCENARIOS, resetScenarioEnv, setScenarioEnv, type E2EClaimProofScenario } from './_scenarios'

export { E2E_CLAIM_PROOF_SCENARIOS }
export type { E2EClaimProofScenario }

const ENV_VAR = 'E2E_CLAIM_PROOF_SCENARIO'

/** Sets the run-wide default in *this* process. The app server, spawned earlier, will not see it. */
export function setClaimProofScenario(scenario: E2EClaimProofScenario): E2EClaimProofScenario {
  return setScenarioEnv(ENV_VAR, scenario, E2E_CLAIM_PROOF_SCENARIOS, 'setClaimProofScenario')
}

export function resetClaimProofScenario(): void {
  resetScenarioEnv(ENV_VAR)
}

/**
 * Sets the scenario for the *running app server*, mid-test.
 *
 * The server reads `${prefix}:e2e:claim-proof-scenario` from the worker's own Redis namespace before falling
 * back to its inherited env var, so writing this key takes effect on the very next request. Pass `null` to
 * hand control back to the env default — and do that in cleanup, or a later test in the same worker inherits
 * a scenario it never asked for.
 */
export async function setServerClaimProofScenario(
  redisPrefix: string,
  scenario: E2EClaimProofScenario | null,
): Promise<void> {
  const client = await redis.client(redisPrefix)
  try {
    const key = `${redisPrefix}:e2e:claim-proof-scenario`
    if (scenario === null) await client.del(key)
    // Self-expiring, so a crashed run cannot leave a scenario pinned for the next one.
    else await client.set(key, scenario, 'EX', 900)
  } finally {
    await client.quit()
  }
}
