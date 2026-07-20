import { describe, expect, it } from 'vitest'
import { cacheKeyFor, canonicalJson, publicSourceCacheKey, tenantAiCacheKey } from './cache'

describe('AI cache tenant boundaries', () => {
  it('never collides across organizations for the same private input', () => {
    expect(tenantAiCacheKey({ organizationId: 'org-a', artifact: 'analysis', input: 'same' }))
      .not.toBe(tenantAiCacheKey({ organizationId: 'org-b', artifact: 'analysis', input: 'same' }))
  })

  it('rejects empty tenant identifiers and separates public-source cache keys', () => {
    expect(() => tenantAiCacheKey({ organizationId: '', artifact: 'analysis', input: 'x' })).toThrow()
    expect(publicSourceCacheKey({ source: 'github', sourceId: '42', input: 'public' })).toMatch(/^ai:public:/)
    expect(tenantAiCacheKey({ organizationId: 'org-a', artifact: 'analysis', input: 'public' })).toMatch(/^ai:tenant:/)
  })
})

describe('canonicalJson', () => {
  it('is key-order invariant, including nested objects', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
    expect(canonicalJson({ outer: { a: 1, b: 2 } })).toBe(canonicalJson({ outer: { b: 2, a: 1 } }))
  })

  it('keeps array order significant', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]))
  })
})

describe('cacheKeyFor', () => {
  it('is stable across calls for the same taskId and input', () => {
    expect(cacheKeyFor('ping', { a: 1 })).toBe(cacheKeyFor('ping', { a: 1 }))
  })

  it('differs across task ids and across inputs', () => {
    expect(cacheKeyFor('ping', { a: 1 })).not.toBe(cacheKeyFor('other-task', { a: 1 }))
    expect(cacheKeyFor('ping', { a: 1 })).not.toBe(cacheKeyFor('ping', { a: 2 }))
  })

  it('starts with the ai:cache: prefix', () => {
    expect(cacheKeyFor('ping', {})).toMatch(/^ai:cache:ping:/)
  })
})
