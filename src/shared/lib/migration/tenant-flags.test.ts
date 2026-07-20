import { describe, expect, it } from 'vitest'
import { resolveTenantMigrationModes } from './tenant-flags'

describe('tenant migration flags', () => {
  it('defaults safely to legacy reads and writes', () => {
    expect(resolveTenantMigrationModes({}, { canonicalReady: false })).toEqual({
      read: 'legacy',
      write: 'legacy',
    })
  })

  it('allows dual writes and shadow reads before cutover', () => {
    expect(resolveTenantMigrationModes({
      TENANT_WRITE_MODE: 'dual',
      TENANT_READ_MODE: 'shadow',
    }, { canonicalReady: false })).toEqual({ read: 'shadow', write: 'dual' })
  })

  it('rejects canonical mode until every readiness artifact is present', () => {
    expect(() => resolveTenantMigrationModes({ TENANT_READ_MODE: 'canonical' }, { canonicalReady: false }))
      .toThrow('Canonical tenant mode is not ready')
    expect(() => resolveTenantMigrationModes({ TENANT_WRITE_MODE: 'canonical' }, { canonicalReady: false }))
      .toThrow('Canonical tenant mode is not ready')
  })

  it('rejects unknown modes instead of silently weakening behavior', () => {
    expect(() => resolveTenantMigrationModes({ TENANT_READ_MODE: 'on' }, { canonicalReady: true })).toThrow()
  })
})
