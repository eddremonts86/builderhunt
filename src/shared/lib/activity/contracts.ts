// Plan 29 (activity-feed) task 1 — versioned event + redaction registry.
//
// The activity feed is a denormalized event log. Every event has a
// versioned `type`, a criticality flag (transaction-critical events
// roll back the originating mutation on emit failure; informational
// events do not), a zod schema for the display metadata, and a
// deterministic idempotency key so a retry of the same logical
// operation is a no-op.
//
// The registry is the single place to add new event types. Each
// type is allowlisted at module load; anything else is rejected
// before it ever reaches the DB or the audit log.
//
// Redaction: every schema rejects known sensitive canaries
// (email-like strings, raw tokens, "BEGIN PRIVATE" markers, etc.)
// so a future event type cannot accidentally leak a note, query,
// or contact field into the feed. The formatter is also pinned
// per-type so a UI that knows the version renders the right
// fields, and a future migration of the version renders the new
// fields without ambiguity.

import { z } from 'zod'

export type EventCriticality = 'transaction_critical' | 'informational'

export type TargetIntegrity = 'soft' | 'hard'
// soft: emit only — the referenced target may have been deleted by
// the time the feed is read; the row is preserved.
// hard: the live target must exist at emit time; onDelete restrict
// (or nullify, depending on the target) holds the line.

export interface ActivityEventDefinition<T extends z.ZodTypeAny> {
  type: string
  version: number
  criticality: EventCriticality
  target: TargetIntegrity
  /** zod schema for the display metadata. */
  metadata: T
  /** human-readable formatter, used by the UI and by the test. */
  format: (parsed: z.infer<T>) => string
  /** retention in days; null = forever (until the worker prunes). */
  retentionDays: number | null
}

const sensitiveCanaries = [
  // Heuristic: "@" with a dot somewhere after — email-like.
  /@.+\..+/,
  // Long opaque tokens.
  /[A-Za-z0-9_-]{40,}/,
  // Private markers.
  /BEGIN PRIVATE/i,
  /PRIVATE NOTE/i,
  // Full name + email in the same string.
  /@/,
]

function noSensitiveCanaries(input: unknown): boolean {
  if (typeof input === 'string') {
    for (const re of sensitiveCanaries) {
      if (re.test(input)) return false
    }
    return true
  }
  if (Array.isArray(input)) return input.every(noSensitiveCanaries)
  if (input && typeof input === 'object') {
    return Object.values(input).every(noSensitiveCanaries)
  }
  return true
}

// ── Allowed metadata shapes ────────────────────────────────────────────

export const SavedQueryCreatedMetadata = z.object({
  queryId: z.string().min(1).max(64),
  queryName: z.string().min(1).max(120),
  visibility: z.enum(['private', 'organization']),
}).strict().refine(noSensitiveCanaries, { message: 'metadata contains a sensitive canary' })

export const SavedQueryVisibilityChangedMetadata = z.object({
  queryId: z.string().min(1).max(64),
  queryName: z.string().min(1).max(120),
  from: z.enum(['private', 'organization']),
  to: z.enum(['private', 'organization']),
}).strict().refine(noSensitiveCanaries, { message: 'metadata contains a sensitive canary' })

export const SavedQueryDeletedMetadata = z.object({
  queryId: z.string().min(1).max(64),
  queryName: z.string().min(1).max(120),
}).strict().refine(noSensitiveCanaries, { message: 'metadata contains a sensitive canary' })

export const BuilderListCreatedMetadata = z.object({
  listId: z.string().min(1).max(64),
  listName: z.string().min(1).max(120),
  visibility: z.enum(['private', 'organization']),
}).strict().refine(noSensitiveCanaries, { message: 'metadata contains a sensitive canary' })

export const BuilderListItemAddedMetadata = z.object({
  listId: z.string().min(1).max(64),
  listName: z.string().min(1).max(120),
  builderIdentityId: z.string().min(1).max(64),
}).strict().refine(noSensitiveCanaries, { message: 'metadata contains a sensitive canary' })

export const BuilderListItemRemovedMetadata = z.object({
  listId: z.string().min(1).max(64),
  listName: z.string().min(1).max(120),
  builderIdentityId: z.string().min(1).max(64),
}).strict().refine(noSensitiveCanaries, { message: 'metadata contains a sensitive canary' })

export const BuilderListDeletedMetadata = z.object({
  listId: z.string().min(1).max(64),
  listName: z.string().min(1).max(120),
}).strict().refine(noSensitiveCanaries, { message: 'metadata contains a sensitive canary' })

export const AlertCreatedMetadata = z.object({
  alertId: z.string().min(1).max(64),
  alertName: z.string().min(1).max(120),
  source: z.enum(['manual', 'shared_query']),
  queryId: z.string().min(1).max(64).optional(),
}).strict().refine(noSensitiveCanaries, { message: 'metadata contains a sensitive canary' })

export const FeedCapabilityMintedMetadata = z.object({
  capabilityId: z.string().min(1).max(64),
  queryId: z.string().min(1).max(64),
  queryName: z.string().min(1).max(120),
}).strict().refine(noSensitiveCanaries, { message: 'metadata contains a sensitive canary' })

