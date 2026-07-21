import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { getExecutableConnectors, getRegisteredConnectorIds } from './registry'

const connectorFiles = [
  'src/lib/enrichment/connectors/github.ts',
  'src/lib/enrichment/connectors/user-submitted.ts',
]

describe('connector network boundary', () => {
  it.each(connectorFiles)('%s never calls the global fetch directly', async (path) => {
    const source = await readFile(path, 'utf8')
    // Word-boundary + case-insensitive: matches a bare `fetch(`/`Fetch(` call
    // but not `safeFetch(` (no word boundary between "safe" and "Fetch").
    expect(source).not.toMatch(/\bfetch\(/i)
  })

  it.each(connectorFiles)('%s uses the central safe network client or makes no network call', async (path) => {
    const source = await readFile(path, 'utf8')
    const usesSafeFetch = source.includes('safeFetch')
    const isUserSubmitted = path.includes('user-submitted')
    expect(usesSafeFetch || isUserSubmitted).toBe(true)
  })
})

describe('getRegisteredConnectorIds', () => {
  it('lists exactly the two implemented connectors', () => {
    expect(getRegisteredConnectorIds().sort()).toEqual(['github', 'user-submitted'])
  })
})

describe('getExecutableConnectors', () => {
  it('returns github only when both allowlisted and requested', () => {
    const result = getExecutableConnectors('github', ['github'])
    expect(result.map((c) => c.id)).toEqual(['github'])
  })

  it('never returns github when not requested, even if allowlisted', () => {
    const result = getExecutableConnectors('github', ['user-submitted'])
    expect(result.map((c) => c.id)).toEqual(['user-submitted'])
  })

  it('never returns github when allowlisted string is empty', () => {
    const result = getExecutableConnectors('', ['github', 'user-submitted'])
    expect(result.map((c) => c.id)).toEqual(['user-submitted'])
  })

  it('user-submitted is always executable regardless of the allowlist', () => {
    const result = getExecutableConnectors(undefined, ['user-submitted'])
    expect(result.map((c) => c.id)).toEqual(['user-submitted'])
  })

  it('never returns a hard-blocked connector even if somehow requested', () => {
    const result = getExecutableConnectors('github,linkedin,x', ['github', 'linkedin', 'x'])
    expect(result.map((c) => c.id)).toEqual(['github'])
  })
})
