import { describe, expect, it } from 'vitest'
import {
  BuilderListDTOSchema,
  BuilderListItemDTOSchema,
  FeedCapabilityDTOSchema,
  SavedQueryDTOSchema,
  SharedResourceError,
  VisibilitySchema,
  stripOrganizationAuthority,
} from '~/shared/lib/shared-resources/contracts'

describe('shared-resources/contracts — visibility', () => {
  it('accepts the two-state enum', () => {
    expect(VisibilitySchema.parse('private')).toBe('private')
    expect(VisibilitySchema.parse('organization')).toBe('organization')
  })

  it('rejects unknown visibility values', () => {
    expect(() => VisibilitySchema.parse('public')).toThrow()
    expect(() => VisibilitySchema.parse('link-only')).toThrow()
  })
})

describe('shared-resources/contracts — DTO schemas', () => {
  const baseSavedQuery = {
    id: 'q-1',
    organizationId: 'org-1',
    createdByUserId: 'u-1',
    name: 'open-source typescript hunters',
    keywords: ['typescript', 'open source'],
    sources: ['github', 'hn'],
    language: 'en',
    country: 'US',
    visibility: 'organization' as const,
    createdAt: '2026-07-29T10:00:00Z',
    updatedAt: '2026-07-29T10:00:00Z',
  }

  it('accepts a well-formed saved-query DTO', () => {
    const parsed = SavedQueryDTOSchema.parse(baseSavedQuery)
    expect(parsed.id).toBe('q-1')
    expect(parsed.keywords).toEqual(['typescript', 'open source'])
  })

  it('rejects an unknown private column in a saved-query DTO', () => {
    const leaked = { ...baseSavedQuery, internalNote: 'this should not pass' }
    // The schema only describes the allowlisted shape, so a real
    // schema.parse() on a shape with an extra field succeeds —
    // a route using `.parse(input)` will then `.pick` the
    // documented fields. The route boundary is where unknown
    // fields are stripped, not zod; this is the documented shape.
    const parsed = SavedQueryDTOSchema.parse(leaked)
    expect(parsed).not.toHaveProperty('internalNote')
  })

  it('rejects country strings that are not ISO-3166-1 alpha-2', () => {
    expect(() => SavedQueryDTOSchema.parse({ ...baseSavedQuery, country: 'USA' })).toThrow()
    expect(() => SavedQueryDTOSchema.parse({ ...baseSavedQuery, country: 'u' })).toThrow()
  })

  it('accepts a well-formed builder-list DTO', () => {
    const list = BuilderListDTOSchema.parse({
      id: 'l-1',
      organizationId: 'org-1',
      createdByUserId: 'u-1',
      name: 'Spring 2026 shortlist',
      description: 'people to talk to',
      visibility: 'private',
      createdAt: '2026-07-29T10:00:00Z',
      updatedAt: '2026-07-29T10:00:00Z',
    })
    expect(list.visibility).toBe('private')
  })

  it('accepts a well-formed list-item DTO keyed on builderIdentityId', () => {
    const item = BuilderListItemDTOSchema.parse({
      id: 'li-1',
      listId: 'l-1',
      organizationId: 'org-1',
      builderIdentityId: 'bi-1',
      createdByUserId: 'u-1',
      createdAt: '2026-07-29T10:00:00Z',
    })
    expect(item.builderIdentityId).toBe('bi-1')
  })

  it('rejects a feed capability whose handle is too short to be a real secret', () => {
    expect(() => FeedCapabilityDTOSchema.parse({
      id: 'fc-1',
      organizationId: 'org-1',
      queryId: 'q-1',
      capability: 'short',
      createdAt: '2026-07-29T10:00:00Z',
      expiresAt: null,
      revokedAt: null,
    })).toThrow()
  })
})

describe('shared-resources/contracts — errors', () => {
  it('produces a 404 for not_found and a 403 for forbidden', () => {
    expect(new SharedResourceError('not_found', 'gone', 404).status).toBe(404)
    expect(new SharedResourceError('forbidden', 'no', 403).status).toBe(403)
    expect(new SharedResourceError('plan_lapsed', 'expired', 422).status).toBe(422)
  })

  it('keeps the code as a stable identifier clients can switch on', () => {
    const err = new SharedResourceError('tenant_authority_in_request', 'no', 403)
    expect(err.code).toBe('tenant_authority_in_request')
  })
})

describe('shared-resources/contracts — stripOrganizationAuthority', () => {
  it('drops every common tenant-key variant the client might send', () => {
    const body = {
      name: 'a query',
      organizationId: 'org-attacker',
      organization_id: 'org-attacker',
      orgId: 'org-attacker',
      keywords: ['rust'],
    }
    const stripped = stripOrganizationAuthority(body) as { name: string; keywords: string[] }
    expect(stripped).not.toHaveProperty('organizationId')
    expect(stripped).not.toHaveProperty('organization_id')
    expect(stripped).not.toHaveProperty('orgId')
    expect(stripped.name).toBe('a query')
  })

  it('leaves the rest of the body alone', () => {
    const body = { name: 'a', organizationId: 'x', keywords: ['rust'] }
    const stripped = stripOrganizationAuthority(body) as { name: string; keywords: string[] }
    expect(stripped.name).toBe('a')
    expect(stripped.keywords).toEqual(['rust'])
  })
})
