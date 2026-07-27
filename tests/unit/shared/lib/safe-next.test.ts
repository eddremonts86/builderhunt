import { describe, expect, it } from 'vitest'
import { parseSafeNext } from '~/shared/lib/safe-next'

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
