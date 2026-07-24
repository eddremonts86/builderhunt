/**
 * Multi-accounting defenses (abuse-and-usage-integrity plan, Phase 3): normalizing plus-addresses
 * for duplicate detection, and rejecting known disposable-email domains at sign-up. Pure/testable —
 * `src/shared/lib/auth/better-auth.ts` wires `checkSignupEmailGate` into
 * `databaseHooks.user.create.before` (the only hook stage that can abort user creation; throwing an
 * `APIError` there propagates to the sign-up endpoint's caller and the transaction never commits —
 * see `dist/db/with-hooks.mjs`/`dist/api/routes/sign-up.mjs` in `better-auth`).
 */

/**
 * Strips a `+tag` local-part suffix and lowercases both parts, so
 * `Jane+newsletter@Example.com` and `jane@example.com` normalize to the same string for
 * duplicate-account detection. Does NOT remove dots (Gmail-specific behavior that would be
 * surprising/wrong for every other provider) — plus-addressing alone is what the task calls for.
 */
export function normalizeEmailForDuplicateDetection(email: string): string {
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.lastIndexOf('@')
  if (at === -1) return trimmed
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  const plusIndex = local.indexOf('+')
  const normalizedLocal = plusIndex === -1 ? local : local.slice(0, plusIndex)
  return `${normalizedLocal}@${domain}`
}

/**
 * A sampled (not exhaustive) list of well-known public disposable/temporary-email domains.
 * Attackers can always stand up a fresh domain, so this is a cheap deterrent against the
 * overwhelmingly common case (reusing a known throwaway provider), not a complete blocklist.
 */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.info',
  'guerrillamail.biz',
  'guerrillamail.de',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  '10minutemail.com',
  '20minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'tempmailo.com',
  'throwawaymail.com',
  'throwam.com',
  'yopmail.com',
  'trashmail.com',
  'sharklasers.com',
  'dispostable.com',
  'getnada.com',
  'maildrop.cc',
  'mintemail.com',
  'fakeinbox.com',
  'mohmal.com',
  'moakt.com',
  'emailondeck.com',
  'spam4.me',
  'mailnesia.com',
  'tempinbox.com',
  'spambog.com',
  'mytemp.email',
  'discard.email',
  'mailcatch.com',
  'tempr.email',
  'emailfake.com',
  'correotemporal.org',
  'fakemailgenerator.com',
  'harakirimail.com',
  'jetable.org',
  'mailexpire.com',
  'spamgourmet.com',
])

/** Domain-only check (case-insensitive) — never treats a malformed email (no `@`) as disposable. */
export function isDisposableEmailDomain(email: string, domains: ReadonlySet<string> = DISPOSABLE_EMAIL_DOMAINS): boolean {
  const at = email.lastIndexOf('@')
  if (at === -1) return false
  const domain = email.slice(at + 1).trim().toLowerCase()
  return domains.has(domain)
}

export class DisposableEmailRejectedError extends Error {
  constructor() {
    super('Disposable email addresses are not allowed.')
    this.name = 'DisposableEmailRejectedError'
  }
}

export interface SignupEmailGateInput {
  email: string
  blockDisposable: boolean
}

/** Throws `DisposableEmailRejectedError` when disposable-domain blocking is on and the email matches. */
export function checkSignupEmailGate(input: SignupEmailGateInput): void {
  if (input.blockDisposable && isDisposableEmailDomain(input.email)) {
    throw new DisposableEmailRejectedError()
  }
}
