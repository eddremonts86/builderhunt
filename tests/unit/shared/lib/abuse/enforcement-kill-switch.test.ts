import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers } from '~/shared/lib/db/schema'

/**
 * CI release-gate kill-switch smoke (abuse-and-usage-integrity Phase 6 task 3). `enforcement.test.ts`
 * already proves the pure `resolveEnforcement(mode, candidate)` function is a total override in
 * `observe` mode — but every real caller (`requireTenantPrincipal`'s `getEnforcementStage` wiring)
 * calls `resolveEnforcementForUser(userId)` with NO `mode` override at all, relying entirely on
 * `env.ABUSE_ENFORCEMENT_MODE`'s default. This test proves that actual default-wiring path end to
 * end against a REAL database row, not just the pure function with a literal argument: seed a real
 * `account_risk` row at the worst possible stage (`blocked`), mock `env.ABUSE_ENFORCEMENT_MODE` to
 * `'observe'`, and confirm the production entry point still resolves to `observe` — proving the
 * kill switch actually disables enforcement for a real flagged account, not just in the abstract.
 */
const mockEnv = vi.hoisted(() => ({ ABUSE_ENFORCEMENT_MODE: 'observe' as 'observe' | 'warn' | 'enforce' }))
vi.mock('~/shared/lib/env', () => ({ env: mockEnv }))

const { resolveEnforcementForUser } = await import('~/shared/lib/abuse/enforcement')
const { getAccountRisk, upsertAccountRisk, withWorkerUser } = await import('~/shared/lib/repositories/account-risk')

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('abuse_kill_switch')
  db = disposable.db
  drop = disposable.drop

  await db.insert(authUsers).values({
    id: 'kill-switch-user', name: 'Kill Switch', email: 'kill-switch@test.invalid',
    emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
  await withWorkerUser('kill-switch-user', (tx) => upsertAccountRisk(tx, {
    userId: 'kill-switch-user', riskScore: 95, stage: 'blocked', reason: 'kill-switch fixture: worst real stage',
  }), db)
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('ABUSE_ENFORCEMENT_MODE=observe kill switch', () => {
  it('fully disables enforcement for a real, already-blocked account when no mode override is passed — the exact production default path', async () => {
    mockEnv.ABUSE_ENFORCEMENT_MODE = 'observe'
    const decision = await resolveEnforcementForUser('kill-switch-user', {
      withWorkerUser: (userId, operation) => withWorkerUser(userId, operation, db),
      getAccountRisk,
    })
    expect(decision.stage).toBe('observe')
  })

  it('short-circuits before ever reading the real account_risk row — the kill switch removes the read, not just the decision', async () => {
    mockEnv.ABUSE_ENFORCEMENT_MODE = 'observe'
    let queried = false
    const decision = await resolveEnforcementForUser('kill-switch-user', {
      withWorkerUser: (userId, operation) => {
        queried = true
        return withWorkerUser(userId, operation, db)
      },
      getAccountRisk: (...args) => {
        queried = true
        return getAccountRisk(...args)
      },
    })
    expect(decision.stage).toBe('observe')
    expect(queried).toBe(false)
  })

  it('sanity check: the exact same real blocked row DOES resolve to blocked once the switch is flipped back to enforce — proves the fixture is real, not a tautology', async () => {
    mockEnv.ABUSE_ENFORCEMENT_MODE = 'enforce'
    const decision = await resolveEnforcementForUser('kill-switch-user', {
      withWorkerUser: (userId, operation) => withWorkerUser(userId, operation, db),
      getAccountRisk,
    })
    expect(decision.stage).toBe('blocked')
  })
})
