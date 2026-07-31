// Regression coverage for the "sensitive canary" false positive found live while verifying the
// builder_lists RLS fix (2026-07-31 phase-1 audit follow-up): `builderIdentityId` is always a
// 64-char sha256 hex digest — a public, derived routing key, not a secret — but it matched the
// "long opaque token" canary (40+ chars) and made every real "Add to shortlist" request 500.
import { describe, expect, it } from 'vitest'
import { ACTIVITY_EVENTS } from '~/shared/lib/activity/contracts'

// A real builderIdentityId shape: sha256(source + '\0' + sourceId), 64 lowercase hex chars.
const REAL_BUILDER_IDENTITY_ID = 'c919eeb9777d6e801cf3698f03c5e36d217a2a1792daaf3b9cc7d5d061013a55'

describe('activity event metadata — sensitive-canary exemption', () => {
  it('accepts a real 64-char builderIdentityId on builder_list_item_added', () => {
    const result = ACTIVITY_EVENTS.builder_list_item_added.metadata.safeParse({
      listId: 'list_1',
      listName: 'Rust engineers',
      builderIdentityId: REAL_BUILDER_IDENTITY_ID,
    })
    expect(result.success).toBe(true)
  })

  it('accepts a real 64-char builderIdentityId on builder_list_item_removed', () => {
    const result = ACTIVITY_EVENTS.builder_list_item_removed.metadata.safeParse({
      listId: 'list_1',
      listName: 'Rust engineers',
      builderIdentityId: REAL_BUILDER_IDENTITY_ID,
    })
    expect(result.success).toBe(true)
  })

  it('still rejects a long opaque token leaking into a non-exempted field (listName)', () => {
    // Same shape as a real builderIdentityId (64 hex chars) — proves the exemption is scoped to the
    // one field name, not a blanket loosening of the canary regex.
    const result = ACTIVITY_EVENTS.builder_list_item_added.metadata.safeParse({
      listId: 'list_1',
      listName: REAL_BUILDER_IDENTITY_ID,
      builderIdentityId: REAL_BUILDER_IDENTITY_ID,
    })
    expect(result.success).toBe(false)
  })

  it('still rejects an email-like string leaking into listName', () => {
    const result = ACTIVITY_EVENTS.builder_list_created.metadata.safeParse({
      listId: 'list_1',
      listName: 'contact me at someone@example.com',
      visibility: 'private',
    })
    expect(result.success).toBe(false)
  })
})
