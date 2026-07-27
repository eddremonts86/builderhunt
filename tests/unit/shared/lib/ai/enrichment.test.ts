import { describe, expect, it } from 'vitest'
import {
  buildEnrichInput,
  hasEnrichableContent,
  isEnrichmentFresh,
} from '~/shared/lib/ai/enrichment'

describe('hasEnrichableContent', () => {
  it('passes when bio alone reaches the 40-char threshold', () => {
    expect(hasEnrichableContent({ bio: 'a'.repeat(40), topics: [], highlights: [] })).toBe(true)
  })

  it('fails at 39 chars, passes at 40', () => {
    expect(hasEnrichableContent({ bio: 'a'.repeat(39), topics: [], highlights: [] })).toBe(false)
    expect(hasEnrichableContent({ bio: 'a'.repeat(40), topics: [], highlights: [] })).toBe(true)
  })

  it('passes when topics alone reach 3', () => {
    expect(hasEnrichableContent({ bio: null, topics: ['rust', 'go'], highlights: [] })).toBe(false)
    expect(hasEnrichableContent({ bio: null, topics: ['rust', 'go', 'wasm'], highlights: [] })).toBe(true)
  })

  it('passes when highlights alone reach 2', () => {
    expect(hasEnrichableContent({ bio: null, topics: [], highlights: ['repo one'] })).toBe(false)
    expect(hasEnrichableContent({ bio: null, topics: [], highlights: ['repo one', 'repo two'] })).toBe(true)
  })

  it('fails when everything is empty', () => {
    expect(hasEnrichableContent({ bio: null, topics: [], highlights: [] })).toBe(false)
    expect(hasEnrichableContent({ bio: '   ', topics: ['', ' '], highlights: [''] })).toBe(false)
  })
})

describe('buildEnrichInput', () => {
  it('extracts highlights from a GitHub-shaped metadata blob (repos array of objects)', () => {
    const input = buildEnrichInput({
      username: 'alice',
      source: 'github',
      metadata: {
        repos: [
          { name: 'fast-parser', description: 'A zero-copy parser combinator library' },
          { name: 'tiny-router' },
        ],
      },
    })
    expect(input.highlights).toEqual([
      'fast-parser: A zero-copy parser combinator library',
      'tiny-router',
    ])
  })

  it('extracts highlights from a dev.to-shaped metadata blob (posts array of strings)', () => {
    const input = buildEnrichInput({
      username: 'bob',
      source: 'devto',
      metadata: { posts: ['Why I switched to Rust', 'Building a CLI in a weekend'] },
    })
    expect(input.highlights).toEqual(['Why I switched to Rust', 'Building a CLI in a weekend'])
  })

  it('survives an empty metadata object', () => {
    const input = buildEnrichInput({ username: 'carol', source: 'hn', metadata: {} })
    expect(input.highlights).toEqual([])
  })

  it('survives malformed/unexpected metadata shapes without throwing', () => {
    expect(() => buildEnrichInput({ username: 'dave', source: 'github', metadata: null })).not.toThrow()
    expect(() => buildEnrichInput({ username: 'dave', source: 'github', metadata: 'not an object' })).not.toThrow()
    expect(() => buildEnrichInput({ username: 'dave', source: 'github', metadata: { repos: 'not an array' } })).not.toThrow()
    expect(() => buildEnrichInput({ username: 'dave', source: 'github', metadata: { repos: [42, null, {}] } })).not.toThrow()
  })

  it('caps highlights at 12 and topics at 30', () => {
    const manyPosts = Array.from({ length: 20 }, (_, i) => `post ${i}`)
    const input = buildEnrichInput({
      username: 'eve',
      source: 'devto',
      topics: Array.from({ length: 40 }, (_, i) => `topic-${i}`),
      metadata: { posts: manyPosts },
    })
    expect(input.highlights.length).toBe(12)
    expect(input.topics.length).toBe(30)
  })
})

describe('isEnrichmentFresh', () => {
  const validBase = {
    summary: 'Builds fast, well-tested backend services with a focus on developer experience.',
    estimatedSeniority: 'senior' as const,
    primaryFocus: 'Distributed systems',
    strengths: ['Rust', 'Systems design'],
    codingStyle: 'Small modules, test-first',
    model: 'MiniMax-M3',
    version: 1 as const,
  }

  it('accepts a fresh, schema-valid, version-1 artifact', () => {
    expect(isEnrichmentFresh({ ...validBase, enrichedAt: new Date().toISOString() })).toBe(true)
  })

  it('rejects a stale artifact (31 days old)', () => {
    const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    expect(isEnrichmentFresh({ ...validBase, enrichedAt: staleDate })).toBe(false)
  })

  it('rejects the wrong artifact version', () => {
    expect(isEnrichmentFresh({ ...validBase, enrichedAt: new Date().toISOString(), version: 2 })).toBe(false)
  })

  it('rejects a schema-invalid blob', () => {
    expect(isEnrichmentFresh({ foo: 'bar' })).toBe(false)
    expect(isEnrichmentFresh(null)).toBe(false)
    expect(isEnrichmentFresh({ ...validBase, enrichedAt: 'not-a-date' })).toBe(false)
  })
})
