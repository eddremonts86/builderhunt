import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { withTenantContext } from '../db/tenant-context'
import { organizationEntitlements, sessionSignals } from '../db/schema'
import { workerDb } from '../db/worker-db'
import { env } from '../env'
import { upsertUserDevice } from '../repositories/user-devices'
import { computeDeviceHash, detectUaFamily, issueDeviceCookieValue, DEVICE_COOKIE_NAME } from './device'
import { emitAbuseSignal, hashSessionId } from './signals'
import {
  evaluateSessionConcurrency,
  selectSessionToRevoke,
  type RevocationCandidateSession,
  type SessionConcurrencyConfig,
} from './session-guard'

/** Abstracts better-auth's endpoint `context.getCookie`/`context.setCookie` for testability. */
export interface SessionCookieAdapter {
  get(name: string): string | null
  set(name: string, value: string, options?: Record<string, unknown>): void
}

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

function resolveSecret(): string {
  return env.BETTER_AUTH_SECRET ?? 'dev-secret-change-in-production'
}

function resolveSessionConcurrencyConfig(): SessionConcurrencyConfig {
  return {
    free: env.SESSION_MAX_CONCURRENT_FREE,
    pro: env.SESSION_MAX_CONCURRENT_PRO,
    teamPerSeat: env.SESSION_MAX_CONCURRENT_TEAM_PER_SEAT,
  }
}

export interface SessionBeforeInput {
  userId: string
  userAgent: string | null
}

export interface SessionDeviceResult {
  deviceId: string
  isNewDevice: boolean
}

/**
 * Runs from `databaseHooks.session.create.before` (the session row does not
 * exist yet, so this cannot touch `session_signals`/emit a signal — see
 * `handleSessionAfter` for that). Cookie issuance MUST happen here, not in
 * `after`: `after` fires via better-auth's `queueAfterTransactionHook`, and
 * empirically (verified against a real running dev server with `curl -i`)
 * `context.setCookie` calls made there never reach the outgoing response's
 * `Set-Cookie` header, while the identical call from `before` does.
 */
export async function handleSessionBefore(input: SessionBeforeInput, cookies: SessionCookieAdapter): Promise<SessionDeviceResult> {
  const uaFamily = detectUaFamily(input.userAgent)

  let deviceCookieValue = cookies.get(DEVICE_COOKIE_NAME)
  if (!deviceCookieValue) {
    deviceCookieValue = issueDeviceCookieValue()
    cookies.set(DEVICE_COOKIE_NAME, deviceCookieValue, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ONE_YEAR_SECONDS,
    })
  }
  const deviceHash = computeDeviceHash(deviceCookieValue, uaFamily, resolveSecret())

  // `lastIpAsn` intentionally left unset — it holds a resolved Autonomous
  // System Number (coarser than a raw IP), not the request's IP address
  // itself. No ASN-lookup capability exists yet; it's a separate, later task
  // ("Device/ASN sign-up velocity + linked-account clustering").
  const { device, isNewDevice } = await withTenantContext(
    { userId: input.userId, organizationId: '', role: 'member', requestId: randomUUID() },
    (tx) => upsertUserDevice(tx, {
      id: randomUUID(),
      userId: input.userId,
      deviceHash,
      uaFamily,
    }),
  )

  return { deviceId: device.id, isNewDevice }
}

async function resolveOrganizationTier(organizationId: string | null, userId: string): Promise<string> {
  if (!organizationId) return 'free'
  const rows = await withTenantContext(
    { userId, organizationId, role: 'member', requestId: randomUUID() },
    (tx) => tx.select({ tier: organizationEntitlements.tier }).from(organizationEntitlements)
      .where(eq(organizationEntitlements.organizationId, organizationId))
      .limit(1),
  )
  return rows[0]?.tier ?? 'free'
}

export interface SessionAfterInput {
  id: string
  userId: string
  activeOrganizationId: string | null
  /** Computed by the caller (`better-auth.ts` owns the `auth_sessions` query — see the `security:boundaries` auth-db allowlist). */
  liveSessionCount: number
}

export interface SessionAfterResult {
  /**
   * Non-null only under `ABUSE_ENFORCEMENT_MODE=enforce` when over cap and an
   * older session exists to revoke. `better-auth.ts` owns the actual
   * `auth_sessions` delete (auth-db allowlist) — this module only decides
   * policy (should we revoke, which one), never mutates the row itself.
   */
  revokedSessionId: string | null
}

/**
 * Runs from `databaseHooks.session.create.after`, once the session row (and
 * therefore `session.id`) exists. Writes the `session_signals` row and — when
 * the user's live session count is over their tier's concurrency cap — emits
 * a `concurrent_sessions` abuse signal. Under `observe`/`warn` this only
 * records; under `enforce` it additionally selects the single oldest of the
 * user's *other* live sessions for one-in-one-out revocation (never the
 * session just created) and reports that choice back to the caller — it does
 * not block the sign-in itself, and does not revoke anything when there is no
 * older session to pick (e.g. a race already resolved the over-cap count).
 * `device` is whatever `handleSessionBefore` resolved for this same request.
 */
export async function handleSessionAfter(
  session: SessionAfterInput,
  device: SessionDeviceResult,
  otherLiveSessions: RevocationCandidateSession[],
  /** Defaults to the real env var; injectable so tests can exercise the `enforce` branch without mutating global env. */
  enforcementMode: string = env.ABUSE_ENFORCEMENT_MODE,
): Promise<SessionAfterResult> {
  const secret = resolveSecret()

  await workerDb.insert(sessionSignals).values({
    id: randomUUID(),
    sessionIdHash: hashSessionId(session.id, secret),
    deviceId: device.deviceId,
    newDevice: device.isNewDevice,
  })

  const tier = await resolveOrganizationTier(session.activeOrganizationId, session.userId)
  const { overCap, cap } = evaluateSessionConcurrency({
    tier,
    liveSessionCount: session.liveSessionCount,
    config: resolveSessionConcurrencyConfig(),
  })

  if (!overCap) return { revokedSessionId: null }

  const revocationTarget = enforcementMode === 'enforce'
    ? selectSessionToRevoke(otherLiveSessions)
    : null

  await emitAbuseSignal({
    type: 'concurrent_sessions',
    severity: revocationTarget ? 'high' : 'medium',
    userId: session.userId,
    organizationId: session.activeOrganizationId ?? undefined,
    requestId: randomUUID(),
    details: {
      liveSessionCount: session.liveSessionCount,
      cap,
      tier,
      enforced: Boolean(revocationTarget),
      revokedSessionId: revocationTarget?.id ?? null,
    },
  })

  return { revokedSessionId: revocationTarget?.id ?? null }
}
