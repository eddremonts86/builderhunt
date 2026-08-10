/**
 * The one source for invitation intent: values, labels, capability copy, email lead, suggested query,
 * and the normalization every writer runs.
 *
 * ## Why this module owns its own vocabulary
 *
 * The four values match `phase-2/02-segmentacion-usuarios`'s taxonomy, and this deliberately does not
 * import from it. That plan is pending; depending on it would make a shipped invitation flow wait on an
 * unshipped segmentation model, and the sender's choice here is *invitation context* — it does not write
 * a user preference, lock an onboarding choice, or infer anything about who the recipient is.
 *
 * ## Why every map is `Record<InvitationIntent, …>`
 *
 * Adding a fifth intent must fail type checking in every consumer rather than silently falling back to
 * `other` copy in one of them. An index signature or a `Partial` would let a half-finished addition
 * compile and ship an invitation whose card describes nothing.
 *
 * Client-safe: no database, no environment, no server imports. The sender's composer, the recipient's
 * review page and the email all read from here, which is what makes the preview the sender sees and the
 * card the recipient sees provably the same content.
 */

export const INVITATION_INTENTS = ['hiring', 'investing', 'building', 'other'] as const

export type InvitationIntent = (typeof INVITATION_INTENTS)[number]

export interface InvitationPersonalization {
  intent: InvitationIntent
  roleTitle: string | null
}

/** The longest role title the column accepts, mirrored by a CHECK constraint in the migration. */
export const ROLE_TITLE_MAX_LENGTH = 120

export const INVITATION_INTENT_LABELS: Record<InvitationIntent, string> = {
  hiring: 'Hiring technical people',
  investing: 'Mapping a technical market',
  building: 'Building my own visibility',
  other: 'Something else',
}

/**
 * What the recipient is told they will be able to do.
 *
 * Three per intent, describing **shipped, cross-tier** capabilities only. No credit counts, no plan
 * names, no "unlimited": the recipient is not a member yet, effective entitlements can change, and a
 * promise made here is one the product may not keep on the day they accept.
 */
export const INVITATION_INTENT_CAPABILITIES: Record<InvitationIntent, readonly [string, string, string]> = {
  hiring: [
    'Search across GitHub, Hacker News and DEV.to in one query',
    'Sort by recent activity rather than by follower count',
      'Save a search and get told when someone new matches it',
  ],
  investing: [
    'Find people by the work they have shipped, not by their job title',
    'See which stacks and ecosystems a person actually contributes to',
    'Follow a technical market as its contributors move',
  ],
  building: [
    'Claim the profile built from your public work',
    'Show what you have shipped instead of describing it',
    'Control what appears on your public profile',
  ],
  other: [
    'Search for builders across several communities at once',
    'Keep track of the people you want to come back to',
    'Share what you find with the rest of the organization',
  ],
}

/** One sentence added to the invitation email, in the same voice as the rest of it. */
export const INVITATION_INTENT_EMAIL_LEAD: Record<InvitationIntent, string> = {
  hiring: 'They think BuilderHunt will help you find and evaluate technical people.',
  investing: 'They think BuilderHunt will help you map who is building in a technical market.',
  building: 'They think BuilderHunt will help you show the work you have already shipped.',
  other: 'They think BuilderHunt will be useful to you.',
}

/**
 * The search the new member lands on after accepting.
 *
 * Static per intent, and deliberately not the sender's own most-used query: search history is
 * tenant-private, and copying it into an invitation would move private workflow content to somebody who
 * is not yet a member of the tenant that owns it.
 */
export const INVITATION_SUGGESTED_QUERY: Record<InvitationIntent, string> = {
  hiring: 'backend engineers',
  investing: 'AI infrastructure founders',
  building: 'developer tools',
  other: 'open source builders',
}

/** Whether `value` is one of the four intents. Narrows, so callers need no cast. */
export function isInvitationIntent(value: unknown): value is InvitationIntent {
  return typeof value === 'string' && (INVITATION_INTENTS as readonly string[]).includes(value)
}

/**
 * An unknown, absent or malformed intent becomes `other`.
 *
 * `other` is a real intent with its own copy rather than a null state, so a legacy row with no intent
 * and a request from a client that never learned the field both render a complete card. Nothing in this
 * flow needs to distinguish "no intent chosen" from "chose Something else" — both mean the sender did
 * not tell us, and both deserve the neutral overview.
 */
export function normalizeInvitationIntent(value: unknown): InvitationIntent {
  return isInvitationIntent(value) ? value : 'other'
}

/**
 * Trims a role title, maps empty to `null`, and refuses one that is too long.
 *
 * Returns `null` for absent/empty and `undefined` for **invalid**, so a caller can tell "no title" from
 * "a title I must reject". Collapsing those would let a 200-character title arrive as a silent `null`,
 * and the sender would watch their context disappear with no error.
 */
export function normalizeRoleTitle(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > ROLE_TITLE_MAX_LENGTH) return undefined
  return trimmed
}

/**
 * Normalizes a whole personalization input, or returns `null` when the role title is invalid.
 *
 * One function so the route, the resend path and the email cannot disagree about what a valid input is.
 */
export function normalizeInvitationPersonalization(
  input: { intent?: unknown; roleTitle?: unknown },
): InvitationPersonalization | null {
  const roleTitle = normalizeRoleTitle(input.roleTitle)
  if (roleTitle === undefined) return null
  return { intent: normalizeInvitationIntent(input.intent), roleTitle }
}
