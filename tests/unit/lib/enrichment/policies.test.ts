import { describe, expect, it } from 'vitest'
import { getSourcePolicy, HARD_BLOCKED_CONNECTOR_IDS, resolveExecutableConnectorIds, SOURCE_POLICIES } from '~/lib/enrichment/policies'

describe('getSourcePolicy', () => {
  it('returns null for a connector with no policy entry', () => {
    expect(getSourcePolicy('some-unregistered-connector')).toBeNull()
    expect(getSourcePolicy('reddit')).toBeNull()
    expect(getSourcePolicy('tiktok')).toBeNull()
  })

  it('every hard-blocked connector has a blocked (never enabled) policy', () => {
    for (const id of HARD_BLOCKED_CONNECTOR_IDS) {
      const policy = getSourcePolicy(id)
      expect(policy).not.toBeNull()
      expect(policy?.status).toBe('blocked')
    }
  })
})

describe('resolveExecutableConnectorIds', () => {
  const NOW = new Date('2026-07-20T00:00:00Z')

  it('returns nothing when the allowlist is empty or unset', () => {
    expect(resolveExecutableConnectorIds(undefined, NOW)).toEqual([])
    expect(resolveExecutableConnectorIds('', NOW)).toEqual([])
    expect(resolveExecutableConnectorIds('   ', NOW)).toEqual([])
  })

  it('narrows to only compile-time enabled connectors', () => {
    expect(resolveExecutableConnectorIds('github', NOW)).toEqual(['github'])
  })

  it('never returns a hard-blocked provider even if present in the allowlist', () => {
    const result = resolveExecutableConnectorIds('github,linkedin,x,facebook,instagram', NOW)
    expect(result).toEqual(['github'])
  })

  it('is case-insensitive and ignores a malformed allowlist (stray commas/whitespace)', () => {
    expect(resolveExecutableConnectorIds(' GitHub ,, ,LINKEDIN,', NOW)).toEqual(['github'])
  })

  it('collapses duplicate connector IDs', () => {
    expect(resolveExecutableConnectorIds('github,github,GITHUB', NOW)).toEqual(['github'])
  })

  it('ignores unknown connector IDs', () => {
    expect(resolveExecutableConnectorIds('github,not-a-real-source,tiktok', NOW)).toEqual(['github'])
  })

  it('excludes a connector whose review has expired', () => {
    const farFuture = new Date('2028-01-01T00:00:00Z')
    expect(resolveExecutableConnectorIds('github', farFuture)).toEqual([])
  })
})

describe('SOURCE_POLICIES invariants', () => {
  it('every policy has a stable id matching its registry key', () => {
    for (const [key, policy] of Object.entries(SOURCE_POLICIES)) {
      expect(policy.id).toBe(key)
    }
  })

  it('a blocked policy carries no lawful-basis or approved fields', () => {
    for (const policy of Object.values(SOURCE_POLICIES)) {
      if (policy.status !== 'blocked') continue
      expect(policy.lawfulBasisReference).toBe('none — blocked')
      expect(policy.allowedFields).toHaveLength(0)
    }
  })
})
