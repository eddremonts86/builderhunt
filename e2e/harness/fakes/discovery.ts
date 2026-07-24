/**
 * Wave 1 Task 4 — E2E discovery fake (embeddings + enrichment boundaries)
 * (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md).
 *
 * "Discovery" maps to the external AI boundaries that exist today:
 *   - `src/shared/lib/ai/embeddings.ts` — the embedding HTTP endpoint.
 *     Its `embedTexts` short-circuits into a deterministic in-module stub
 *     when `E2E_MODE=true` and `E2E_EMBEDDINGS_SCENARIO` is set.
 *   - `src/shared/lib/ai/enrichment.ts` — the `profile-enrich` task
 *     boundary, stubbed by `e2eEnrichmentStub` under
 *     `E2E_ENRICHMENT_SCENARIO`.
 *
 * This module is the harness-side control surface for those env vars. The
 * stubs run inside whichever process evaluates them — the Playwright
 * runner for in-process calls, or the vite dev server when the env var is
 * exported into `webServer.env` — with zero HTTP either way.
 */
import { E2E_DISCOVERY_SCENARIOS, resetScenarioEnv, setScenarioEnv, type E2EDiscoveryScenario } from './_scenarios'

export { E2E_DISCOVERY_SCENARIOS }
export type { E2EDiscoveryScenario }

const EMBEDDINGS_ENV_VAR = 'E2E_EMBEDDINGS_SCENARIO'
const ENRICHMENT_ENV_VAR = 'E2E_ENRICHMENT_SCENARIO'

export function setEmbeddingsScenario(scenario: E2EDiscoveryScenario): E2EDiscoveryScenario {
  return setScenarioEnv(EMBEDDINGS_ENV_VAR, scenario, E2E_DISCOVERY_SCENARIOS, 'setEmbeddingsScenario')
}

export function resetEmbeddingsScenario(): void {
  resetScenarioEnv(EMBEDDINGS_ENV_VAR)
}

export function setEnrichmentScenario(scenario: E2EDiscoveryScenario): E2EDiscoveryScenario {
  return setScenarioEnv(ENRICHMENT_ENV_VAR, scenario, E2E_DISCOVERY_SCENARIOS, 'setEnrichmentScenario')
}

export function resetEnrichmentScenario(): void {
  resetScenarioEnv(ENRICHMENT_ENV_VAR)
}

/** Per-worker reset: both discovery boundaries back to their real code paths. */
export function resetDiscoveryFakes(): void {
  resetEmbeddingsScenario()
  resetEnrichmentScenario()
}
