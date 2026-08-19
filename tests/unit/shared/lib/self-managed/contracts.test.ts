/**
 * The self-managed profile contract (plan: phase-2/07-perfiles-autogestionados).
 *
 * The assertions that matter here are the refusals. This is a surface where a person types their own
 * description of themselves and a stranger reads it, so the two questions worth testing are what a
 * request may not carry and what a reader may not see.
 */
import { describe, expect, it } from 'vitest'

import {
  HANDLE_PATTERN,
  isPubliclyReadable,
  isSearchable,
  SELF_MANAGED_VISIBILITIES,
  upsertAttachmentSchema,
  upsertSelfManagedProfileSchema,
} from '~/shared/lib/self-managed/contracts'
import {
  isKnownService,
  SERVICE_IDS,
  SERVICE_TAXONOMY,
  SERVICE_TAXONOMY_VERSION,
  serviceById,
  serviceLabel,
} from '~/shared/lib/self-managed/service-taxonomy'

const valid = { handle: 'ada-lovelace', displayName: 'Ada Lovelace' }

describe('a request never carries authority', () => {
  /**
   * The one refusal this contract exists for. A body naming its own subject is a body somebody will
   * eventually send, and `.strict()` is what makes it a 400 rather than a value quietly ignored.
   */
  it.each(['ownerUserId', 'id', 'promotedToBuilderClaimId', 'declaredAt'])('rejects %s', (field) => {
    expect(upsertSelfManagedProfileSchema.safeParse({ ...valid, [field]: 'x' }).success).toBe(false)
  })

  it('accepts a minimal profile and defaults it to draft', () => {
    const parsed = upsertSelfManagedProfileSchema.parse(valid)
    expect(parsed.visibility).toBe('draft')
    expect(parsed.languages).toEqual([])
    expect(parsed.services).toEqual([])
  })
})

describe('the handle becomes a public URL, so it is narrow', () => {
  it.each(['ada-lovelace', 'a1b', 'x'.repeat(32)])('accepts %s', (handle) => {
    expect(HANDLE_PATTERN.test(handle)).toBe(true)
  })

  it.each(['ab', 'x'.repeat(33), 'Ada', 'ada lovelace', 'ada_lovelace', 'ada.lovelace', '../etc', 'ada/../x'])(
    'rejects %s',
    (handle) => {
      expect(HANDLE_PATTERN.test(handle)).toBe(false)
    },
  )
})

describe('services are a closed set', () => {
  /** Left open, everyone invents a word for the same work and the filter matches none of them. */
  it('refuses a service outside the taxonomy', () => {
    expect(upsertSelfManagedProfileSchema.safeParse({ ...valid, services: ['freelance-wizardry'] }).success).toBe(false)
  })

  it('accepts every id the taxonomy defines', () => {
    expect(upsertSelfManagedProfileSchema.safeParse({ ...valid, services: SERVICE_IDS }).success).toBe(true)
  })

  it('has no duplicate ids', () => {
    expect(new Set(SERVICE_IDS).size).toBe(SERVICE_IDS.length)
  })

  it('is version 1 and every entry has a label', () => {
    expect(SERVICE_TAXONOMY_VERSION).toBe(1)
    for (const service of SERVICE_TAXONOMY) expect(service.label.length).toBeGreaterThan(0)
  })

  /** A row can outlive its definition; showing the raw id beats silently dropping a chosen service. */
  it('falls back to the stored id for an unknown service', () => {
    expect(serviceLabel('a-service-removed-in-v2')).toBe('a-service-removed-in-v2')
    expect(serviceById('a-service-removed-in-v2')).toBeNull()
    expect(isKnownService('translation')).toBe(true)
  })
})

describe('free-text fields are bounded', () => {
  it.each([
    ['displayName', 'x'.repeat(81)],
    ['headline', 'x'.repeat(121)],
    ['bio', 'x'.repeat(1201)],
  ])('refuses an over-long %s', (field, value) => {
    expect(upsertSelfManagedProfileSchema.safeParse({ ...valid, [field]: value }).success).toBe(false)
  })

  it('caps languages at twelve', () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => `en-${i}`)
    expect(upsertSelfManagedProfileSchema.safeParse({ ...valid, languages: thirteen }).success).toBe(false)
  })

  it('requires a country code to be upper-case ISO alpha-2', () => {
    expect(upsertSelfManagedProfileSchema.safeParse({ ...valid, locationCountryCode: 'ES' }).success).toBe(true)
    // Rejected rather than coerced: a lowercase code is a caller bug worth surfacing.
    expect(upsertSelfManagedProfileSchema.safeParse({ ...valid, locationCountryCode: 'es' }).success).toBe(false)
    expect(upsertSelfManagedProfileSchema.safeParse({ ...valid, locationCountryCode: 'ESP' }).success).toBe(false)
  })
})

describe('visibility means three different things', () => {
  /**
   * `unlisted` is the whole reason there are three states. Merging it into `draft` would remove the
   * only setting that lets somebody share a link without becoming discoverable.
   */
  it('unlisted is readable but never searchable', () => {
    expect(isPubliclyReadable('unlisted')).toBe(true)
    expect(isSearchable('unlisted')).toBe(false)
  })

  it('draft is the owner\'s alone', () => {
    expect(isPubliclyReadable('draft')).toBe(false)
    expect(isSearchable('draft')).toBe(false)
  })

  it('public is both', () => {
    expect(isPubliclyReadable('public')).toBe(true)
    expect(isSearchable('public')).toBe(true)
  })

  it('has exactly the three states, so a fourth cannot appear untested', () => {
    expect([...SELF_MANAGED_VISIBILITIES]).toEqual(['public', 'unlisted', 'draft'])
  })
})

describe('attachments', () => {
  it('accepts the four kinds and refuses anything else', () => {
    for (const kind of ['cv', 'work-sample', 'certificate', 'other']) {
      expect(upsertAttachmentSchema.safeParse({ kind, title: 'A thing' }).success).toBe(true)
    }
    expect(upsertAttachmentSchema.safeParse({ kind: 'executable', title: 'A thing' }).success).toBe(false)
  })

  /** No storage key, no size, no checksum: those are the server's, not the caller's. */
  it.each(['storageKey', 'sizeBytes', 'checksumSha256', 'profileId'])('rejects a caller-supplied %s', (field) => {
    expect(upsertAttachmentSchema.safeParse({ kind: 'cv', title: 'CV', [field]: 'x' }).success).toBe(false)
  })
})
