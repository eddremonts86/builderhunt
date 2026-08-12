import { eq, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { platformDb } from '../db/client'
import { platformBetaMode } from '../db/schema'

/**
 * The global beta-mode switch (plan 58).
 *
 * ## Two readers, because they answer different questions
 *
 * **Authorization** must read the row inside the caller's own transaction. It decides whether a
 * provider call happens and whether credits are spent, so it can never depend on Redis, a process
 * cache, or a value read a few seconds ago in a different request. `getBetaModeState(transaction)` is
 * that read.
 *
 * **The badge in the user menu** is a label. It may be five seconds stale and nothing breaks, so it
 * gets its own cached read and degrades to "off" if it fails. `getCachedBetaModeStatus()` is that one.
 *
 * Collapsing them into a single cached read is the mistake worth naming: it makes disabling beta mode
 * take effect *eventually*, which means work authorized under the old state can still commit after an
 * operator believes they have stopped it.
 *
 * ## The lock, and what it buys
 *
 * Both the authoritative read and the admin write take an advisory lock in a beta-mode-specific
 * namespace — shared for readers, exclusive for the writer. So `setBetaModeState` waits for in-flight
 * authorizations to finish, and once it returns, no reservation authorized against the previous state
 * can still commit. Without it, disable is racy in exactly the direction that costs money.
 */

/** A namespace of its own, so this lock can never collide with the migration or reservation locks. */
const BETA_MODE_LOCK_KEY = 0x62657461 // 'beta'

export interface BetaModeState {
  enabled: boolean
  revision: number
  updatedAt: Date
  updatedBy: string | null
}

/** A missing row is disabled — never an error, and never "enabled by default". */
const DISABLED: BetaModeState = {
  enabled: false,
  revision: 0,
  updatedAt: new Date(0),
  updatedBy: null,
}

/**
 * Thrown when the setting cannot be read.
 *
 * A typed error rather than a silent `false`: the caller has to decide, and for provider work the right
 * decision is to refuse. Answering "disabled" on a database error would quietly deny paid customers
 * their beta access and look like the flag being off.
 */
export class BetaModeUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Beta mode state could not be read')
    this.name = 'BetaModeUnavailableError'
    this.cause = cause
  }
}

/**
 * The authoritative read, inside the caller's transaction.
 *
 * Takes a **shared** advisory lock first, so a concurrent disable waits for this authorization rather
 * than landing between the read and the work it authorizes.
 */
export async function getBetaModeState(transaction: TenantTransaction): Promise<BetaModeState> {
  try {
    await transaction.execute(sql`select pg_advisory_xact_lock_shared(${BETA_MODE_LOCK_KEY})`)
    const rows = await transaction
      .select({
        enabled: platformBetaMode.enabled,
        revision: platformBetaMode.revision,
        updatedAt: platformBetaMode.updatedAt,
        updatedBy: platformBetaMode.updatedBy,
      })
      .from(platformBetaMode)
      .where(eq(platformBetaMode.id, 'global'))
      // One row by construction — `id` is the primary key and a CHECK pins it to 'global'.
      .limit(1)
    return rows[0] ?? DISABLED
  } catch (error) {
    /**
     * Deliberately not swallowed.
     *
     * A PostgreSQL statement error also **aborts the transaction**, so a caller that caught this and
     * carried on would issue every later statement against an aborted transaction and fail somewhere
     * unrelated. Throwing here keeps the failure where its cause is.
     */
    throw new BetaModeUnavailableError(error)
  }
}

/** The same read for the platform-admin API, which has no tenant transaction to borrow. */
export async function getPlatformBetaModeState(): Promise<BetaModeState> {
  const rows = await platformDb
    .select({
      enabled: platformBetaMode.enabled,
      revision: platformBetaMode.revision,
      updatedAt: platformBetaMode.updatedAt,
      updatedBy: platformBetaMode.updatedBy,
    })
    .from(platformBetaMode)
    .where(eq(platformBetaMode.id, 'global'))
    .limit(1)
  return rows[0] ?? DISABLED
}

/**
 * A five-second in-process cache for the badge only.
 *
 * Per-process, so behind more than one instance the badge can lag by up to five seconds on one of them.
 * That is acceptable for a label and stated rather than hidden. Authorization never reads this.
 */
let cached: { at: number; value: Pick<BetaModeState, 'enabled' | 'revision' | 'updatedAt'> } | null = null
const CACHE_TTL_MS = 5_000

export async function getCachedBetaModeStatus(
  now: () => number = Date.now,
): Promise<Pick<BetaModeState, 'enabled' | 'revision' | 'updatedAt'>> {
  const at = now()
  if (cached && at - cached.at < CACHE_TTL_MS) return cached.value
  try {
    const state = await getPlatformBetaModeState()
    cached = { at, value: { enabled: state.enabled, revision: state.revision, updatedAt: state.updatedAt } }
    return cached.value
  } catch (error) {
    // A badge that fails to load shows nothing. It must not take the dashboard with it.
    console.warn('[beta-mode] display read failed, treating as disabled:', error instanceof Error ? error.message : error)
    return { enabled: false, revision: 0, updatedAt: new Date(0) }
  }
}

/** Cleared on every write so the operator who flipped it does not keep seeing the old badge. */
export function invalidateBetaModeCache(): void {
  cached = null
}

export class BetaModeRevisionConflictError extends Error {
  constructor(readonly current: BetaModeState) {
    super('Beta mode was changed by someone else')
    this.name = 'BetaModeRevisionConflictError'
  }
}

/**
 * An explicit desired state, never a blind toggle.
 *
 * A toggle sent from a stale screen inverts whatever is there *now*, which is how two operators
 * clicking "disable" thirty seconds apart end up with it enabled. So the caller states `enabled` and
 * the revision it believes it saw.
 *
 * A same-state request is an idempotent no-op that does **not** bump the revision — otherwise two
 * clicks on "enable" would invalidate every other open screen for no change.
 */
export async function setBetaModeState(input: {
  enabled: boolean
  expectedRevision: number
  updatedBy: string
}): Promise<BetaModeState> {
  return platformDb.transaction(async (tx) => {
    // Exclusive, and taken before the row lock: this is what makes disable wait for already-authorized
    // work instead of racing it.
    await tx.execute(sql`select pg_advisory_xact_lock(${BETA_MODE_LOCK_KEY})`)

    const rows = await tx
      .select({
        enabled: platformBetaMode.enabled,
        revision: platformBetaMode.revision,
        updatedAt: platformBetaMode.updatedAt,
        updatedBy: platformBetaMode.updatedBy,
      })
      .from(platformBetaMode)
      .where(eq(platformBetaMode.id, 'global'))
      .for('update')
      .limit(1)

    const current = rows[0] ?? DISABLED
    if (current.revision !== input.expectedRevision) {
      throw new BetaModeRevisionConflictError(current)
    }
    if (current.enabled === input.enabled) return current

    const [updated] = await tx
      .update(platformBetaMode)
      .set({
        enabled: input.enabled,
        revision: current.revision + 1,
        updatedAt: new Date(),
        updatedBy: input.updatedBy,
      })
      .where(eq(platformBetaMode.id, 'global'))
      .returning({
        enabled: platformBetaMode.enabled,
        revision: platformBetaMode.revision,
        updatedAt: platformBetaMode.updatedAt,
        updatedBy: platformBetaMode.updatedBy,
      })

    invalidateBetaModeCache()
    return updated ?? current
  })
}
