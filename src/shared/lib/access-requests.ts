/**
 * Invite-gated access: the allowlist behind sign-up.
 *
 * The product is in public beta and the sign-up form is open to the world, which is how three
 * accounts nobody recognised appeared in production between 2026-07-27 and 2026-07-31. This module
 * is the gate: an `access_requests` row with `status = 'approved'` is the only thing that lets an
 * email create an account.
 *
 * ## Shape of the flow
 *
 *   1. anyone submits their email          -> `requestAccess`   (status 'pending')
 *   2. an operator decides                 -> `approveAccess` / `revokeAccess`
 *   3. approval mints a one-time token, emailed to them
 *   4. they follow the link and sign up    -> `checkInviteForSignup` then `consumeInvite`
 *
 * ## Two rules that shape the code
 *
 * **The token is never stored.** `approveAccess` returns the plaintext token exactly once, to be put
 * in the email, and persists only an HMAC of it — the same construction as
 * `profile-removal.ts#generateRemovalChallenge`. Nothing can read a token back out of the database,
 * so "resend the original invite" is impossible by design; a resend mints a new token and the old one
 * stops working. That is a deliberate trade, matching how scheduling capabilities already work here.
 *
 * **Approval is checked at the moment of use, never cached.** `isEmailAllowed` reads the row every
 * time. A revoked email must stop working immediately, and a cache would give it a grace period
 * measured in whatever the TTL happened to be.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull, lt, ne, sql } from 'drizzle-orm'

import { accessRequests } from './db/schema'
import { env } from './env'
import { OPERATOR_LIST_LIMIT } from './db/read-bounds'

/** Invite links are short-lived: long enough to act on an email, short enough that a leaked link in a
 *  forwarded thread is usually already dead. */
export const ACCESS_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type AccessRequestStatus = 'pending' | 'approved' | 'rejected' | 'revoked'

/**
 * Emails are compared as identity, so they must be compared consistently.
 *
 * Lowercased and trimmed — that is all. Deliberately NOT "normalized" further: stripping dots or
 * `+tag` suffixes (the Gmail-specific tricks) would make two addresses that different providers treat
 * as different people compare equal here, and this table decides who gets in. Over-normalizing an
 * allowlist grants access, it does not restrict it.
 */
export function normalizeAccessEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/** Rejects the obviously-not-an-address before a row is written. Not a deliverability check. */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(value) && value.length <= 254
}

function inviteSecret(): string {
  // Reuses the auth secret rather than adding another required env var: this HMAC protects a
  // 7-day invite token, not stored user data, and env.ts already refuses a weak BETTER_AUTH_SECRET
  // in production.
  const secret = env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required to mint access invites')
  return secret
}

export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashInviteToken(token: string, secret: string = inviteSecret()): string {
  return createHmac('sha256', secret).update(`builderhunt:access-invite:v1:${token}`).digest('hex')
}

/** Constant-time compare, so a wrong token cannot be narrowed byte by byte from response timing. */
export function inviteTokenMatches(token: string, storedHash: string, secret?: string): boolean {
  const candidate = Buffer.from(hashInviteToken(token, secret ?? inviteSecret()), 'hex')
  const stored = Buffer.from(storedHash, 'hex')
  if (candidate.length !== stored.length) return false
  return timingSafeEqual(candidate, stored)
}

export function isInviteExpired(expiresAt: Date | string | null): boolean {
  if (!expiresAt) return true
  return new Date(expiresAt).getTime() <= Date.now()
}

/* -------------------------------------------------------------------------- */
/*  Queries — each takes its own db handle so the caller picks the role        */
/* -------------------------------------------------------------------------- */

/**
 * `db` is passed in rather than imported so every call site is explicit about which Postgres role it
 * is acting as. The grants in `0147_access_requests_grants.sql` are the real access-control boundary
 * here (the table has no RLS — it has no owning tenant), and a module that reached for one global
 * handle would quietly route admin writes through the web-runtime role.
 */
