import { describe, it, expect } from 'vitest'
import { STARTER_QUERIES, TOTAL_STEPS } from './onboarding'

describe('onboarding constants', () => {
  it('has 5 starter queries', () => {
    expect(STARTER_QUERIES).toHaveLength(5)
  })

  it('all starter queries are non-empty strings', () => {
    for (const q of STARTER_QUERIES) {
      expect(typeof q).toBe('string')
      expect(q.length).toBeGreaterThan(0)
    }
  })

  it('has 3 total steps', () => {
    expect(TOTAL_STEPS).toBe(3)
  })
})
