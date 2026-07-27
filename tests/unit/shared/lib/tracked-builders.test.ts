import { describe, it, expect } from 'vitest'
import { trackedKey } from '~/shared/lib/tracked-builders'

describe('trackedKey', () => {
  it('joins source and sourceId with a colon', () => {
    expect(trackedKey('github', '12345')).toBe('github:12345')
  })

  it('produces different keys for different sources with the same sourceId', () => {
    expect(trackedKey('github', '1')).not.toBe(trackedKey('reddit', '1'))
  })
})