export const FeedCapabilityRevokedMetadata = z.object({
  capabilityId: z.string().min(1).max(64),
  queryId: z.string().min(1).max(64),
  queryName: z.string().min(1).max(120),
}).strict().refine(noSensitiveCanaries, { message: 'metadata contains a sensitive canary' })

// ── Registry ───────────────────────────────────────────────────────────

export const ACTIVITY_EVENTS = {
  saved_query_created: {
    type: 'saved_query_created',
    version: 1,
    criticality: 'transaction_critical',
    target: 'hard',
    metadata: SavedQueryCreatedMetadata,
    format: (m: z.infer<typeof SavedQueryCreatedMetadata>) => `Created search "${m.queryName}"`,
    retentionDays: 365,
  },
  saved_query_visibility_changed: {
    type: 'saved_query_visibility_changed',
    version: 1,
    criticality: 'transaction_critical',
    target: 'hard',
    metadata: SavedQueryVisibilityChangedMetadata,
    format: (m: z.infer<typeof SavedQueryVisibilityChangedMetadata>) => `Changed "${m.queryName}" from ${m.from} to ${m.to}`,
    retentionDays: 365,
  },
  saved_query_deleted: {
    type: 'saved_query_deleted',
    version: 1,
    criticality: 'transaction_critical',
    target: 'soft',
    metadata: SavedQueryDeletedMetadata,
    format: (m: z.infer<typeof SavedQueryDeletedMetadata>) => `Deleted search "${m.queryName}"`,
    retentionDays: 365,
  },
  builder_list_created: {
    type: 'builder_list_created',
    version: 1,
    criticality: 'transaction_critical',
    target: 'hard',
    metadata: BuilderListCreatedMetadata,
    format: (m: z.infer<typeof BuilderListCreatedMetadata>) => `Created shortlist "${m.listName}"`,
    retentionDays: 365,
  },
  builder_list_item_added: {
    type: 'builder_list_item_added',
    version: 1,
    criticality: 'transaction_critical',
    target: 'hard',
    metadata: BuilderListItemAddedMetadata,
    format: (m: z.infer<typeof BuilderListItemAddedMetadata>) => `Added a builder to "${m.listName}"`,
    retentionDays: 365,
  },
  builder_list_item_removed: {
    type: 'builder_list_item_removed',
    version: 1,
    criticality: 'transaction_critical',
    target: 'hard',
    metadata: BuilderListItemRemovedMetadata,
    format: (m: z.infer<typeof BuilderListItemRemovedMetadata>) => `Removed a builder from "${m.listName}"`,
    retentionDays: 365,
  },
  builder_list_deleted: {
    type: 'builder_list_deleted',
    version: 1,
    criticality: 'transaction_critical',
    target: 'soft',
    metadata: BuilderListDeletedMetadata,
    format: (m: z.infer<typeof BuilderListDeletedMetadata>) => `Deleted shortlist "${m.listName}"`,
    retentionDays: 365,
  },
  alert_created: {
    type: 'alert_created',
    version: 1,
    criticality: 'transaction_critical',
    target: 'hard',
    metadata: AlertCreatedMetadata,
    format: (m: z.infer<typeof AlertCreatedMetadata>) => m.source === 'shared_query'
      ? `Opted into alert "${m.alertName}" from a shared search`
      : `Created alert "${m.alertName}"`,
    retentionDays: 365,
  },
  feed_capability_minted: {
    type: 'feed_capability_minted',
    version: 1,
    criticality: 'transaction_critical',
    target: 'hard',
    metadata: FeedCapabilityMintedMetadata,
    format: (m: z.infer<typeof FeedCapabilityMintedMetadata>) => `Shared RSS feed for "${m.queryName}"`,
    retentionDays: 90,
  },
  feed_capability_revoked: {
    type: 'feed_capability_revoked',
    version: 1,
    criticality: 'transaction_critical',
    target: 'soft',
    metadata: FeedCapabilityRevokedMetadata,
    format: (m: z.infer<typeof FeedCapabilityRevokedMetadata>) => `Revoked RSS feed for "${m.queryName}"`,
    retentionDays: 90,
  },
} as const

export type ActivityEventType = keyof typeof ACTIVITY_EVENTS

export function isKnownEventType(type: string): type is ActivityEventType {
  return type in ACTIVITY_EVENTS
}

export function getEventDefinition(type: ActivityEventType) {
  return ACTIVITY_EVENTS[type]
}

/**
 * Deterministic idempotency key. The same logical operation
 * (same actor + same target + same type + same business day) is a
 * no-op on retry. The day-bucket keeps each row unique across
 * retries of the same day but separate across days, which is
 * what the spec asks for: a user creating the same query twice
 * in the same day emits one event, not two.
 */
export function idempotencyKey(
  type: ActivityEventType,
  organizationId: string,
  actorUserId: string,
  targetKey: string,
  at: Date = new Date(),
): string {
  const day = at.toISOString().slice(0, 10) // YYYY-MM-DD
  return `${type}::${organizationId}::${actorUserId}::${targetKey}::${day}`
}