export interface AccessRequestRow {
  id: string
  email: string
  status: string
  inviteTokenHash: string | null
  inviteExpiresAt: Date | null
  inviteConsumedAt: Date | null
  requestedAt: Date
  decidedAt: Date | null
  decidedByUserId: string | null
  note: string | null
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the db handle is intentionally role-agnostic; see the Db comment above. */

export async function findAccessRequest(db: any, email: string): Promise<AccessRequestRow | null> {
  const normalized = normalizeAccessEmail(email)
  const [row] = await db.select().from(accessRequests).where(eq(accessRequests.email, normalized)).limit(1)
  return (row as AccessRequestRow | undefined) ?? null
}

/**
 * True only for an email with a live `approved` row.
 *
 * Anything else — no row, pending, revoked — is false. That is the fail-closed direction: a typo in
 * the address, a request nobody got to yet, and an access that was taken away all land in the same
 * place, which is "not allowed in".
 */
export async function isEmailAllowed(db: any, email: string): Promise<boolean> {
  const row = await findAccessRequest(db, email)
  return row?.status === 'approved'
}

/**
 * Records a request, or leaves an existing one alone.
 *
 * Idempotent on purpose, and the return value says which case happened so the caller can decide what
 * to *say* — but note the caller must not leak that difference to an anonymous submitter. Telling a
 * stranger "you are already approved" turns this form into an oracle for which addresses have access.
 */
export async function requestAccess(
  db: any,
  input: { email: string; id: string; note?: string | null },
): Promise<{ created: boolean; status: AccessRequestStatus }> {
  const email = normalizeAccessEmail(input.email)
  const existing = await findAccessRequest(db, email)
  if (existing) {
    return { created: false, status: existing.status as AccessRequestStatus }
  }
  await db.insert(accessRequests).values({
    id: input.id,
    email,
    status: 'pending',
    note: input.note ?? null,
  })
  return { created: true, status: 'pending' }
}

/**
 * Approves an email and mints its invite.
 *
 * Returns the plaintext token **once**. It is not stored and cannot be recovered; the only copy is
 * whatever the caller does with it next (the approval email). Calling this again on an
 * already-approved row is how a resend works, and it invalidates the previous link.
 *
 * ## `createIfMissing`
 *
 * An operator inviting someone who never filled in the form is the normal case for a closed beta, not
 * an edge case — you decide to let a specific person in and type their address. The first version of
 * this only did an UPDATE, so that path silently did nothing and the admin screen reported "has not
 * requested access": the one affordance whose entire purpose was adding a stranger could not add one.
 * (Found in the audit trail: two `access_request.approve` events with `result: failed`, from someone
 * trying exactly that.)
 *
 * With `createIfMissing`, an absent row is inserted and approved in the same call. The insert carries
 * `status: 'approved'` and a decision timestamp directly, because the table's check constraint requires
 * a non-pending row to have one.
 */
export async function approveAccess(
  db: any,
  input: {
    email: string
    decidedByUserId: string
    note?: string | null
    now?: Date
    /** Insert the row when no request exists, instead of returning null. */
    createIfMissing?: boolean
    /** Id for a row created by `createIfMissing`. Supplied by the caller so this module stays free of id policy. */
    id?: string
  },
): Promise<{ token: string; expiresAt: Date } | null> {
  const email = normalizeAccessEmail(input.email)
  const token = generateInviteToken()
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + ACCESS_INVITE_TTL_MS)
  const updated = await db.update(accessRequests)
    .set({
      status: 'approved',
      inviteTokenHash: hashInviteToken(token),
      inviteExpiresAt: expiresAt,
      // A resend must clear a previous redemption, or the new link is dead on arrival.
      inviteConsumedAt: null,
      decidedAt: now,
      decidedByUserId: input.decidedByUserId,
      ...(input.note === undefined ? {} : { note: input.note }),
    })
    .where(eq(accessRequests.email, email))
    .returning({ id: accessRequests.id })
  if (updated?.length) return { token, expiresAt }

  if (!input.createIfMissing || !input.id) return null
  await db.insert(accessRequests).values({
    id: input.id,
    email,
    status: 'approved',
    inviteTokenHash: hashInviteToken(token),
    inviteExpiresAt: expiresAt,
    decidedAt: now,
    decidedByUserId: input.decidedByUserId,
    note: input.note ?? 'invited directly by an operator',
  })
  return { token, expiresAt }
}

/**
 * Takes access away. The row stays — `status` becomes `revoked` and the invite hash is cleared so any
 * outstanding link stops working in the same statement.
 */
export async function revokeAccess(
  db: any,
  input: { email: string; decidedByUserId: string; note?: string | null; now?: Date },
): Promise<boolean> {
  const email = normalizeAccessEmail(input.email)
  const updated = await db.update(accessRequests)
    .set({
      status: 'revoked',
      inviteTokenHash: null,
      inviteExpiresAt: null,
      decidedAt: input.now ?? new Date(),
      decidedByUserId: input.decidedByUserId,
      ...(input.note === undefined ? {} : { note: input.note }),
    })
    .where(eq(accessRequests.email, email))
    .returning({ id: accessRequests.id })
  return Boolean(updated?.length)
}

/**
 * Turns a request down.
 *
 * Distinct from `revokeAccess` on purpose. Both end with the person unable to sign up, but they record
 * different histories: 'rejected' is "we said no", 'revoked' is "we said yes and then took it back".
 * Without this, the only way to decline a pending request through the UI was approve-then-revoke,
 * which mints an invite token and mails a link to the person being declined.
 *
 * There is nothing to clear — a pending row has no invite hash — so unlike `revokeAccess` this does not
 * need to null the token columns. Asserting that in the WHERE clause rather than assuming it: if the
 * row is somehow approved, this refuses and the caller must revoke instead.
 */
