/**
 * Wave 1 Task 4 — E2E AI-task fake (registry/router boundary)
 * (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md).
 *
 * The seam lives in `src/shared/lib/ai/tasks.ts`: under `E2E_MODE=true`,
 * `E2E_AI_TASK_SCENARIO` drives `isTaskDisabled` (`disabled`) and
 * `getTask` (`unsupported`); `budget_exceeded` is surfaced through
 * `e2eAITaskScenario()` for budget-enforcing callers. This module is the
 * harness-side control surface plus the expected error shapes tests
 * assert against.
 */
import { E2E_AI_TASK_SCENARIOS, resetScenarioEnv, setScenarioEnv, type E2EAITaskScenario } from './_scenarios'

export { E2E_AI_TASK_SCENARIOS }
export type { E2EAITaskScenario }

const ENV_VAR = 'E2E_AI_TASK_SCENARIO'

export function setAITaskScenario(scenario: E2EAITaskScenario): E2EAITaskScenario {
  return setScenarioEnv(ENV_VAR, scenario, E2E_AI_TASK_SCENARIOS, 'setAITaskScenario')
}

export function resetAITaskScenario(): void {
  resetScenarioEnv(ENV_VAR)
}

/**
 * The client-facing failure shape each non-success scenario maps to —
 * mirrors `AIUnavailableError.reason` (`src/shared/lib/ai/errors.ts`) and
 * the HTTP status the `/api/ai/*` routes surface for it.
 */
export function aiTaskScenarioFailureShape(scenario: E2EAITaskScenario): { status: number; reason: string } | null {
  switch (scenario) {
    case 'success':
      return null
    case 'disabled':
      return { status: 503, reason: 'disabled' }
    case 'budget_exceeded':
      return { status: 429, reason: 'budget' }
    case 'unsupported':
      return { status: 404, reason: 'error' }
  }
}
