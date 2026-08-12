import { describe, expect, it } from 'vitest'
import {
  INVITATION_INTENT_CAPABILITIES,
  INVITATION_INTENT_EMAIL_LEAD,
  INVITATION_INTENT_LABELS,
  INVITATION_INTENTS,
  INVITATION_SUGGESTED_QUERY,
  isInvitationIntent,
  normalizeInvitationIntent,
  normalizeInvitationPersonalization,
  normalizeRoleTitle,
  ROLE_TITLE_MAX_LENGTH,
} from '~/shared/lib/organizations/invitation-personalization'

describe('invitation intents', () => {
  it('has exactly the four documented values', () => {
    expect(INVITATION_INTENTS).toEqual(['hiring', 'investing', 'building', 'other'])
  })

  it('covers every intent in every per-intent map', () => {
    // The maps are typed `Record<InvitationIntent, …>`, so a missing key is a type error — but a
    // fifth intent added with `as` or a map built dynamically would slip past that, and the failure
    // mode is an invitation card describing nothing. Checked at runtime too.
    for (const intent of INVITATION_INTENTS) {
      expect(INVITATION_INTENT_LABELS[intent]).toBeTruthy()
      expect(INVITATION_INTENT_EMAIL_LEAD[intent]).toBeTruthy()
      expect(INVITATION_SUGGESTED_QUERY[intent]).toBeTruthy()
      expect(INVITATION_INTENT_CAPABILITIES[intent]).toHaveLength(3)
      for (const bullet of INVITATION_INTENT_CAPABILITIES[intent]) expect(bullet).toBeTruthy()
    }
  })

  it('makes no tier, credit or plan promise in recipient-facing copy', () => {
    // The recipient is not a member yet and effective entitlements change — beta mode can be switched
    // off the day after an invitation is sent. A card that says "700 credits" is a promise the product
    // may not keep, so the vocabulary is banned rather than reviewed.
    const forbidden = /\b(pro max|pro\b|team plan|credits?|unlimited|free plan|per month|\$)/i
    const copy = [
      ...Object.values(INVITATION_INTENT_LABELS),
      ...Object.values(INVITATION_INTENT_EMAIL_LEAD),
      ...Object.values(INVITATION_INTENT_CAPABILITIES).flat(),
    ]
    for (const line of copy) expect(line).not.toMatch(forbidden)
  })

  it('narrows with isInvitationIntent', () => {
    expect(isInvitationIntent('hiring')).toBe(true)
    expect(isInvitationIntent('HIRING')).toBe(false)
    expect(isInvitationIntent('recruiting')).toBe(false)
    expect(isInvitationIntent(undefined)).toBe(false)
    expect(isInvitationIntent(null)).toBe(false)
    expect(isInvitationIntent(7)).toBe(false)
  })
})

describe('normalizeInvitationIntent', () => {
  it('accepts all four values unchanged', () => {
    for (const intent of INVITATION_INTENTS) expect(normalizeInvitationIntent(intent)).toBe(intent)
  })

  it('falls back to other for missing, unknown and wrong-typed values', () => {
    // A legacy row has no intent and a legacy client never sends one; both must render a complete
    // card, which is why `other` is a real intent with its own copy rather than a null state.
    for (const value of [undefined, null, '', 'recruiting', 'Hiring', 42, {}, []]) {
      expect(normalizeInvitationIntent(value)).toBe('other')
    }
  })
})

describe('normalizeRoleTitle', () => {
  it('returns null for absent and empty values', () => {
    expect(normalizeRoleTitle(undefined)).toBeNull()
    expect(normalizeRoleTitle(null)).toBeNull()
    expect(normalizeRoleTitle('')).toBeNull()
    expect(normalizeRoleTitle('   ')).toBeNull()
    expect(normalizeRoleTitle('\t\n ')).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeRoleTitle('  Staff Engineer  ')).toBe('Staff Engineer')
  })

  it('accepts a title of exactly the maximum length', () => {
    const exact = 'a'.repeat(ROLE_TITLE_MAX_LENGTH)
    expect(normalizeRoleTitle(exact)).toBe(exact)
  })

  it('rejects one character past the maximum', () => {
    // `undefined`, not `null`: the caller must be able to tell "no title" from "a title I must
    // reject". Collapsing them turns a 121-character title into a silent null, and the sender watches
    // their context vanish with no error.
    expect(normalizeRoleTitle('a'.repeat(ROLE_TITLE_MAX_LENGTH + 1))).toBeUndefined()
  })

  it('measures length after trimming, not before', () => {
    const padded = `  ${'a'.repeat(ROLE_TITLE_MAX_LENGTH)}  `
    expect(normalizeRoleTitle(padded)).toBe('a'.repeat(ROLE_TITLE_MAX_LENGTH))
  })

  it('rejects a non-string', () => {
    expect(normalizeRoleTitle(42)).toBeUndefined()
    expect(normalizeRoleTitle({})).toBeUndefined()
  })
})

describe('normalizeInvitationPersonalization', () => {
  it('normalizes both fields together', () => {
    expect(normalizeInvitationPersonalization({ intent: 'hiring', roleTitle: '  Staff Engineer ' }))
      .toEqual({ intent: 'hiring', roleTitle: 'Staff Engineer' })
  })

  it('defaults an omitted intent and an omitted title', () => {
    expect(normalizeInvitationPersonalization({})).toEqual({ intent: 'other', roleTitle: null })
  })

  it('returns null when the role title is invalid, rather than dropping it', () => {
    expect(normalizeInvitationPersonalization({ intent: 'hiring', roleTitle: 'a'.repeat(121) })).toBeNull()
    expect(normalizeInvitationPersonalization({ intent: 'hiring', roleTitle: 7 })).toBeNull()
  })

  it('still rejects an invalid title when the intent is also unknown', () => {
    // Order matters: an unknown intent is forgiven and an overlong title is not, so a request with
    // both must fail rather than quietly becoming `other` with no title.
    expect(normalizeInvitationPersonalization({ intent: 'nonsense', roleTitle: 'a'.repeat(200) })).toBeNull()
  })
})
