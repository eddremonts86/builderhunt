import { describe, expect, it } from 'vitest'
import { assertRestoreTestTargets } from '~/shared/lib/db/restore-policy'

describe('restore rehearsal target policy', () => {
  it('accepts two distinct explicitly named test databases', () => {
    expect(() => assertRestoreTestTargets(
      'postgresql://user:secret@db:5432/builderhunt_security_test_source',
      'postgresql://user:secret@db:5432/builderhunt_security_test_restore',
    )).not.toThrow()
  })

  it.each([
    ['postgresql://user:secret@db:5432/builderhunt', 'postgresql://user:secret@db:5432/builderhunt_security_test_restore'],
    ['postgresql://user:secret@db:5432/builderhunt_security_test_source', 'postgresql://user:secret@db:5432/production'],
    ['postgresql://user:secret@db:5432/builderhunt_security_test_same', 'postgresql://user:secret@db:5432/builderhunt_security_test_same'],
  ])('rejects unsafe restore pair', (source, target) => {
    expect(() => assertRestoreTestTargets(source, target)).toThrow()
  })
})
