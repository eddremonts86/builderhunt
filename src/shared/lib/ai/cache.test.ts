import { describe, expect, it } from 'vitest'
import { publicSourceCacheKey, tenantAiCacheKey } from './cache'

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
