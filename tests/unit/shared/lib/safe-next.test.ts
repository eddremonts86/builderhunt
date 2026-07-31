import { describe, expect, it } from 'vitest'
import { DEFAULT_BUILDER_FROM, parseSafeBuilderFrom, parseSafeNext, resolveSafeBuilderFrom } from '~/shared/lib/safe-next'

describe('parseSafeNext', () => {
  it('accepts a bare /search path', () => {
    expect(parseSafeNext('/search')).toBe('/search')
  })

  it('accepts /search with a query string', () => {
    expect(parseSafeNext('/search?q=rust')).toBe('/search?q=rust')
  })

  it('preserves multiple query params', () => {
    expect(parseSafeNext('/search?q=rust&sources=github,gitlab')).toBe('/search?q=rust&sources=github,gitlab')
  })

  it('returns null for undefined/null/empty', () => {
    expect(parseSafeNext(undefined)).toBeNull()
    expect(parseSafeNext(null)).toBeNull()
    expect(parseSafeNext('')).toBeNull()
  })

  it('rejects an absolute URL', () => {
    expect(parseSafeNext('https://evil.com/search')).toBeNull()
  })

  it('rejects a protocol-relative URL', () => {
    expect(parseSafeNext('//evil.com/search')).toBeNull()
  })

  it('rejects a javascript: URL', () => {
    expect(parseSafeNext('javascript:alert(1)')).toBeNull()
  })

  it('rejects a path that is not exactly /search', () => {
    expect(parseSafeNext('/dashboard')).toBeNull()
    expect(parseSafeNext('/search/extra')).toBeNull()
    expect(parseSafeNext('/searchx')).toBeNull()
  })

  it('rejects a path traversal attempt', () => {
    expect(parseSafeNext('/search/../admin')).toBeNull()
  })

  it('rejects an encoded protocol-relative bypass attempt', () => {
    expect(parseSafeNext('/%2F%2Fevil.com')).toBeNull()
  })

  it('rejects a backslash bypass attempt', () => {
    expect(parseSafeNext('\\\\evil.com/search')).toBeNull()
  })
})

describe('parseSafeBuilderFrom', () => {
  it.each([
    ['/search', '/search'],
    ['/search?q=rust', '/search?q=rust'],
    ['/alerts', '/alerts'],
    ['/sprints/abc123', '/sprints/abc123'],
    ['/lists/list-1', '/lists/list-1'],
  ])('accepts %s', (input, expected) => {
    expect(parseSafeBuilderFrom(input)).toBe(expected)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['an absolute URL', 'https://evil.com/search'],
    ['a protocol-relative URL', '//evil.com/search'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a backslash bypass attempt', '\\\\evil.com/search'],
    ['an encoded protocol-relative bypass attempt', '/%2F%2Fevil.com'],
    ['a browser-visible dashboard route id', '/_dashboard/lists'],
    ['a bare /sprints with no id', '/sprints/'],
    ['a bare /lists with no id', '/lists/'],
    ['an unrelated dashboard path', '/settings/billing'],
  ])('rejects %s', (_label, input) => {
    expect(parseSafeBuilderFrom(input)).toBeNull()
  })
})

describe('resolveSafeBuilderFrom', () => {
  it('round-trips a valid origin', () => {
    expect(resolveSafeBuilderFrom('/sprints/abc123')).toBe('/sprints/abc123')
  })

  it('falls back to the default for an unsafe value', () => {
    expect(resolveSafeBuilderFrom('https://evil.com')).toBe(DEFAULT_BUILDER_FROM)
    expect(resolveSafeBuilderFrom(null)).toBe(DEFAULT_BUILDER_FROM)
  })
})
