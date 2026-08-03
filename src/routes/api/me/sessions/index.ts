import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { inArray } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'
import { hashSessionId } from '~/shared/lib/abuse/signals'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { workerDb } from '~/shared/lib/db/worker-db'
import { sessionSignals } from '~/shared/lib/db/schema'
import { env } from '~/shared/lib/env'
import { listUserDevicesForUser } from '~/shared/lib/repositories/user-devices'

/**
 * Enriched active-sessions list for `/settings/security` — device family,
 * new-device flag, and last-active/current-session status, on top of
 * better-auth's own raw session rows. `session_signals` is system-operational
 * (no RLS, no `builderhunt_app` grant at all — see
 * `drizzle/0044_abuse_usage_integrity_rls_grants.sql`), so this route reads it
 * via `workerDb` directly, filtered to exactly this user's own session-id
 * hashes — the same "worker-role read for a user's own display data" pattern
 * `repositories/abuse-signals.ts`'s `listAbuseSignalsForUser` already
 * establishes. `user_devices` IS granted to `builderhunt_app` (account-subject,
 * RLS on `app.user_id`), so that read goes through the normal tenant context.
 *
 * "Coarse location" isn't included yet — no ASN/geo-lookup capability exists
 * yet (a separate, later task), so it would only ever be null right now.
 *
 * Revoking a session ("Sign out" / "Sign out everywhere else") goes straight
 * through better-auth's own client (`authClient.revokeSession`/
 * `revokeOtherSessions`) from the browser — no custom route needed for that.
 */
export const Route = createFileRoute('/api/me/sessions/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          const authSession = await auth.api.getSession({ headers: request.headers })
          if (!authSession?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })

          const sessions = await auth.api.listSessions({ headers: request.headers })
          const secret = env.BETTER_AUTH_SECRET ?? 'dev-secret-change-in-production'
          const hashBySessionId = new Map(sessions.map((session) => [session.id, hashSessionId(session.id, secret)]))

          const signalRows = hashBySessionId.size > 0
            ? await workerDb.select({
                sessionIdHash: sessionSignals.sessionIdHash,
                deviceId: sessionSignals.deviceId,
                newDevice: sessionSignals.newDevice,
              }).from(sessionSignals)
              .where(inArray(sessionSignals.sessionIdHash, [...hashBySessionId.values()]))
            : []
          const signalByHash = new Map(signalRows.map((row) => [row.sessionIdHash, row]))

          const devices = await withTenantContext(
            { userId: authSession.user.id, organizationId: '', role: 'member', requestId: crypto.randomUUID() },
            (tx) => listUserDevicesForUser(tx, authSession.user.id),
          )
          const deviceById = new Map(devices.map((device) => [device.id, device]))

          const enriched = sessions.map((session) => {
            const hash = hashBySessionId.get(session.id)
            const signal = hash ? signalByHash.get(hash) : undefined
            const device = signal?.deviceId ? deviceById.get(signal.deviceId) : undefined
            return {
              id: session.id,
              token: session.token,
              isCurrent: session.id === authSession.session.id,
              createdAt: session.createdAt,
              lastActiveAt: session.updatedAt,
              uaFamily: device?.uaFamily ?? null,
              trustState: device?.trustState ?? null,
              isNewDevice: signal?.newDevice ?? null,
              country: null as string | null,
            }
          }).sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())

          return Response.json(enriched)
        } catch (err) {
          console.error('active sessions list error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
