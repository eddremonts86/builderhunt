import type { TenantTransaction } from '~/shared/lib/db/client'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { can } from '~/shared/lib/authorization/permissions'
import {
  isValidIanaTimeZone,
  MAX_AVAILABILITY_HORIZON_DAYS,
  normalizeAvailabilityRules,
  type AvailabilityOverrideInput,
  type AvailabilityRuleInput,
} from '~/shared/lib/scheduling'
import {
  findAvailabilityPolicy,
  listAvailabilityOverrides,
  listAvailabilityRules,
  replaceAvailabilityPolicy,
  upsertAvailabilityPolicyWithVersion,
} from '~/shared/lib/repositories/scheduling'

/**
 * Availability policy service (plan: calendar-scheduling-interview-intelligence, Phase 3 "Add
 * availability APIs").
 *
 * Availability is strictly first-person: you read and write your own, and there is no path — not
 * even for an org admin — to read or change someone else's. `scheduling:manage` in
 * `permissions.ts` already encodes that (it never consults `elevated`), and the RLS policy on all
 * three tables re-checks `owner_user_id` independently. This module is the third layer, and it
 * enforces the same thing structurally: the owner is taken from the principal and there is no
 * request field that could name anyone else.
 */

export class AvailabilityError extends Error {
  constructor(message: string, readonly code: 'invalid_input' | 'forbidden' | 'state_changed') {
    super(message)
    this.name = 'AvailabilityError'
  }
}

export interface AvailabilityPolicyView {
  rules: AvailabilityRuleInput[]
  overrides: AvailabilityOverrideInput[]
  defaultReminderOffsets: number[]
  defaultReminderChannels: string[]
  version: number
}

/** Maps persisted rows back to the wire DTO shape (`timezone` column, `timeZone` field). */
function toRuleDto(row: Awaited<ReturnType<typeof listAvailabilityRules>>[number]): AvailabilityRuleInput {
  return {
    timeZone: row.timezone,
    weekdays: row.weekdays,
    localStart: row.localStart.slice(0, 5),
    localEnd: row.localEnd.slice(0, 5),
    slotMinutes: row.slotMinutes,
    bufferBeforeMinutes: row.bufferBeforeMinutes,
    bufferAfterMinutes: row.bufferAfterMinutes,
    minNoticeMinutes: row.minNoticeMinutes,
    horizonDays: row.horizonDays,
    enabled: row.enabled,
  }
}

function toOverrideDto(row: Awaited<ReturnType<typeof listAvailabilityOverrides>>[number]): AvailabilityOverrideInput {
  return {
    localDate: row.localDate,
    localStart: row.localStart ? row.localStart.slice(0, 5) : null,
    localEnd: row.localEnd ? row.localEnd.slice(0, 5) : null,
    kind: row.kind as AvailabilityOverrideInput['kind'],
    timeZone: row.timezone,
  }
}

export async function getOwnAvailability(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
): Promise<AvailabilityPolicyView> {
  const [rules, overrides, policy] = await Promise.all([
    listAvailabilityRules(transaction, principal.organizationId, principal.userId),
    listAvailabilityOverrides(transaction, principal.organizationId, principal.userId),
    findAvailabilityPolicy(transaction, principal.organizationId, principal.userId),
  ])
  return {
    rules: rules.map(toRuleDto),
    overrides: overrides.map(toOverrideDto),
    // An owner who has never saved anything reads as an empty policy at version 1, so the first
    // PUT is an ordinary versioned write rather than a special case the client has to know about.
    defaultReminderOffsets: policy?.defaultReminderOffsets ?? [],
    defaultReminderChannels: policy?.defaultReminderChannels ?? [],
    version: policy?.version ?? 1,
  }
}

export interface PutAvailabilityInput {
  version: number
  rules: AvailabilityRuleInput[]
  overrides: AvailabilityOverrideInput[]
  defaultReminderOffsets: number[]
  defaultReminderChannels: string[]
}

/**
 * Replaces the caller's whole availability policy, atomically and with optimistic versioning.
 *
 * Whole-policy replacement rather than per-rule CRUD is deliberate: availability is only
 * meaningful as a set (overlaps, merges, and the interaction between rules and overrides are all
 * cross-row properties), so validating one rule at a time would let a client assemble a set that
 * no single request ever made invalid.
 */
