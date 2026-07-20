import { describe, expect, it, vi } from 'vitest'
import { executeTenantWrite } from './dual-write'

describe('tenant dual write', () => {
  it('runs legacy then canonical with one idempotency key in dual mode', async () => {
    const calls: string[] = []
    const result = await executeTenantWrite('dual', {
      idempotencyKey: 'request:resource',
      legacy: async (key) => { calls.push(`legacy:${key}`); return 'legacy-result' },
      canonical: async (key) => { calls.push(`canonical:${key}`); return 'canonical-result' },
    })
    expect(calls).toEqual(['legacy:request:resource', 'canonical:request:resource'])
    expect(result).toBe('legacy-result')
  })

  it('surfaces canonical failure so the caller transaction can roll back both writes', async () => {
    const legacy = vi.fn().mockResolvedValue('legacy-result')
    await expect(executeTenantWrite('dual', {
      idempotencyKey: 'same-key',
      legacy,
      canonical: async () => { throw new Error('canonical failed') },
    })).rejects.toThrow('canonical failed')
    expect(legacy).toHaveBeenCalledOnce()
  })
})
