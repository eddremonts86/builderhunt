import { describe, expect, it } from 'vitest'
import {
  REJECTED_REQUEST_FIELDS,
  toUserPreferencesResponse,
  updateUserPreferencesSchema,
  userPreferencesResponseSchema,
} from '~/shared/lib/user-preferences-api'
import { USER_SEGMENTS } from '~/shared/lib/user-segments'

/**
 * The wire contract, and specifically what it refuses.
 *
 * The subject of a write is the authenticated principal. A body that could name a user would be a
 * second source of truth for whose data is being changed, and the route would have to remember to
 * ignore it every time. Row-level security still refuses such a write, so this is not the only
 * defence — it is the one that fails at the edge, by name, instead of three layers down.
 */

describe('updateUserPreferencesSchema', () => {
  it('accepts each segment, and defaults the source to settings', () => {
    for (const segment of USER_SEGMENTS) {
      const parsed = updateUserPreferencesSchema.safeParse({ primarySegment: segment })
      expect(parsed.success).toBe(true)
      expect(parsed.success && parsed.data.source).toBe('settings')
    }
  })

  /** Clearing is a legitimate write, not a missing field. */
  it('accepts an explicit null', () => {
    const parsed = updateUserPreferencesSchema.safeParse({ primarySegment: null })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.primarySegment).toBeNull()
  })

  it('requires the field rather than treating an empty body as "clear it"', () => {
    expect(updateUserPreferencesSchema.safeParse({}).success).toBe(false)
  })

  it.each(REJECTED_REQUEST_FIELDS)('rejects a body carrying %s', (field) => {
    const parsed = updateUserPreferencesSchema.safeParse({ primarySegment: 'hiring', [field]: 'anything' })
    expect(parsed.success).toBe(false)
  })

  it('rejects an unknown segment', () => {
    expect(updateUserPreferencesSchema.safeParse({ primarySegment: 'recruiter' }).success).toBe(false)
    expect(updateUserPreferencesSchema.safeParse({ primarySegment: 'general' }).success).toBe(false)
  })

  /**
   * `migration` is written by a migration and `landing` by the pre-auth funnel; neither can arrive
   * on an authenticated PATCH. Accepting them would let a client mislabel its own writes and corrupt
   * the one field that explains why a segment changed.
   */
  it('accepts only the two sources a person can act through', () => {
    expect(updateUserPreferencesSchema.safeParse({ primarySegment: 'hiring', source: 'onboarding' }).success).toBe(true)
    expect(updateUserPreferencesSchema.safeParse({ primarySegment: 'hiring', source: 'settings' }).success).toBe(true)
    expect(updateUserPreferencesSchema.safeParse({ primarySegment: 'hiring', source: 'migration' }).success).toBe(false)
    expect(updateUserPreferencesSchema.safeParse({ primarySegment: 'hiring', source: 'landing' }).success).toBe(false)
  })
})

describe('toUserPreferencesResponse', () => {
  it('serialises a stored record, dates included', () => {
    const selectedAt = new Date('2026-08-14T10:00:00.000Z')
    const response = toUserPreferencesResponse({
      primarySegment: 'hiring', segmentSource: 'settings', segmentSchemaVersion: 1, segmentSelectedAt: selectedAt,
    })

    expect(userPreferencesResponseSchema.safeParse(response).success).toBe(true)
    expect(response.selectedAt).toBe('2026-08-14T10:00:00.000Z')
    // Sent so a client can render the picker without hardcoding the taxonomy or its order.
    expect(response.available).toEqual([...USER_SEGMENTS])
  })

  it('serialises somebody who has never answered', () => {
    const response = toUserPreferencesResponse({
      primarySegment: null, segmentSource: null, segmentSchemaVersion: null, segmentSelectedAt: null,
    })

    expect(userPreferencesResponseSchema.safeParse(response).success).toBe(true)
    expect(response.primarySegment).toBeNull()
    expect(response.selectedAt).toBeNull()
  })

  /** The response is a closed shape too: nothing about identity, plan or role belongs in it. */
  it('carries no identity, role or entitlement field', () => {
    const response = toUserPreferencesResponse({
      primarySegment: 'building', segmentSource: 'onboarding', segmentSchemaVersion: 1, segmentSelectedAt: new Date(),
    })

    for (const field of REJECTED_REQUEST_FIELDS) {
      expect(response).not.toHaveProperty(field)
    }
    expect(Object.keys(response).sort()).toEqual(
      ['available', 'primarySegment', 'schemaVersion', 'selectedAt', 'source'],
    )
  })
})
