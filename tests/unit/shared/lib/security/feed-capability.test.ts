import { describe, expect, it } from 'vitest'
import { createFeedCapability, verifyFeedCapability } from '~/shared/lib/security/feed-capability'

const secret = 'test-secret-that-is-long-enough-for-hmac'

describe('feed capabilities', () => {
  it('round-trips organization and search scope', () => {
    const token = createFeedCapability('org-a', 'search-a', secret)
    expect(verifyFeedCapability(token, 'search-a', secret)).toEqual({
      organizationId: 'org-a',
      searchId: 'search-a',
    })
  })

  it('rejects tampering, another route id, and another secret', () => {
    const token = createFeedCapability('org-a', 'search-a', secret)
    expect(verifyFeedCapability(`${token}x`, 'search-a', secret)).toBeNull()
    expect(verifyFeedCapability(token, 'search-b', secret)).toBeNull()
    expect(verifyFeedCapability(token, 'search-a', `${secret}x`)).toBeNull()
  })
})