export async function putOwnAvailability(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: PutAvailabilityInput,
): Promise<AvailabilityPolicyView> {
  if (!can(principal, 'scheduling:manage', { creatorUserId: principal.userId })) {
    throw new AvailabilityError('Only the owner can change their availability', 'forbidden')
  }

  // There is deliberately no "which owner?" field to validate here: the request contracts in
  // `interview-api.ts` omit `ownerUserId` entirely, so the owner can only ever be the principal.
  // Accepting one and then checking it would invite a client to believe editing another user's
  // availability is a supported operation that merely happens to be denied.

  for (const rule of input.rules) {
    // Zod checks the shape of a timezone string; only the ICU database can say whether it names a
    // real zone. A bogus zone here would silently generate slots at the wrong wall-clock time.
    if (!isValidIanaTimeZone(rule.timeZone)) {
      throw new AvailabilityError(`Unknown time zone: ${rule.timeZone}`, 'invalid_input')
    }
    if (rule.horizonDays > MAX_AVAILABILITY_HORIZON_DAYS) {
      throw new AvailabilityError(`horizonDays must not exceed ${MAX_AVAILABILITY_HORIZON_DAYS}`, 'invalid_input')
    }
  }
  for (const override of input.overrides) {
    if (!isValidIanaTimeZone(override.timeZone)) {
      throw new AvailabilityError(`Unknown time zone: ${override.timeZone}`, 'invalid_input')
    }
  }

  const normalization = normalizeAvailabilityRules(input.rules)
  if (!normalization.ok) {
    throw new AvailabilityError(
      'Two availability rules overlap on the same day with different slot settings',
      'invalid_input',
    )
  }

  // The version bump happens first: if it loses the race, nothing below runs and the caller's
  // stale rules never touch the tables.
  const header = await upsertAvailabilityPolicyWithVersion(
    transaction,
    principal.organizationId,
    principal.userId,
    input.version,
    {
      defaultReminderOffsets: input.defaultReminderOffsets,
      defaultReminderChannels: input.defaultReminderChannels,
    },
  )
  if (!header) throw new AvailabilityError('Availability was modified concurrently', 'state_changed')

  await replaceAvailabilityPolicy(transaction, principal.organizationId, principal.userId, {
    rules: normalization.rules.map((rule) => ({
      timezone: rule.timeZone,
      weekdays: rule.weekdays,
      localStart: rule.localStart,
      localEnd: rule.localEnd,
      slotMinutes: rule.slotMinutes,
      bufferBeforeMinutes: rule.bufferBeforeMinutes,
      bufferAfterMinutes: rule.bufferAfterMinutes,
      minNoticeMinutes: rule.minNoticeMinutes,
      horizonDays: rule.horizonDays,
      enabled: rule.enabled,
    })),
    overrides: input.overrides.map((override) => ({
      localDate: override.localDate,
      localStart: override.localStart,
      localEnd: override.localEnd,
      kind: override.kind,
      timezone: override.timeZone,
    })),
  })

  return {
    rules: normalization.rules,
    overrides: input.overrides,
    defaultReminderOffsets: header.defaultReminderOffsets,
    defaultReminderChannels: header.defaultReminderChannels,
    version: header.version,
  }
}

/**
 * Adds one override to the existing policy.
 *
 * Implemented as read-modify-write through the same versioned path as a full PUT rather than a
 * bare INSERT. A lone insert would leave the policy version untouched, so a client holding the
 * previous version would still believe its copy was current — the version has to advance for
 * every change to the policy, not only for wholesale replacements.
 */
export async function addOwnAvailabilityOverride(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: { version: number; override: AvailabilityOverrideInput },
): Promise<AvailabilityPolicyView> {
  const current = await getOwnAvailability(transaction, principal)
  const withoutSameDate = current.overrides.filter((existing) => existing.localDate !== input.override.localDate)
  return putOwnAvailability(transaction, principal, {
    version: input.version,
    rules: current.rules,
    // One override per local date: a second override for the same day replaces the first, because
    // "blocked all day" and "available 14:00-16:00" on one date cannot both be true.
    overrides: [...withoutSameDate, input.override],
    defaultReminderOffsets: current.defaultReminderOffsets,
    defaultReminderChannels: current.defaultReminderChannels,
  })
}

export async function deleteOwnAvailabilityOverride(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: { version: number; localDate: string },
): Promise<AvailabilityPolicyView> {
  const current = await getOwnAvailability(transaction, principal)
  return putOwnAvailability(transaction, principal, {
    version: input.version,
    rules: current.rules,
    // Deleting a date that has no override is not an error: the requested end state — no override
    // on that date — is what the caller gets either way, and reporting 404 would tell a prober
    // whether the owner had blocked that day.
    overrides: current.overrides.filter((existing) => existing.localDate !== input.localDate),
    defaultReminderOffsets: current.defaultReminderOffsets,
    defaultReminderChannels: current.defaultReminderChannels,
  })
}
