import { describe, expect, it } from 'vitest'
import { normalizeFullName, normalizeLocation, normalizeOrganization, normalizeTopic, normalizeUrl, normalizeUsername } from '~/lib/enrichment/normalize'

describe('normalizeUsername', () => {
  it.each([
    ['@octocat', 'octocat'],
    ['  OctoCat  ', 'octocat'],
    ['octocat', 'octocat'],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeUsername(input as string | null)).toBe(expected)
  })

  it('never fuzzy-matches — only exact normalized equality is used by the resolver', () => {
    expect(normalizeUsername('oct')).not.toBe(normalizeUsername('octocat'))
  })

  it('is idempotent', () => {
    const once = normalizeUsername('@Foo Bar')
    expect(normalizeUsername(once)).toBe(once)
  })
})

describe('normalizeFullName', () => {
  it('handles Unicode NFKC + case + whitespace', () => {
    expect(normalizeFullName('  Ａda   Lovelace ')).toBe(normalizeFullName('ada lovelace'))
  })
})

describe('normalizeUrl', () => {
  it('lowercases the host and strips tracking params', () => {
    expect(normalizeUrl('https://GitHub.com/octocat?utm_source=x&ref=y&tab=repositories'))
      .toBe('https://github.com/octocat?tab=repositories')
  })

  it('strips trailing slash and fragment', () => {
    expect(normalizeUrl('https://github.com/octocat/#readme')).toBe('https://github.com/octocat')
  })

  it('is idempotent', () => {
    const once = normalizeUrl('https://GitHub.com/octocat?utm_source=x')
    expect(normalizeUrl(once)).toBe(once)
  })

  it('returns empty string for an invalid URL', () => {
    expect(normalizeUrl('not a url')).toBe('')
    expect(normalizeUrl(null)).toBe('')
  })
})

describe('normalizeOrganization', () => {
  it.each([
    ['Acme Inc.', 'acme inc'],
    ['Acme Incorporated', 'acme inc'],
    ['Acme, LLC', 'acme llc'],
    ['Acme Ltd.', 'acme ltd'],
    ['Acme GmbH', 'acme gmbh'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeOrganization(input)).toBe(expected)
  })

  it('treats equivalent legal-suffix spellings as equal', () => {
    expect(normalizeOrganization('Acme Inc.')).toBe(normalizeOrganization('Acme Incorporated'))
  })
})

describe('normalizeLocation', () => {
  it('compares coarse text only, never geocodes', () => {
    expect(normalizeLocation('Berlin, Germany')).toBe(normalizeLocation('berlin germany'))
  })
})

describe('normalizeTopic', () => {
  it('lowercases and trims', () => {
    expect(normalizeTopic('  WebGL  ')).toBe('webgl')
  })
})
