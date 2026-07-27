import { describe, expect, it } from 'vitest'
import {
  builderIdentityId,
  builderSnapshotHash,
  classifyLegacyBuilder,
} from '~/shared/lib/migration/builder-backfill'

describe('builder normalization backfill', () => {
  it('deduplicates source identity without exposing provider identifiers', () => {
    expect(builderIdentityId('github', '123')).toBe(builderIdentityId('github', '123'))
    expect(builderIdentityId('github', '123')).not.toContain('123')
    expect(builderIdentityId('github', '123')).not.toBe(builderIdentityId('reddit', '123'))
  })

  it('hashes normalized snapshots independent of object key order', () => {
    expect(builderSnapshotHash({ username: 'a', followersCount: 2 }))
      .toBe(builderSnapshotHash({ followersCount: 2, username: 'a' }))
  })

  it('quarantines ambiguous claims and rows without a valid tenant', () => {
    expect(classifyLegacyBuilder({ organizationId: null, hasResourceConflict: false, isClaimed: false, isVerified: false }))
      .toBe('orphan')
    expect(classifyLegacyBuilder({ organizationId: 'org-a', hasResourceConflict: true, isClaimed: false, isVerified: false }))
      .toBe('conflict')
    expect(classifyLegacyBuilder({ organizationId: 'org-a', hasResourceConflict: false, isClaimed: true, isVerified: false }))
      .toBe('conflict')
    expect(classifyLegacyBuilder({ organizationId: 'org-a', hasResourceConflict: false, isClaimed: false, isVerified: false }))
      .toBe('migrated')
  })
})
