/**
 * Turns a capability secret into a tenant-scoped transaction (plan:
 * calendar-scheduling-interview-intelligence, Phase 5 "Add public invitation and booking APIs").
 *
 * Every public scheduling route starts here, and the ordering inside `withCapabilityContext` is the
 * security boundary for the accountless flow:
 *
 *   1. Filter the presented secret in application code (`hashCapability(..., { strict: true })`).
 *      Malformed input never reaches the database, so it cannot be used to probe it, and a
 *      malformed secret takes exactly the same "unknown" path as a well-formed wrong one.
 *   2. Resolve the tenant through `scheduling_resolve_capability` (drizzle/0077) — the one narrowly
 *      privileged command in this flow. It answers with three ids and nothing else.
 *   3. Only then set `app.organization_id` for the rest of the transaction, so every subsequent
 *      query runs under ordinary RLS with the correct tenant. Nothing after step 2 is privileged.
 *
 * All three happen inside one transaction. Splitting them would leave a window in which the resolved
 * tenant no longer matches the row the work is about.
 */
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { workerDb, type WorkerTransaction } from '~/shared/lib/db/worker-db'
import { hashCapability } from './capability'

export interface CapabilityTenant {
  organizationId: string
  ownerUserId: string
  invitationId: string
  /** The hash the secret resolved to. Handy for the repository lookups that key on it; never returned to a caller. */
  capabilityHash: string
}

export type CapabilityContextResult<T> =
  | { ok: true; value: T; tenant: CapabilityTenant }
  /** One code for every reason a capability did not resolve. See the note in `resolveTenant`. */
  | { ok: false; code: 'invitation_unavailable' }

/**
 * Runs `operation` inside a transaction scoped to the invitation the secret belongs to.
 *
 * Returns a single failure code for a malformed secret, an unknown secret, and a secret whose
 * invitation was revoked or deleted. spec.md requires non-enumerating responses: distinguishing
 * these would let someone with one valid link discover whether other ids exist, and telling a
 * candidate "revoked" rather than "unknown" leaks the organizer's decision to whoever holds the
 * forwarded email.
 */
export async function withCapabilityContext<T>(
  secret: string,
  operation: (transaction: WorkerTransaction, tenant: CapabilityTenant) => Promise<T>,
  options: { invitationId?: string; db?: PostgresJsDatabase | typeof workerDb } = {},
): Promise<CapabilityContextResult<T>> {
  const capabilityHash = hashCapability(secret, { strict: true })
  if (!capabilityHash) return { ok: false, code: 'invitation_unavailable' }

  const database = options.db ?? workerDb
  return database.transaction(async (transaction) => {
    const rows = await transaction.execute(sql`
      select organization_id, owner_user_id, invitation_id
      from scheduling_resolve_capability(${capabilityHash})
    `) as unknown as { organization_id: string; owner_user_id: string; invitation_id: string }[]

    const row = rows[0]
    if (!row) return { ok: false as const, code: 'invitation_unavailable' as const }

    /**
     * The route's URL says which invitation it is about; the cookie says which one the browser holds
     * a capability for. If they disagree, the request is either a bug or an attempt to reuse one
     * capability against another invitation, and neither should be served. The cookie is path-scoped
     * so a browser will not normally do this, but the check does not depend on the browser being
     * correct.
     */
    if (options.invitationId && options.invitationId !== row.invitation_id) {
      return { ok: false as const, code: 'invitation_unavailable' as const }
    }

    const tenant: CapabilityTenant = {
      organizationId: row.organization_id,
      ownerUserId: row.owner_user_id,
      invitationId: row.invitation_id,
      capabilityHash,
    }

    await transaction.execute(sql`
      select
        set_config('app.organization_id', ${tenant.organizationId}, true),
        set_config('app.organization_role', 'worker', true),
        set_config('app.request_id', ${randomUUID()}, true)
    `)

    const value = await operation(transaction as WorkerTransaction, tenant)
    return { ok: true as const, value, tenant }
  }) as Promise<CapabilityContextResult<T>>
}
