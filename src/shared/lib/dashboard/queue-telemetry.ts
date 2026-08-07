/**
 * Wave 2 task 5 — privacy-safe queue telemetry.
 *
 * Events the action queue emits. Every event is built from a closed
 * schema so a server cannot capture unanticipated fields by mistake.
 * The schema rejects resource IDs, candidate data, free text, and
 * organization labels — a structural guarantee that the analyzer can
 * scan for accidental inclusion of sensitive markers.
 *
 * The five event kinds are:
 *   - `action-queue.render`     — queue rendered (per page load)
 *   - `action-queue.continuation` — user clicked the primary action link
 *   - `action-queue.dismiss`    — user clicked the secondary dismiss action
 *   - `action-queue.resolved`   — server confirmed a row is resolved
 *   - `action-queue.unknown`    — a kind this build does not know how to route
 *
 * Every event carries at most the action kind, the position in the
 * queue, and the rule id. Never the resource id, never the title,
 * never the detail. The rule id is a stable string already used for
 * keying; it is not a user identifier.
 *
 * Telemetry failure never blocks the action: the helper is best-effort
 * and silent on error. The action queue never blocks on a failed POST.
 */
import { z } from 'zod'
import { DASHBOARD_ACTION_KINDS } from '~/shared/lib/dashboard/contracts'

/** Closed allowlist of telemetry kinds. Adding a kind is an ADR. */
export const QUEUE_TELEMETRY_KINDS = [
  'action-queue.render',
  'action-queue.continuation',
  'action-queue.dismiss',
  'action-queue.resolved',
  'action-queue.unknown',
] as const
export type QueueTelemetryKind = (typeof QUEUE_TELEMETRY_KINDS)[number]

/**
 * Position in the queue, 0-indexed. Bounded at the same cap the queue
 * itself enforces (50 items, see contracts.ts DASHBOARD_ROW_LIMITS).
 * Positions are coarse-grained enough that two rows at the same
 * severity/due-time do not leak per-user triage behaviour.
 */
export const queuePositionSchema = z.number().int().min(0).max(50)

/**
 * Rule ids are stable strings from `action-rules.ts`. They identify
 * the *kind of problem*, not the underlying resource, so they are safe
 * to surface. We accept any printable string up to a 64-char cap rather
 * than enum-listing them: the rule registry is the source of truth,
 * and a rule's id change is a code change that ships a fresh cap.
 */
export const queueRuleIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]+$/, 'rule id must be kebab-case')

/**
 * Allowlisted action kinds. The closed DASHBOARD_ACTION_KINDS enum
 * already exists; we reuse it so a new action kind requires both a
 * widget kind and a telemetry kind in the same commit.
 */
export const queueActionKindSchema = z.enum(DASHBOARD_ACTION_KINDS)

/**
 * The privacy contract. The 8 forbidden markers from
 * admin-contracts.ts are also banned from telemetry, but the field
 * shape itself rules out the obvious ones (no resource id, no email,
 * no title, no detail) so this schema is the structural guarantee.
 */
export const queueTelemetryEventSchema = z.object({
  kind: z.enum(QUEUE_TELEMETRY_KINDS),
  position: queuePositionSchema,
  ruleId: queueRuleIdSchema,
  actionKind: queueActionKindSchema,
  /** Generated timestamp, server-set or client-set. ISO-8601 with offset. */
  at: z.iso.datetime(),
})
.strict()

/**
 * Marker list a build pipeline can grep for. Any telemetry payload that
 * contains one of these literals fails closed at parse time.
 */
export const FORBIDDEN_TELEMETRY_MARKERS = [
  'memberEmail',
  'candidateEmail',
  'productivityScore',
  'rank',
  'sessionDetail',
  'individualAdoption',
  'searchContent',
  'noteContent',
  'resourceId',
  'resourceKey',
  'organizationId',
  'tenantId',
  'userId',
  'freeText',
  'title',
  'detail',
] as const

/**
 * Build a telemetry event. Returns `null` on validation failure rather
 * than throwing — the action queue must never block on a telemetry
 * call. The caller can log the parse failure locally; the helper does
 * not raise.
 */
export function buildQueueTelemetryEvent(input: {
  kind: QueueTelemetryKind
  position: number
  ruleId: string
  actionKind: (typeof DASHBOARD_ACTION_KINDS)[number]
  now: Date
}): z.infer<typeof queueTelemetryEventSchema> | null {
  const candidate = {
    kind: input.kind,
    position: input.position,
    ruleId: input.ruleId,
    actionKind: input.actionKind,
    at: input.now.toISOString(),
  }
  const result = queueTelemetryEventSchema.safeParse(candidate)
  if (!result.success) return null
  // Defence-in-depth: even if the schema accepts a payload, a payload
  // that contains any of the 16 forbidden literals is rejected. This
  // catches future field additions that survive the schema but reach
  // the JSON serializer with sensitive text.
  const json = JSON.stringify(result.data)
  for (const marker of FORBIDDEN_TELEMETRY_MARKERS) {
    if (json.includes(marker)) return null
  }
  return result.data
}

/**
 * Fire-and-forget telemetry sender. Failures are silent: the queue
 * continues even if the request fails. The endpoint is intentionally
 * permissive (a future write-up can add real fan-out) and rate-limited
 * server-side.
 */
export async function sendQueueTelemetry(
  endpoint: string,
  event: z.infer<typeof queueTelemetryEventSchema>,
): Promise<void> {
  try {
    await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      keepalive: true,
    })
  } catch {
    // Silent: telemetry must never block the action.
  }
}
