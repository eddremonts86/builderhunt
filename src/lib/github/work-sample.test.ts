import { describe, expect, it } from 'vitest'
import { computeContentHash, parseSampleUrl } from './work-sample'

describe('parseSampleUrl', () => {
  it('parses a repo URL', () => {
    expect(parseSampleUrl('https://github.com/facebook/react')).toEqual({
      type: 'repo', owner: 'facebook', repo: 'react',
    })
  })

  it('parses a repo URL with a trailing slash', () => {
    expect(parseSampleUrl('https://github.com/facebook/react/')).toEqual({
      type: 'repo', owner: 'facebook', repo: 'react',
    })
  })

  it('parses a pull request URL', () => {
    expect(parseSampleUrl('https://github.com/facebook/react/pull/142')).toEqual({
      type: 'pr', owner: 'facebook', repo: 'react', number: 142,
    })
  })

  it('parses a pull request URL with a trailing slash', () => {
    expect(parseSampleUrl('https://github.com/facebook/react/pull/142/')).toEqual({
      type: 'pr', owner: 'facebook', repo: 'react', number: 142,
    })
  })

  it('parses a blob (file) URL', () => {
    expect(parseSampleUrl('https://github.com/facebook/react/blob/main/README.md')).toEqual({
      type: 'file', owner: 'facebook', repo: 'react', ref: 'main', path: 'README.md',
    })
  })

  it('parses a blob URL with a nested path', () => {
    expect(parseSampleUrl('https://github.com/facebook/react/blob/main/packages/react/src/React.js')).toEqual({
      type: 'file', owner: 'facebook', repo: 'react', ref: 'main', path: 'packages/react/src/React.js',
    })
  })

  it('ignores query strings on repo URLs', () => {
    expect(parseSampleUrl('https://github.com/facebook/react?tab=readme')).toEqual({
      type: 'repo', owner: 'facebook', repo: 'react',
    })
  })

  it('accepts www.github.com', () => {
    expect(parseSampleUrl('https://www.github.com/facebook/react')).toEqual({
      type: 'repo', owner: 'facebook', repo: 'react',
    })
  })

  it('rejects non-GitHub hosts', () => {
    expect(parseSampleUrl('https://gitlab.com/facebook/react')).toBeNull()
  })

  it('rejects gist URLs', () => {
    expect(parseSampleUrl('https://gist.github.com/user/abc123')).toBeNull()
  })

  it('rejects wiki URLs', () => {
    expect(parseSampleUrl('https://github.com/facebook/react/wiki/Home')).toBeNull()
  })

  it('rejects a bare github.com root', () => {
    expect(parseSampleUrl('https://github.com/')).toBeNull()
  })

  it('rejects a malicious javascript: scheme', () => {
    expect(parseSampleUrl('javascript:alert(1)')).toBeNull()
  })

  it('rejects a malicious data: scheme', () => {
    expect(parseSampleUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
  })

  it('rejects malformed input', () => {
    expect(parseSampleUrl('not a url at all')).toBeNull()
  })

  it('rejects an empty string', () => {
    expect(parseSampleUrl('')).toBeNull()
  })

  it('rejects a non-numeric PR number', () => {
    expect(parseSampleUrl('https://github.com/facebook/react/pull/abc')).toBeNull()
  })
})

describe('computeContentHash', () => {
  it('is deterministic for identical content', () => {
    const content = {
      readme: 'hello', files: [], diff: null, prTitle: null, prBody: null,
      stats: { totalFiles: 1, analyzedFiles: 1, truncated: false },
    }
    expect(computeContentHash(content)).toBe(computeContentHash({ ...content }))
  })

  it('differs when content differs', () => {
    const base = {
      readme: 'hello', files: [], diff: null, prTitle: null, prBody: null,
      stats: { totalFiles: 1, analyzedFiles: 1, truncated: false },
    }
    expect(computeContentHash(base)).not.toBe(computeContentHash({ ...base, readme: 'goodbye' }))
  })
})
