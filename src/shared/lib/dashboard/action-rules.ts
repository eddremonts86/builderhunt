import {
  DASHBOARD_ROW_LIMITS,
  type DashboardActionItem,
  type DashboardActionKind,
  type DashboardSeverity,
} from './contracts'

/**
 * The action queue's rules (plans/ui-dashboard Wave 2, "Implement the deterministic action-rule
 * registry").
 *
 * ## Why this is a pure function of a snapshot
 *
 * Every rule takes an already-fetched `ActionQueueInput` and returns items or nothing. No rule reads
 * a database, a clock, or an environment. Three things follow, and each one is the reason:
 *
 * - **The order is testable.** "What does an owner with a paused sprint, two unread alerts and no
 *   credits see first?" is a table row here rather than a fixture-heavy integration test.
 * - **The clock is an argument.** Every "is this due soon" decision reads `input.now`, so boundary
 *   behaviour is exact instead of approximately reproducible. A rule that called `Date.now()` would
 *   be untestable at precisely the minute that matters.
 * - **A rule cannot widen its own authorization.** It receives what the caller decided it may see.
 *   `usage` is absent for a member, so the usage rule cannot fire for one — not because it checks,
 *   but because it has nothing to check.
 *
 * ## Ordering, and why priority is not severity
 *
 * `priority` is the product's ranking of *kinds of problem*; `severity` is how alarming one instance
 * looks. They are separate because a low-priority kind can be critical (a failed payment on a small
 * plan) and a high-priority kind can be informational (an interview tomorrow that is fully prepared).
 * Sorting by severity would put every red thing first regardless of whether it can be acted on, which
 * is how an action queue turns into a notification feed.
 *
 * The order is total: priority, then due time (soonest first, undated last), then rule id, then
 * resource id. A partial order would reshuffle between requests and read as the page changing on its
 * own.
 */

/** The product's ranking of problem kinds, from the spec's action-queue list. Lower fires first. */
export const ACTION_PRIORITY = {
  billing: 10,
  interviewUnprepared: 20,
  schedulingBlocked: 30,
  invitationNeedsOrganizer: 40,
  unreadHighValueAlert: 50,
  sprintNeedsReview: 60,
  sprintStalled: 70,
  membershipInvitation: 80,
  onboardingIncomplete: 90,
  usageThreshold: 100,
} as const

export type ActionPriority = (typeof ACTION_PRIORITY)[keyof typeof ACTION_PRIORITY]

/**
 * Everything the rules may read.
 *
 * Deliberately narrow and already-redacted. There is no note text, no candidate email, no transcript,
 * no provider metadata and no free text of any kind — a rule cannot leak what it was never handed,
 * and the DTO redaction test in the route is checking the same boundary from the other side.
 */
export interface ActionQueueInput {
  now: Date
  onboarding: { complete: boolean } | null
  /** Organization invitations addressed to *this user*, awaiting their answer. */
  membershipInvitations: ReadonlyArray<{ id: string }>
  /** Alert triggers the user has not opened. `highValue` is decided upstream, not re-derived here. */
  unreadAlerts: ReadonlyArray<{ id: string; highValue: boolean; triggeredAt: Date }>
  /**
   * Statuses are the product's own three (`SPRINT_STATUS_VALUES`), not a richer set invented here.
   *
   * In particular there is no "reviewed" flag anywhere in the schema, so the completed-sprint rule
   * says *"has results to review"* rather than *"nobody has looked at them"* — the second is a claim
   * about human behaviour this product does not record, and a queue that asserts it would be telling
   * a recruiter something false every time they had already reviewed the sprint.
   */
  sprints: ReadonlyArray<{
    id: string
    name: string
    status: 'active' | 'paused' | 'completed'
    resultCount: number
    lastRunAt: Date | null
  }>
  /** Absent for a role that may not read billing — see the note above. */
  usage: {
    seatsUsed: number
    seatsAllowed: number
    creditBalanceUnits: number
    paidActionsAllowed: boolean
  } | null
  /**
   * The caller's own next appointments, already merged and bounded by
   * `listUpcomingAppointments`. The rule below reads only whether an interview is imminent and
   * whether it has an active brief — never the candidate, the location, or the meeting link.
   */
  upcoming: ReadonlyArray<{
    eventId: string
    title: string
    startsAt: Date
    type: string
    hasActiveBrief: boolean
  }>
}

interface Rule {
  id: string
  priority: ActionPriority
  evaluate: (input: ActionQueueInput) => ReadonlyArray<RuleOutput>
}

interface RuleOutput {
  /** Identifies the underlying *thing*, so two rules about one resource can be deduplicated. */
  resourceKey: string
  severity: DashboardSeverity
  title: string
  detail: string | null
  dueAt: Date | null
  kind: DashboardActionKind
  resourceId: string | null
}

