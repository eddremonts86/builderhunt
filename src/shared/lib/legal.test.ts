import { describe, it, expect } from 'vitest'
import {
  CURRENT_CONSENT_VERSIONS,
  GRACE_PERIOD_MS,
  EXPORT_TTL_MS,
  type ConsentDocument,
} from './legal'

describe('legal constants', () => {
  it('has current versions for all required documents', () => {
    expect(CURRENT_CONSENT_VERSIONS.tos).toBe('v1.0')
    expect(CURRENT_CONSENT_VERSIONS.privacy).toBe('v1.0')
    expect(CURRENT_CONSENT_VERSIONS.cookies).toBe('v1.0')
  })

  it('grace period is exactly 30 days in ms', () => {
    const thirtyDays = 30 * 24 * 60 * 60 * 1000
    expect(GRACE_PERIOD_MS).toBe(thirtyDays)
  })

  it('export TTL is exactly 7 days in ms', () => {
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    expect(EXPORT_TTL_MS).toBe(sevenDays)
  })

  it('ConsentDocument union covers tos/privacy/cookies', () => {
    const docs: ConsentDocument[] = ['tos', 'privacy', 'cookies']
    expect(docs).toHaveLength(3)
  })
})