export async function rejectAccess(
  db: any,
  input: { email: string; decidedByUserId: string; note?: string | null; now?: Date },
): Promise<boolean> {
  const updated = await db.update(accessRequests)
    .set({
      status: 'rejected',
      decidedAt: input.now ?? new Date(),
      decidedByUserId: input.decidedByUserId,
      ...(input.note === undefined ? {} : { note: input.note }),
    })
    .where(and(
      eq(accessRequests.email, normalizeAccessEmail(input.email)),
      // Only a request that has not been granted can be rejected. An approved row has to go through
      // revocation, which also has to kill the outstanding invite.
      ne(accessRequests.status, 'approved'),
    ))
    .returning({ id: accessRequests.id })
  return Boolean(updated?.length)
}

/**
 * Everything that must be true for an invite link to admit someone, in one place.
 *
 * Returns a reason rather than a boolean so the sign-up route can distinguish "expired, offer to ask
 * again" from "wrong token, say nothing useful".
 */
export type InviteCheck =
  | { ok: true; email: string }
  | { ok: false; reason: 'unknown' | 'not_approved' | 'expired' | 'already_used' | 'bad_token' }

export async function checkInviteForSignup(db: any, email: string, token: string): Promise<InviteCheck> {
  const row = await findAccessRequest(db, email)
  if (!row) return { ok: false, reason: 'unknown' }
  if (row.status !== 'approved') return { ok: false, reason: 'not_approved' }
  if (row.inviteConsumedAt) return { ok: false, reason: 'already_used' }
  if (!row.inviteTokenHash) return { ok: false, reason: 'expired' }
  if (isInviteExpired(row.inviteExpiresAt)) return { ok: false, reason: 'expired' }
  if (!inviteTokenMatches(token, row.inviteTokenHash)) return { ok: false, reason: 'bad_token' }
  return { ok: true, email: row.email }
}

/**
 * Marks the invite redeemed, and does it as a conditional UPDATE rather than a read-then-write.
 *
 * `where invite_consumed_at is null` makes the database the arbiter: two sign-ups racing on the same
 * link both reach here, exactly one gets a row back, and the loser is told the invite was used. A
 * check in application code would let both through.
 */
export async function consumeInvite(db: any, email: string, now: Date = new Date()): Promise<boolean> {
  const updated = await db.update(accessRequests)
    .set({ inviteConsumedAt: now })
    .where(and(
      eq(accessRequests.email, normalizeAccessEmail(email)),
      eq(accessRequests.status, 'approved'),
      isNull(accessRequests.inviteConsumedAt),
    ))
    .returning({ id: accessRequests.id })
  return Boolean(updated?.length)
}

/**
 * Worker sweep: an invite past its expiry stops being a credential.
 *
 * Clears the hash and the expiry together (the table's check constraint requires they agree), leaving
 * `status = 'approved'` intact — the person is still allowed in, they just need a fresh link. Both
 * columns must be nulled in one statement or the constraint rejects it.
 */
export async function expireStaleInvites(db: any, now: Date = new Date()): Promise<number> {
  const updated = await db.update(accessRequests)
    .set({ inviteTokenHash: null, inviteExpiresAt: null })
    .where(and(
      eq(accessRequests.status, 'approved'),
      isNull(accessRequests.inviteConsumedAt),
      lt(accessRequests.inviteExpiresAt, now),
    ))
    .returning({ id: accessRequests.id })
  return updated?.length ?? 0
}

/** Admin queue, newest request first. */
export async function listAccessRequests(db: any, status?: AccessRequestStatus): Promise<AccessRequestRow[]> {
  // The operator's allowlist queue, newest first.
  //
  // Written as one chain per branch rather than as a shared `const query = db.select().from(...)`
  // that each branch finishes. Both shapes are bounded, but only this one is *visibly* bounded: the
  // read-path detector associates a bound with the call chain it appears in, and a chain split across
  // statements is the blind spot it cannot follow (see scripts/lib/unbounded-reads.mjs). This read was
  // reported as unbounded while carrying `OPERATOR_LIST_LIMIT` on both branches — a false positive
  // then, and indistinguishable from a real one at review time.
  const rows = status
    ? await db.select().from(accessRequests)
      .where(eq(accessRequests.status, status))
      .orderBy(sql`${accessRequests.requestedAt} desc`)
      .limit(OPERATOR_LIST_LIMIT)
    : await db.select().from(accessRequests)
      .orderBy(sql`${accessRequests.requestedAt} desc`)
      .limit(OPERATOR_LIST_LIMIT)
  return rows as AccessRequestRow[]
}

/* eslint-enable @typescript-eslint/no-explicit-any */
