import { and, desc, gte, isNotNull } from 'drizzle-orm'
import { authDb } from '../db/auth-db'
import { authSessions } from '../db/schema'

/**
 * Narrow, read-only worker access to `auth_sessions.ip_address` — better-auth's own table, no
 * `builderhunt_app`/`builderhunt_worker` grant post auth-broker (`drizzle/0007_auth_broker.sql`).
 * Reads via `authDb` directly, the same narrow-repo-file exception already established for
 * `repositories/account-privacy.ts`/`repositories/alerts-worker.ts` (see
 * `scripts/check-tenant-boundaries.mjs`'s `authDbAllowlist`) — a single-purpose file rather than
 * opening `auth-db` up to every abuse/ module. Used by `abuse/linked-accounts.ts`'s cross-user
 * IP-sharing dimension. Bounded by `sinceDate`/`limit`, never an unbounded scan.
 */
export interface SessionIpRecord {
  userId: string
  ipAddress: string
  createdAt: Date
}

export async function listRecentSessionIps(sinceDate: Date, limit = 5000): Promise<SessionIpRecord[]> {
  const rows = await authDb
    .select({ userId: authSessions.userId, ipAddress: authSessions.ipAddress, createdAt: authSessions.createdAt })
    .from(authSessions)
    .where(and(isNotNull(authSessions.ipAddress), gte(authSessions.createdAt, sinceDate)))
    .orderBy(desc(authSessions.createdAt))
    .limit(limit)
  return rows.filter((row): row is SessionIpRecord => row.ipAddress !== null)
}
