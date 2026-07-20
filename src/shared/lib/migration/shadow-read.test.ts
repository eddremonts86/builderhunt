import { describe, expect, it, vi } from 'vitest'
import { executeTenantRead } from './shadow-read'

describe('tenant shadow reads', () => {
  it('returns legacy rows and records only redacted mismatch metadata', async () => {
    const recordMismatch = vi.fn()
    const legacy = [{ id: 'a', name: 'legacy-secret' }, { id: 'b', name: 'same' }]
    const result = await executeTenantRead('shadow', {
      surface: 'saved-queries',
      requestId: 'request-1',
      legacy: async () => legacy,
      canonical: async () => [{ id: 'a', name: 'canonical-secret' }, { id: 'c', name: 'other' }],
      recordMismatch,
    })

    expect(result).toBe(legacy)
    expect(recordMismatch).toHaveBeenCalledWith({
      surface: 'saved-queries',
      requestId: 'request-1',
      legacyCount: 2,
      canonicalCount: 2,
      legacyOnlyIds: ['b'],
      canonicalOnlyIds: ['c'],
      changedIds: ['a'],
    })
    expect(JSON.stringify(recordMismatch.mock.calls)).not.toContain('secret')
  })
})
