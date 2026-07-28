/**
 * Verified billing contact (plans/phase-1/29-stripe-billing-platform/tasks.md §9 task 4 "Add verified billing
 * contact management"; spec.md: a separate address, owned by the organization, that receives
 * invoices/receipts/renewal and payment-failure notices — while every critical message (payment
 * failure) is ALSO always sent to the organization owner, since a billing contact grants no
 * membership or account authority of its own and must never become the only party who learns their
 * access is at risk.
 *
 * Verification mirrors `repositories/builder-claims.ts`'s token-in-link pattern exactly: a random
 * token is emailed, only its SHA-256 hash is stored, and verification is scoped to the CALLER's own
 * `organizationId` (never a bare token lookup) so a leaked or replayed link from another organization
 * can never verify a different org's pending contact. Setting a NEW email always overwrites any prior
 * row outright — this is "set and verify a separate email," not a permanent contact history.
 */
import { createHash } from 'node:crypto'
import type { TenantPrincipal } from '../authorization/permissions'
import type { TenantTransaction } from '../db/client'
import { emitSecurityAudit } from '../security/audit'
import { consoleSecurityAuditSink } from '../security/audit-sink'
import {
  findBillingContact,
  upsertPendingBillingContact,
  verifyPendingBillingContact,
} from '../repositories/billing-contacts'
import { requireBillingPermission, type RecentAuthSession } from './permissions'

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

export function hashBillingContactSecret(secret: string): string {
  return createHash('sha256').update(`builderhunt:billing-contact:v1:${secret}`).digest('hex')
}

export interface BillingContactSummary {
  email: string
  verifiedAt: string | null
}

export interface SetBillingContactInput {
  email: string
  /** Caller-generated (e.g. `randomToken(32)`) so the route owns randomness and can build the verification link with its own base URL. Only this value's hash is ever persisted. */
  verificationToken: string
}

/** Owner sets (or replaces) the billing contact — stores only the verification token's hash; the route is responsible for emailing the raw token as a link. */
export async function setBillingContact(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  session: RecentAuthSession | undefined,
  input: SetBillingContactInput,
  now: Date = new Date(),
): Promise<void> {
  requireBillingPermission(principal, 'billing:contact', session)

  await upsertPendingBillingContact(transaction, {
    organizationId: principal.organizationId,
    email: input.email,
    verificationSecretHash: hashBillingContactSecret(input.verificationToken),
    verificationExpiresAt: new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS),
    setByUserId: principal.userId,
  })

  await emitSecurityAudit({
    organizationId: principal.organizationId,
    actorUserId: principal.userId,
    action: 'billing.contact.set',
    targetType: 'billing_contact',
    targetId: principal.organizationId,
    result: 'allowed',
    requestId: principal.requestId,
  }, consoleSecurityAuditSink)
}

/** Verifies a pending contact for the CALLER's own organization — never accepts a bare token without a matching authenticated session's organizationId. Returns null on any mismatch (wrong org, wrong token, already verified, or expired) — indistinguishable on purpose, no oracle for guessing a valid token. */
export async function verifyBillingContact(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  token: string,
  now: Date = new Date(),
): Promise<BillingContactSummary | null> {
  const verified = await verifyPendingBillingContact(transaction, principal.organizationId, hashBillingContactSecret(token), now)

  await emitSecurityAudit({
    organizationId: principal.organizationId,
    actorUserId: principal.userId,
    action: 'billing.contact.verify',
    targetType: 'billing_contact',
    targetId: principal.organizationId,
    result: verified ? 'allowed' : 'denied',
    requestId: principal.requestId,
  }, consoleSecurityAuditSink)

  if (!verified) return null
  return { email: verified.email, verifiedAt: verified.verifiedAt?.toISOString() ?? null }
}

/** Read-only: only ever returns a `verified` contact, never a still-`pending` one — a caller displaying "your billing contact" should never show an unconfirmed address as if it were active. */
export async function getVerifiedBillingContact(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<BillingContactSummary | null> {
  const contact = await findBillingContact(transaction, organizationId)
  if (!contact || contact.status !== 'verified') return null
  return { email: contact.email, verifiedAt: contact.verifiedAt?.toISOString() ?? null }
}
