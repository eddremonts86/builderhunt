/**
 * Pure Stripe subscription state-machine rules (plans/stripe-billing-platform/tasks.md §6
 * "Implement idempotent monotonic event handlers"; spec.md §Webhook and consistency contract:
 * "Delivery order is not trusted... apply monotonic transitions"). No I/O — every function here
 * takes plain data and returns a plain decision, so the actual "is this transition legal / new
 * enough to apply" logic is exhaustively unit-testable without a database. `webhook-handlers.ts` is
 * the only intended caller.
 */

/** The real Stripe `subscription.status` enum — 8 values. `billing_subscriptions.stripe_status` has no CHECK constraint (unlike `tier`/`interval`), so the raw string is stored as-is; this type exists for the pure decision functions below, not for schema validation. */
export type StripeSubscriptionStatus =
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'paused'

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<StripeSubscriptionStatus>(['canceled', 'incomplete_expired'])

/** Once a subscription reaches a terminal status, no further status transition is legal for that SAME subscription id — Stripe never "reactivates" a canceled/incomplete_expired subscription object; a later resubscribe is always a brand-new subscription id (a new row), never a status flip back on this one. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** An event strictly older than the row's own last-synced timestamp is stale and must be ignored (the row already reflects a later state); an event at or after it is new enough to apply — treating "at" as new enough is what makes re-delivery of the exact same event idempotent rather than an error. */
export function isMonotonicallyNewer(providerSyncedAt: Date, eventTimestamp: Date): boolean {
  return eventTimestamp.getTime() >= providerSyncedAt.getTime()
}

export type SubscriptionTransitionReason = 'first_seen' | 'duplicate' | 'newer' | 'stale' | 'terminal_locked'

export interface SubscriptionTransitionDecision {
  /** Whether the handler should write `incoming`'s values. `false` means: do nothing, this is a safe no-op (never an error). */
  apply: boolean
  reason: SubscriptionTransitionReason
}

export interface CurrentSubscriptionState {
  status: string
  providerSyncedAt: Date
}

export interface IncomingSubscriptionEvent {
  status: string
  eventTimestamp: Date
}

/**
 * The one decision point every subscription-affecting webhook handler calls before writing.
 * `current: null` means this is the first event ever seen for this subscription id (always apply —
 * there is nothing to be newer or staler than yet).
 */
export function resolveSubscriptionTransition(
  current: CurrentSubscriptionState | null,
  incoming: IncomingSubscriptionEvent,
): SubscriptionTransitionDecision {
  if (!current) return { apply: true, reason: 'first_seen' }
  if (isTerminalStatus(current.status)) return { apply: false, reason: 'terminal_locked' }
  if (!isMonotonicallyNewer(current.providerSyncedAt, incoming.eventTimestamp)) {
    return { apply: false, reason: 'stale' }
  }
  if (current.status === incoming.status && current.providerSyncedAt.getTime() === incoming.eventTimestamp.getTime()) {
    // Still "apply" — writing the identical values back is a safe idempotent no-op, not an error,
    // and simplifies the caller (no separate "apply vs skip-but-still-2xx" branch to maintain).
    return { apply: true, reason: 'duplicate' }
  }
  return { apply: true, reason: 'newer' }
}
