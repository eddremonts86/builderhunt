import { describe, expect, it, vi } from 'vitest'
import type { TenantPrincipal } from '../authorization/permissions'
import { createTenantContextRunner } from './tenant-context'

const principal = (organizationId: string): TenantPrincipal => ({
  userId: `user-${organizationId}`,
  organizationId,
  role: 'member',
  requestId: `request-${organizationId}`,
})

function fakeDatabase() {
  const tx = { execute: vi.fn().mockResolvedValue(undefined) }
  return {
    tx,
    database: {
      transaction: vi.fn(async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx)),
    },
  }
}

describe('tenant context', () => {
  it('sets all tenant values inside one transaction before running product code', async () => {
    const { database, tx } = fakeDatabase()
    const runner = createTenantContextRunner(database)
    const operation = vi.fn().mockResolvedValue('ok')

    await expect(runner.withTenantContext(principal('org-a'), operation)).resolves.toBe('ok')
    expect(database.transaction).toHaveBeenCalledOnce()
    expect(tx.execute).toHaveBeenCalledOnce()
    expect(operation).toHaveBeenCalledWith(tx)
    expect(tx.execute.mock.invocationCallOrder[0]).toBeLessThan(operation.mock.invocationCallOrder[0])
  })

  it('reuses a same-tenant nested context but rejects a different tenant', async () => {
    const { database, tx } = fakeDatabase()
    const runner = createTenantContextRunner(database)

    await runner.withTenantContext(principal('org-a'), async (outerTx) => {
      await expect(runner.withTenantContext(principal('org-a'), async (innerTx) => innerTx)).resolves.toBe(tx)
      await expect(runner.withTenantContext(principal('org-b'), async () => undefined))
        .rejects.toThrow('Cannot change organization inside an active tenant context')
      expect(outerTx).toBe(tx)
    })

    expect(database.transaction).toHaveBeenCalledOnce()
  })

  it('does not retain context after commit or rollback', async () => {
    const { database } = fakeDatabase()
    const runner = createTenantContextRunner(database)

    await runner.withTenantContext(principal('org-a'), async () => undefined)
    await expect(runner.withTenantContext(principal('org-b'), async () => undefined)).resolves.toBeUndefined()
    await expect(runner.withTenantContext(principal('org-a'), async () => { throw new Error('rollback') }))
      .rejects.toThrow('rollback')
    await expect(runner.withTenantContext(principal('org-b'), async () => undefined)).resolves.toBeUndefined()
  })
})
