import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  builderClaims,
  builderIdentities,
  builderSourceSnapshots,
  organizationBuilders,
  publishedBuilderProfiles,
} from '~/shared/lib/db/schema'

describe('normalized builder schema', () => {
  it('deduplicates provider identities globally', () => {
    const names = getTableConfig(builderIdentities).indexes.map((value) => value.config.name)
    expect(names).toContain('builder_identities_source_source_id_unique')
  })

  it('keeps tenant tracking unique and organization preserving', () => {
    const names = getTableConfig(organizationBuilders).indexes.map((value) => value.config.name)
    expect(names).toEqual(expect.arrayContaining([
      'organization_builders_org_identity_unique',
      'organization_builders_organization_id_id_unique',
    ]))
    expect(organizationBuilders.privateMetadata.name).toBe('private_metadata')
  })

  it('separates provenance, claims, and opt-in publication', () => {
    expect(builderSourceSnapshots.contentHash.notNull).toBe(true)
    expect(builderClaims.subjectUserId.notNull).toBe(true)
    expect(publishedBuilderProfiles.publishedAt.notNull).toBe(true)
  })
})
