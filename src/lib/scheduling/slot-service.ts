/**
 * Bookable-slot derivation for a public invitation (plan:
 * calendar-scheduling-interview-intelligence, Phase 5 "Implement slot-query service").
 *
 * This module is **only** I/O orchestration. The arithmetic — DST handling, buffers, minimum
 * notice, horizon, busy subtraction, opaque slot ids — already lives in
 * `shared/lib/scheduling.ts` (`generateAvailabilitySlots`), shipped in Phase 1 as a pure contract.
 * Do not reimplement any of it here; load the inputs, call it, and shape the output.
 *
 * Two properties this layer is responsible for, which the pure function cannot enforce:
 *
 * 1. **No conflict-source leakage.** A candidate learns only *that* a time is unavailable, never
 *    why. The organizer's other meetings, their titles, their attendees and even their existence
 *    stay invisible: `listBusyRanges` selects start/end only, and the response carries slots and
 *    nothing else. `spec.md` calls this out explicitly, and it is the reason this service returns a
 *    bare slot array rather than anything resembling a calendar.
 * 2. **A bounded window.** The requested range is clamped to the policy horizon *and* to a hard
 *    ceiling here, so a crafted `?from=1970&to=2999` cannot turn a public unauthenticated endpoint
 *    into an expensive scan.
 */
import type { TenantTransaction } from '~/shared/lib/db/client'
import { listBusyRanges } from '~/shared/lib/repositories/calendar'
import {
  findAvailabilityPolicy,
  listAvailabilityOverrides,
  listAvailabilityRules,
} from '~/shared/lib/repositories/scheduling'
import type { AvailabilitySlot } from '~/shared/lib/scheduling'
import { generateAvailabilitySlots } from '~/shared/lib/scheduling'

/**
 * Hard ceiling on how much wall-clock a single public query may span, independent of the owner's
 * horizon. 62 days covers "show me the next two months" without letting an anonymous caller ask
 * for a decade.
 */
export const MAX_SLOT_RANGE_DAYS = 62

export interface SlotQuery {
  organizationId: string
  ownerUserId: string
  /** The invitation's duration. Slots shorter than the interview are not offered. */
  durationMinutes: number
  from: Date
  to: Date
  now?: Date
}

export interface SlotQueryResult {
  slots: AvailabilitySlot[]
  /** The window actually used after clamping, so a caller can tell the user what it looked at. */
  effectiveRange: { from: Date; to: Date }
  /**
   * The availability policy version the slots were derived from. A booking request carries it back
   * so `booking-service.ts` can detect that the organizer changed their availability in between
   * and recompute rather than trusting a stale slot id.
   */
  policyVersion: number | null
}

function clampRange(from: Date, to: Date): { from: Date; to: Date } {
  const start = from
  const ceiling = new Date(start.getTime() + MAX_SLOT_RANGE_DAYS * 24 * 60 * 60_000)
  return { from: start, to: to < ceiling ? to : ceiling }
}

/**
 * Derives the slots a candidate may pick for this invitation.
 *
 * Returns an empty list — never an error — when the organizer has no availability configured, no
 * enabled rule, or nothing free in the window. From the candidate's side "no times available" and
 * "this organizer never set up availability" must look identical; distinguishing them would leak
 * organizer state to an unauthenticated caller.
 */
export async function querySlots(
  transaction: TenantTransaction,
  query: SlotQuery,
): Promise<SlotQueryResult> {
  const now = query.now ?? new Date()
  const effectiveRange = clampRange(query.from, query.to)

  if (effectiveRange.to <= effectiveRange.from) {
    return { slots: [], effectiveRange, policyVersion: null }
  }

  const [policy, rules, overrides] = await Promise.all([
    findAvailabilityPolicy(transaction, query.organizationId, query.ownerUserId),
    listAvailabilityRules(transaction, query.organizationId, query.ownerUserId),
    listAvailabilityOverrides(transaction, query.organizationId, query.ownerUserId),
  ])

  const enabledRules = rules.filter((rule) => rule.enabled)
  if (enabledRules.length === 0) {
    return { slots: [], effectiveRange, policyVersion: policy?.version ?? null }
  }

  // Start/end only — see the no-leakage note in the module header.
  const busyRanges = await listBusyRanges(transaction, query.organizationId, query.ownerUserId, effectiveRange)

  const overrideDtos = overrides.map((override) => ({
    ownerUserId: query.ownerUserId,
    localDate: override.localDate,
    localStart: override.localStart ? override.localStart.slice(0, 5) : null,
    localEnd: override.localEnd ? override.localEnd.slice(0, 5) : null,
    kind: override.kind as 'available' | 'blocked',
    timeZone: override.timezone,
  }))

  // One rule can describe several weekdays, but a distinct rule row may carry different slot
  // settings, so each is expanded independently and the results merged. Duplicate start times
  // across rules are collapsed by slot id, which is derived from owner + start + end.
  const bySlotId = new Map<string, AvailabilitySlot>()
  for (const rule of enabledRules) {
    const generated = generateAvailabilitySlots({
      ownerUserId: query.ownerUserId,
      rule: {
        ownerUserId: query.ownerUserId,
        timeZone: rule.timezone,
        weekdays: rule.weekdays,
        localStart: rule.localStart.slice(0, 5),
        localEnd: rule.localEnd.slice(0, 5),
        // The interview length wins over the rule's generic slot size: a 45-minute interview must
        // not be offered in a 30-minute hole.
        slotMinutes: Math.max(rule.slotMinutes, query.durationMinutes),
        bufferBeforeMinutes: rule.bufferBeforeMinutes,
        bufferAfterMinutes: rule.bufferAfterMinutes,
        minNoticeMinutes: rule.minNoticeMinutes,
        horizonDays: rule.horizonDays,
        enabled: rule.enabled,
      },
      overrides: overrideDtos,
      busyRanges: busyRanges.map((range) => ({ start: range.start, end: range.end })),
      rangeFrom: effectiveRange.from,
      rangeTo: effectiveRange.to,
      now,
    })
    for (const slot of generated) bySlotId.set(slot.slotId, slot)
  }

  const slots = [...bySlotId.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  return { slots, effectiveRange, policyVersion: policy?.version ?? null }
}
