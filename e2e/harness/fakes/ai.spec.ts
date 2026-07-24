/**
 * Wave 1 Task 4 — AI-task fake unit tests (Playwright-run, node-only).
 */
import { test, expect } from 'playwright/test'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env' })

import { aiTaskScenarioFailureShape, resetAITaskScenario, setAITaskScenario } from './ai'

const REAL_FLAGS = { AI_DISABLED: 'false' as const, AI_DISABLED_TASKS: '' }

test.afterEach(() => {
  resetAITaskScenario()
})

test('success (and unset) leave the registry untouched', async () => {
  const { getTask, isTaskDisabled } = await import('../../../src/shared/lib/ai/tasks')

  expect(getTask('ping')).not.toBeNull()
  expect(isTaskDisabled('ping', REAL_FLAGS)).toBe(false)

  setAITaskScenario('success')
  expect(getTask('ping')).not.toBeNull()
  expect(isTaskDisabled('ping', REAL_FLAGS)).toBe(false)
  expect(aiTaskScenarioFailureShape('success')).toBeNull()
})

test('disabled simulates the kill switch without touching AI_DISABLED', async () => {
  const { isTaskDisabled } = await import('../../../src/shared/lib/ai/tasks')
  setAITaskScenario('disabled')
  expect(isTaskDisabled('ping', REAL_FLAGS)).toBe(true)
  expect(aiTaskScenarioFailureShape('disabled')).toEqual({ status: 503, reason: 'disabled' })
})

test('unsupported makes every task id unknown to the registry', async () => {
  const { getTask } = await import('../../../src/shared/lib/ai/tasks')
  setAITaskScenario('unsupported')
  expect(getTask('ping')).toBeNull()
  expect(getTask('profile-enrich')).toBeNull()
  expect(aiTaskScenarioFailureShape('unsupported')).toEqual({ status: 404, reason: 'error' })
})

test('budget_exceeded surfaces through e2eAITaskScenario with a 429 shape', async () => {
  const { e2eAITaskScenario, getTask, isTaskDisabled } = await import('../../../src/shared/lib/ai/tasks')
  setAITaskScenario('budget_exceeded')
  expect(e2eAITaskScenario()).toBe('budget_exceeded')
  // The registry itself stays intact — budget enforcement happens upstream.
  expect(getTask('ping')).not.toBeNull()
  expect(isTaskDisabled('ping', REAL_FLAGS)).toBe(false)
  expect(aiTaskScenarioFailureShape('budget_exceeded')).toEqual({ status: 429, reason: 'budget' })
})

test('an unknown env value throws loudly', async () => {
  const { e2eAITaskScenario } = await import('../../../src/shared/lib/ai/tasks')
  process.env.E2E_AI_TASK_SCENARIO = 'nonsense'
  try {
    expect(() => e2eAITaskScenario()).toThrow(/E2E_AI_TASK_SCENARIO/)
  } finally {
    delete process.env.E2E_AI_TASK_SCENARIO
  }
})

test('the seam is inert outside E2E mode', async () => {
  const { e2eAITaskScenario, getTask, isTaskDisabled } = await import('../../../src/shared/lib/ai/tasks')
  const previous = process.env.E2E_MODE
  process.env.E2E_MODE = 'false'
  process.env.E2E_AI_TASK_SCENARIO = 'disabled'
  try {
    expect(e2eAITaskScenario()).toBeNull()
    expect(getTask('ping')).not.toBeNull()
    expect(isTaskDisabled('ping', REAL_FLAGS)).toBe(false)
    expect(() => setAITaskScenario('disabled')).toThrow(/E2E-only/)
  } finally {
    process.env.E2E_MODE = previous
    delete process.env.E2E_AI_TASK_SCENARIO
  }
})