/**
 * A sprint with no progress for this long is stalled.
 *
 * Three days rather than one: sprints legitimately go quiet overnight and across a weekend, and a
 * queue that cries stalled every Monday morning is a queue people learn to scroll past.
 */
const SPRINT_STALL_MS = 3 * 24 * 60 * 60 * 1000

/**
 * How close an interview has to be before "no brief yet" becomes something to act on *now*.
 *
 * 24 hours. An interview next week with no brief is normal — briefs are written the day before, and
 * a queue that says otherwise is wrong about how the work happens and gets ignored for it. The
 * agenda already shows "No brief yet" on every such row regardless of distance; that is information.
 * This is the point at which it becomes urgency, and the two surfaces saying it for different
 * reasons is the intended division.
 */
const INTERVIEW_BRIEF_WINDOW_MS = 24 * 60 * 60 * 1000

const RULES: readonly Rule[] = [
  {
    id: 'interview-missing-brief',
    priority: ACTION_PRIORITY.interviewUnprepared,
    evaluate: ({ upcoming, now }) => upcoming
      .filter((appointment) => {
        if (appointment.type !== 'interview' || appointment.hasActiveBrief) return false
        const until = appointment.startsAt.getTime() - now.getTime()
        // Already started is still unprepared, and more so — `until` goes negative and stays inside
        // the window, which is deliberate. `listUpcomingAppointments` has already excluded anything
        // that finished.
        return until < INTERVIEW_BRIEF_WINDOW_MS
      })
      .map((appointment) => ({
        resourceKey: `interview:${appointment.eventId}`,
        // Warning, not critical: the interview will happen either way, and reserving `critical` for
        // things that are actually broken is what keeps the word meaning something.
        severity: 'warning' as const,
        title: 'An interview starts soon with no brief',
        detail: appointment.title,
        dueAt: appointment.startsAt,
        kind: 'open-interview' as const,
        resourceId: appointment.eventId,
      })),
  },
  {
    id: 'usage-threshold',
    priority: ACTION_PRIORITY.usageThreshold,
    evaluate: ({ usage }) => {
      if (!usage) return []
      const outputs: RuleOutput[] = []
      // Seats first: it blocks a person from joining, which is a harder stop than a paid action.
      if (usage.seatsAllowed > 0 && usage.seatsUsed >= usage.seatsAllowed) {
        outputs.push({
          resourceKey: 'usage:seats',
          severity: 'warning',
          title: 'All seats are in use',
          detail: `${usage.seatsUsed} of ${usage.seatsAllowed} seats taken. Nobody else can be invited.`,
          dueAt: null,
          kind: 'open-billing',
          resourceId: null,
        })
      }
      if (usage.paidActionsAllowed && usage.creditBalanceUnits <= 0) {
        outputs.push({
          resourceKey: 'usage:credits',
          severity: 'warning',
          title: 'No credits remaining',
          detail: 'Paid actions will be refused until the balance is topped up.',
          dueAt: null,
          kind: 'open-billing',
          resourceId: null,
        })
      }
      return outputs
    },
  },
  /*
   * **Onboarding and membership invitations are deliberately NOT rules yet.**
   *
   * The spec wants them folded into this queue (Wave 2, "Unify onboarding and invitation notices
   * with the queue"), and the inputs above are already carried for exactly that. What stops it today
   * is that `OnboardingBanner` and `PendingInvitationsBanner` each do something a queue row cannot:
   * the first offers *skip*, the second accepts or declines in place. A queue row is one link.
   *
   * Shipping the rules while the banners still render would put each of those notices on the page
   * twice — the duplication the unification task exists to remove, introduced by the change meant to
   * remove it. Shipping the rules and deleting the banners would quietly drop skip and inline
   * accept, which the same task requires be preserved ("preserve blocking/critical behaviour and
   * valid dismissals"), and which `onboarding.spec.ts` covers across four cases.
   *
   * So the order is: give the queue row a secondary affordance, then move these two, then delete the
   * banners. Until then the banners own both notices and the queue stays silent about them.
   */
  {
    id: 'unread-high-value-alert',
    priority: ACTION_PRIORITY.unreadHighValueAlert,
    /**
     * **One row for all unread alerts, not one row each.**
     *
     * The first version emitted an item per trigger, and on a real workspace that produced five
     * consecutive rows reading "An alert matched someone worth looking at" — identical text,
     * identical action, all going to the same page, and between them pushing the two billing
     * warnings to the bottom of the queue. A ranked list whose top half is one repeated sentence
     * has stopped ranking anything.
     *
     * The aggregate is also the honest shape: there is no per-trigger destination. Every one of
     * those rows resolved to `/alerts`, so the queue was offering five copies of a single decision.
     */
    evaluate: ({ unreadAlerts }) => {
      // `highValue` is decided by whatever produced the trigger. Re-deriving it here would be a
      // second definition of "worth interrupting someone for", and the two would drift.
      const relevant = unreadAlerts.filter((alert) => alert.highValue)
      if (relevant.length === 0) return []
      // The oldest, so the queue's time column says how long this has been waiting rather than how
      // recently it was topped up.
      const oldest = relevant.reduce((best, alert) => (alert.triggeredAt < best.triggeredAt ? alert : best))
      return [{
        resourceKey: 'alerts:unread',
        severity: 'info' as const,
        title: relevant.length === 1
          ? 'An alert matched someone worth looking at'
          : `${relevant.length} alerts matched someone worth looking at`,
        detail: null,
        dueAt: oldest.triggeredAt,
        kind: 'open-alert' as const,
        resourceId: null,
      }]
    },
  },
  {
    id: 'sprint-has-results',
    priority: ACTION_PRIORITY.sprintNeedsReview,
    evaluate: ({ sprints }) => sprints
      .filter((sprint) => sprint.status === 'completed' && sprint.resultCount > 0)
      .map((sprint) => ({
        resourceKey: `sprint:${sprint.id}`,
        severity: 'info' as const,
        // Not "nobody has reviewed these" — the schema records no such thing, and asserting it would
        // be wrong for every recruiter who already had.
        title: `A finished sprint has ${sprint.resultCount} result${sprint.resultCount === 1 ? '' : 's'} to review`,
        detail: sprint.name,
        dueAt: null,
        kind: 'open-sprint' as const,
        resourceId: sprint.id,
      })),
  },
  {
    id: 'sprint-stalled',
    priority: ACTION_PRIORITY.sprintStalled,
    evaluate: ({ sprints, now }) => sprints
      .filter((sprint) => {
        if (sprint.status === 'paused') return true
        if (sprint.status !== 'active') return false
        // An active sprint that has never run is not stalled; it may have been created a minute ago.
        // Only one with a recorded run can be judged against the threshold.
        if (!sprint.lastRunAt) return false
        return now.getTime() - sprint.lastRunAt.getTime() > SPRINT_STALL_MS
      })
      .map((sprint) => ({
        resourceKey: `sprint:${sprint.id}`,
        severity: 'warning' as const,
        title: sprint.status === 'paused' ? 'A sprint is paused' : 'A sprint has not run in days',
        detail: sprint.name,
        dueAt: sprint.lastRunAt,
        kind: 'open-sprint' as const,
        resourceId: sprint.id,
      })),
  },
]

