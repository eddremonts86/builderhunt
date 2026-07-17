// Server-only legal helpers (consent, data export, account deletion).
// Lazy-imports db to avoid `Buffer is not defined` in the browser bundle.

import { db } from '~/shared/lib/db/index'
import {
  authUsers, savedQueries, builderNotes, alerts, userConsents,
  builderProfileViews, builderClaimRequests,
  deletionRequests, onboardingProgress, authSessions, authAccounts,
  authVerifications,
} from '~/shared/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { randomId } from '~/lib/utils'

const CURRENT_VERSIONS = {
  tos: 'v1.0',
  privacy: 'v1.0',
  cookies: 'v1.0',
} as const

export type ConsentDocument = keyof typeof CURRENT_VERSIONS
export const CURRENT_CONSENT_VERSIONS = CURRENT_VERSIONS

export async function getConsentStatus(userId: string | null) {
  if (!userId) {
    return {
      userId: null as string | null,
      consents: {} as Record<string, string>,
      required: CURRENT_VERSIONS,
      needsAcceptance: Object.keys(CURRENT_VERSIONS) as ConsentDocument[],
    }
  }
  const rows = await db.select().from(userConsents).where(eq(userConsents.userId, userId))
  const map: Record<string, string> = {}
  for (const r of rows) {
    if (!map[r.document]) map[r.document] = r.version
  }
  const needsAcceptance: ConsentDocument[] = []
  for (const [doc, ver] of Object.entries(CURRENT_VERSIONS)) {
    if (map[doc] !== ver) needsAcceptance.push(doc as ConsentDocument)
  }
  return { userId, consents: map, required: CURRENT_VERSIONS, needsAcceptance }
}

export async function recordConsent(userId: string, document: ConsentDocument, version: string) {
  await db.insert(userConsents).values({
    id: randomId(),
    userId,
    document,
    version,
  })
}

// ---------------------------------------------------------------------------
// Data export
// ---------------------------------------------------------------------------

// Convert Drizzle row to plain JSON-safe object (strips schema references)
function toPlain<T extends Record<string, unknown>>(row: T | null | undefined): Record<string, unknown> | null {
  if (!row) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) out[k] = v.toISOString()
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = toPlain(v as Record<string, unknown>)
    else if (Array.isArray(v)) out[k] = v.map((x) => (x && typeof x === 'object' ? toPlain(x as Record<string, unknown>) : x))
    else out[k] = v
  }
  return out
}

export async function buildExportPayload(userId: string) {
  const [user] = await db.select().from(authUsers).where(eq(authUsers.id, userId)).limit(1)
  if (!user) return null
  const [account] = await db
    .select()
    .from(authAccounts)
    .where(eq(authAccounts.userId, userId))
    .limit(1)
  const queries = await db.select().from(savedQueries).where(eq(savedQueries.userId, userId))
  const userAlerts = await db.select().from(alerts).where(eq(alerts.userId, userId))
  const notes = await db.select().from(builderNotes).where(eq(builderNotes.userId, userId))
  const consents = await db.select().from(userConsents).where(eq(userConsents.userId, userId))
  // builder_claim_requests stores email (not userId). Match on email.
  const claims = await db
    .select()
    .from(builderClaimRequests)
    .where(eq(builderClaimRequests.email, user.email))
  const [onboarding] = await db
    .select()
    .from(onboardingProgress)
    .where(eq(onboardingProgress.userId, userId))
    .limit(1)
  const [deletion] = await db
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.userId, userId))
    .limit(1)
  const profileViews = await db
    .select()
    .from(builderProfileViews)
    .where(eq(builderProfileViews.viewerId, userId))

  return {
    exportedAt: new Date().toISOString(),
    user: toPlain(user as unknown as Record<string, unknown>),
    auth: account
      ? {
          providerId: account.providerId,
          hasPassword: !!account.password,
          createdAt: account.createdAt,
        }
      : null,
    savedQueries: queries.map((q) => toPlain(q as unknown as Record<string, unknown>)),
    alerts: userAlerts.map((a) => toPlain(a as unknown as Record<string, unknown>)),
    builderNotes: notes.map((n) => toPlain(n as unknown as Record<string, unknown>)),
    consents: consents.map((c) => ({
      document: c.document,
      version: c.version,
      acceptedAt: c.acceptedAt,
    })),
    builderClaimRequests: claims.map((c) => toPlain(c as unknown as Record<string, unknown>)),
    onboarding: toPlain(onboarding as unknown as Record<string, unknown>),
    deletionRequest: toPlain(deletion as unknown as Record<string, unknown>),
    builderProfileViews: profileViews.map((v) => toPlain(v as unknown as Record<string, unknown>)),
  }
}

export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Account deletion
// ---------------------------------------------------------------------------

export const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000

export async function getDeletionRequest(userId: string) {
  const [row] = await db
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.userId, userId))
    .limit(1)
  return row ?? null
}

export async function requestDeletion(userId: string) {
  const existing = await getDeletionRequest(userId)
  const gracePeriodEndsAt = new Date(Date.now() + GRACE_PERIOD_MS)
  if (existing && existing.status === 'pending') {
    return { id: existing.id, gracePeriodEndsAt, alreadyPending: true }
  }
  if (existing) {
    await db
      .update(deletionRequests)
      .set({ status: 'pending', gracePeriodEndsAt, completedAt: null })
      .where(eq(deletionRequests.id, existing.id))
    return { id: existing.id, gracePeriodEndsAt, alreadyPending: false }
  }
  const id = randomId()
  await db.insert(deletionRequests).values({
    id,
    userId,
    status: 'pending',
    gracePeriodEndsAt,
  })
  return { id, gracePeriodEndsAt, alreadyPending: false }
}

export async function cancelDeletion(userId: string) {
  await db
    .update(deletionRequests)
    .set({ status: 'cancelled' })
    .where(
      and(eq(deletionRequests.userId, userId), eq(deletionRequests.status, 'pending')),
    )
}

export async function performHardDelete(userId: string) {
  // Wipe in correct order. CASCADE handles most via FK.
  // All FK references from authUsers.id are ON DELETE CASCADE.
  await db.delete(authVerifications).where(eq(authVerifications.identifier, userId))
  await db.delete(authSessions).where(eq(authSessions.userId, userId))
  await db.delete(authAccounts).where(eq(authAccounts.userId, userId))
  await db.delete(authUsers).where(eq(authUsers.id, userId))
}
