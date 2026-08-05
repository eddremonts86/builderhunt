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

/**
 * Sign-up was refused because the address is not on the access allowlist.
 *
 * The message is deliberately the same for "never asked", "asked and still pending" and "was
 * revoked". Distinguishing them would turn the sign-up form into an oracle: anyone could learn
 * whether a given address has access by trying to register it. The person who genuinely asked and is
 * waiting learns nothing they do not already know, and the operator can see the real state in the
 * admin queue.
 */
export class AccessNotAllowlistedError extends Error {
  constructor() {
    super('BuilderHunt is currently invite-only. Request access and we will email you when your account is ready.')
    this.name = 'AccessNotAllowlistedError'
  }
}

export interface SignupEmailGateInput {
  email: string
  blockDisposable: boolean
  /**
   * Whether the invite gate is on, and whether this address passed it.
   *
   * The lookup itself is not done here: this module is synchronous and pure, which is what makes it
   * cheap to test. The caller (`better-auth.ts`'s `user.create.before`) does the query and passes the
   * answer down.
   *
   * `allowlistEnabled: false` means the gate is off entirely — that is the state local development
   * and the e2e harness run in, and it must stay a complete no-op there or every fixture that creates
   * a user starts failing.
   */
  allowlistEnabled?: boolean
  emailAllowlisted?: boolean
}

/**
 * The one place sign-up eligibility is decided.
 *
 * Order matters: the allowlist is checked **after** the disposable-domain rule, so an
 * `AccessNotAllowlistedError` is never the reason a throwaway address is refused. Both are refusals,
 * but they mean different things to whoever reads the logs.
 */
export function checkSignupEmailGate(input: SignupEmailGateInput): void {
  if (input.blockDisposable && isDisposableEmailDomain(input.email)) {
    throw new DisposableEmailRejectedError()
  }
  if (input.allowlistEnabled && !input.emailAllowlisted) {
    throw new AccessNotAllowlistedError()
  }
}
