import { describe, expect, it } from 'vitest'
import { toPublicBuilderDto } from './public-builder-dto'

describe('public builder DTO', () => {
  it('returns only reviewed identity and opt-in publication fields', () => {
    const dto = toPublicBuilderDto({
      id: 'identity-a',
      source: 'github',
      sourceId: '42',
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: 'https://example.test/a.png',
      profileUrl: 'https://github.com/alice',
      bio: 'Published bio',
      openToStatus: ['work'],
      publishedAt: new Date('2026-07-20T00:00:00Z'),
      organizationId: 'org-secret',
      creatorUserId: 'user-secret',
      metadata: { privateScore: 99 },
      notes: 'secret',
    })

    expect(dto).toEqual({
      id: 'identity-a',
      source: 'github',
      sourceId: '42',
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: 'https://example.test/a.png',
      profileUrl: 'https://github.com/alice',
      bio: 'Published bio',
      openToStatus: ['work'],
      publishedAt: '2026-07-20T00:00:00.000Z',
    })
    expect(JSON.stringify(dto)).not.toMatch(/org-secret|user-secret|privateScore|secret/)
  })

  it('does not construct a public DTO without explicit publication', () => {
    expect(() => toPublicBuilderDto({
      id: 'identity-a',
      source: 'github',
      sourceId: '42',
      username: 'alice',
      displayName: null,
      avatarUrl: null,
      profileUrl: 'https://github.com/alice',
      bio: null,
      openToStatus: [],
      publishedAt: null,
    })).toThrow('Builder profile is not published')
  })
})
