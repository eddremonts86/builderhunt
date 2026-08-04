import type { ClaimSourceAdapter } from './types'
import { githubClaimAdapter } from './github'
import { gitlabClaimAdapter } from './gitlab'
import { codebergClaimAdapter } from './codeberg'
import { devtoClaimAdapter } from './devto'

export type { ClaimProofResult, ClaimProofFailureReason, ClaimSourceAdapter } from './types'

/**
 * Only sources with a public, fetchable "bio"-shaped field support challenge
 * verification. Aggregator sources with no per-user profile page a claimant
 * could edit (HN, Reddit, npm, Hugging Face, Stack Overflow, Lobsters,
 * SourceHut, Product Hunt, Bluesky) are deliberately absent — claiming a
 * builder from one of those sources returns `unsupported` rather than a
 * false sense of proof.
 */
const CLAIM_SOURCE_ADAPTERS: Partial<Record<string, ClaimSourceAdapter>> = {
  github: githubClaimAdapter,
  gitlab: gitlabClaimAdapter,
  codeberg: codebergClaimAdapter,
  devto: devtoClaimAdapter,
}

/**
 * E2E scenario seam, same shape as `src/shared/lib/ai/embeddings.ts` and `enrichment.ts`.
 *
 * Only reachable when `E2E_MODE=true` **and** `E2E_CLAIM_PROOF_SCENARIO` is explicitly set; the production
 * path is byte-identical otherwise. Both conditions matter — a stray env var in a real deployment cannot
 * reach this, and neither can an E2E run that has not opted in.
 *
 * It exists because the claim flow cannot be driven end to end any other way. Every adapter fetches a live
 * profile page (`api.github.com/users/...` and equivalents), and:
 *
 *   * the harness's egress guard blocks every non-local host in E2E mode, so a real fetch resolves to
 *     `EgressBlockedError`, which the adapters catch and report as `not_found` — the verified state is
 *     simply unreachable; and
 *   * even with the network open it could not be arranged, because the challenge is minted per claim and
 *     no real profile's bio contains a string that did not exist when the test started.
 *
 * The scenario vocabulary is `ClaimProofFailureReason` plus `success`, so a fake can only produce answers a
 * real adapter could produce. Adding a value here that the adapters cannot return would make the seam a
 * source of fiction rather than a stand-in.
 */
const E2E_SCENARIO_ENV_VAR = 'E2E_CLAIM_PROOF_SCENARIO'

const E2E_SCENARIOS = ['success', 'not_found', 'challenge_missing', 'rate_limited', 'timeout', 'unsupported'] as const
type E2EScenario = (typeof E2E_SCENARIOS)[number]

/**
 * Namespaced with the worker's own Redis prefix, so parallel workers cannot read each other's scenario — the
 * same key shape `stripe-provider.ts` uses for `e2e:billing-scenario`.
 */
function e2eScenarioKey(): string {
  const prefix = process.env.E2E_REDIS_PREFIX
  return prefix ? `${prefix}:e2e:claim-proof-scenario` : 'e2e:claim-proof-scenario'
}

function parseScenario(raw: string | null | undefined, source: string): E2EScenario | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if ((E2E_SCENARIOS as readonly string[]).includes(raw)) return raw as E2EScenario
  // `source` is named in the message because the value can arrive from two places, and a failure that does not
  // say which one to correct sends the reader into source code.
  throw new Error(`Unknown ${source} "${raw}" — expected one of: ${E2E_SCENARIOS.join(', ')}`)
}

/**
 * Redis first, environment second — a test that set a scenario for this request means it, and the env var is
 * the run-wide default being overridden. A Redis outage falls back rather than failing: this path only runs
 * under `E2E_MODE`, and a scenario lookup must never itself be why a test errors.
 *
 * Redis rather than only an env var because the app server is a child process spawned before the test began,
 * so it cannot see `process.env` mutations from the runner. Without this, a scenario would be fixed for the
 * life of the server and success and failure could not be exercised in one file — the exact problem
 * `setServerBillingScenario` was added to solve.
 */
async function currentE2EScenario(): Promise<E2EScenario | undefined> {
  try {
    const { getRedis } = await import('../redis')
    const redis = await getRedis()
    const override = await redis?.get(e2eScenarioKey())
    if (override) return parseScenario(override, `${e2eScenarioKey()} (Redis; overrides ${E2E_SCENARIO_ENV_VAR})`)
  } catch (error) {
    // A malformed value is a test-authoring bug and must surface; anything else is an outage, so fall through.
    if (error instanceof Error && error.message.startsWith('Unknown ')) throw error
  }
  return parseScenario(process.env[E2E_SCENARIO_ENV_VAR], E2E_SCENARIO_ENV_VAR)
}

/**
 * Delegates to the real adapter whenever no scenario is in force, so an E2E run that has not opted in still
 * exercises the production code path (and still gets blocked by the egress guard, honestly reporting
 * `not_found`).
 */
function e2eScenarioAdapter(real: ClaimSourceAdapter): ClaimSourceAdapter {
  return {
    async verifyChallenge(username, challenge) {
      const scenario = await currentE2EScenario()
      if (!scenario) return real.verifyChallenge(username, challenge)
      if (scenario === 'success') return { ok: true }
      return { ok: false, reason: scenario }
    },
  }
}

export function getClaimSourceAdapter(source: string): ClaimSourceAdapter | null {
  const adapter = CLAIM_SOURCE_ADAPTERS[source] ?? null
  // Wrapped only for sources that genuinely have an adapter: an unsupported source must keep answering
  // `unsupported`, or the seam would invent proof capability the product does not have.
  if (!adapter) return null
  if (typeof process === 'undefined' || process.env.E2E_MODE !== 'true') return adapter
  return e2eScenarioAdapter(adapter)
}

export function isClaimSourceSupported(source: string): boolean {
  return source in CLAIM_SOURCE_ADAPTERS
}
