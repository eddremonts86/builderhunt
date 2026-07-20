import { describe, expect, it } from 'vitest'
import { buildEmbeddingDoc, contentHashOf, toEmbeddedProfile, embeddedProfileSchema } from './embedding-doc'

const FULL_PROFILE = {
  username: 'octocat',
  displayName: 'The Octocat',
  avatarUrl: 'https://example.com/a.png',
  bio: 'Building open source tools',
  profileUrl: 'https://github.com/octocat',
  source: 'github',
  sourceId: '583231',
  followersCount: 4200,
  language: 'TypeScript',
  country: 'US',
  topics: ['rust', 'async'],
}

describe('buildEmbeddingDoc', () => {
  it('renders every populated field in the canonical template', () => {
    const doc = buildEmbeddingDoc(FULL_PROFILE)
    expect(doc).toBe(
      'Name: The Octocat (@octocat)\n'
      + 'Source: github\n'
      + 'Bio: Building open source tools\n'
      + 'Language: TypeScript\n'
      + 'Country: US\n'
      + 'Topics: rust, async\n'
      + 'Followers: 4200',
    )
  })

  it('omits empty/missing fields', () => {
    const doc = buildEmbeddingDoc({
      username: 'jdoe',
      profileUrl: 'https://github.com/jdoe',
      source: 'github',
      sourceId: 'jdoe',
    })
    expect(doc).toBe('Name: jdoe (@jdoe)\nSource: github')
  })

  it('falls back to username when displayName is blank', () => {
    const doc = buildEmbeddingDoc({ ...FULL_PROFILE, displayName: '   ' })
    expect(doc.startsWith('Name: octocat (@octocat)')).toBe(true)
  })

  it('truncates to 6000 chars', () => {
    const doc = buildEmbeddingDoc({
      username: 'jdoe',
      profileUrl: 'https://github.com/jdoe',
      source: 'github',
      sourceId: 'jdoe',
      bio: 'x'.repeat(10_000),
    })
    expect(doc.length).toBe(6000)
  })
})

describe('contentHashOf', () => {
  it('is deterministic for identical content', () => {
    const doc = buildEmbeddingDoc(FULL_PROFILE)
    expect(contentHashOf(doc)).toBe(contentHashOf(doc))
  })

  it('changes when the content changes', () => {
    const a = contentHashOf(buildEmbeddingDoc(FULL_PROFILE))
    const b = contentHashOf(buildEmbeddingDoc({ ...FULL_PROFILE, bio: 'A different bio' }))
    expect(a).not.toBe(b)
  })

  it('is a 64-char hex sha256 digest', () => {
    const hash = contentHashOf('anything')
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('toEmbeddedProfile', () => {
  it('projects to the minimal display payload and validates against the schema', () => {
    const profile = toEmbeddedProfile(FULL_PROFILE)
    expect(embeddedProfileSchema.safeParse(profile).success).toBe(true)
    expect(profile).toEqual({
      username: 'octocat',
      displayName: 'The Octocat',
      avatarUrl: 'https://example.com/a.png',
      bio: 'Building open source tools',
      profileUrl: 'https://github.com/octocat',
      followersCount: 4200,
      language: 'TypeScript',
      country: 'US',
      topics: ['rust', 'async'],
    })
  })

  it('handles null/undefined optional fields, defaulting topics to []', () => {
    const profile = toEmbeddedProfile({
      username: 'jdoe',
      profileUrl: 'https://github.com/jdoe',
      source: 'github',
      sourceId: 'jdoe',
      displayName: null,
      avatarUrl: null,
      bio: null,
      followersCount: null,
      language: null,
      country: null,
      topics: null,
    })
    expect(profile).toEqual({
      username: 'jdoe',
      profileUrl: 'https://github.com/jdoe',
      topics: [],
    })
  })
})
