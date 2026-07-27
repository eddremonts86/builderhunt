import { describe, expect, it } from 'vitest'
import { resolveTenantReadMode } from '~/shared/lib/migration/tenant-flags'

describe('tenant migration flags', () => {
  it('defaults safely to legacy reads', () => {
    expect(resolveTenantReadMode({}, { canonicalReady: false })).toBe('legacy')
  })

  it('folds the retired shadow mode into legacy instead of failing to boot', () => {
    // Shadow returned the legacy rows and only logged a comparison, so an
    // environment still set to it keeps its exact previous behaviour.
    expect(resolveTenantReadMode({ TENANT_READ_MODE: 'shadow' }, { canonicalReady: false })).toBe('legacy')
  })

  it('rejects canonical mode until every readiness artifact is present', () => {
    expect(() => resolveTenantReadMode({ TENANT_READ_MODE: 'canonical' }, { canonicalReady: false }))
      .toThrow('Canonical tenant mode is not ready')
  })

  it('allows canonical mode once readiness is certified', () => {
    expect(resolveTenantReadMode({ TENANT_READ_MODE: 'canonical' }, { canonicalReady: true })).toBe('canonical')
  })

  it('rejects unknown modes instead of silently weakening behavior', () => {
    expect(() => resolveTenantReadMode({ TENANT_READ_MODE: 'on' }, { canonicalReady: true })).toThrow()
  })
})