/**
 * Evaluates every rule and returns the queue.
 *
 * **Deduplication is by resource, keeping the highest-priority rule.** One sprint can be both
 * "completed with unreviewed results" and, later, "stalled"; showing both would ask the user to deal
 * with one thing twice and would push a genuinely separate problem off the bottom of a bounded list.
 *
 * The cap is applied last, after ordering, so what is dropped is always the least urgent — and the
 * caller is told how many, because a silently truncated queue reads as a complete one.
 */
export function buildActionQueue(input: ActionQueueInput): {
  items: DashboardActionItem[]
  /** Items that did not fit. Zero unless the workspace has more problems than the list can hold. */
  overflow: number
} {
  const byResource = new Map<string, { priority: ActionPriority; ruleId: string; output: RuleOutput }>()

  for (const rule of RULES) {
    for (const output of rule.evaluate(input)) {
      const existing = byResource.get(output.resourceKey)
      if (existing && existing.priority <= rule.priority) continue
      byResource.set(output.resourceKey, { priority: rule.priority, ruleId: rule.id, output })
    }
  }

  const ordered = [...byResource.values()].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    // Soonest due first; undated last. An undated item is not urgent, it is merely unscheduled.
    const aDue = a.output.dueAt?.getTime() ?? Number.POSITIVE_INFINITY
    const bDue = b.output.dueAt?.getTime() ?? Number.POSITIVE_INFINITY
    if (aDue !== bDue) return aDue - bDue
    // Total order, so the list cannot reshuffle between two identical requests.
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1
    return a.output.resourceKey < b.output.resourceKey ? -1 : 1
  })

  const items = ordered.slice(0, DASHBOARD_ROW_LIMITS.actionQueue).map(({ ruleId, output }) => ({
    // Stable across requests for the same underlying problem, so a client can key a list on it and
    // an analytics event can correlate a resolution without carrying the resource id.
    id: `${ruleId}:${output.resourceKey}`,
    severity: output.severity,
    title: output.title,
    detail: output.detail,
    dueAt: output.dueAt?.toISOString() ?? null,
    action: { kind: output.kind, resourceId: output.resourceId },
  }))

  return { items, overflow: Math.max(0, ordered.length - items.length) }
}
