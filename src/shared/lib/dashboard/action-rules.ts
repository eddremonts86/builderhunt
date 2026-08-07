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
  /**
   * Optional secondary dismissal affordance, threaded through to the
   * parsed action item. The queue widget renders a small `Skip`-style
   * button when this is present, so a rule that needs a real server
   * action (POST) alongside its primary link can declare it here.
   * `null` for the common case where the row only has one decision.
   */
  dismissAction: {
    label: string
    endpoint: string
    method: 'POST'
    bodyKey: string | null
  } | null
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
        dismissAction: null,
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
          dismissAction: null,
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
          dismissAction: null,
        })
      }
      return outputs
    },
  },
  /**
   * A membership invitation this user has been sent and has not answered.
   *
   * ## The destination is not `open-invitation`, and that is a trap worth naming
   *
   * `open-invitation` already exists in the action kinds and resolves to `/interviews/invitations` —
   * the hub for *interview* invitations sent to candidates. A membership invitation is an unrelated
   * object at `/team/invite/$invitationId`, on a route outside the dashboard layout entirely. Reading
   * `membershipInvitations` here and reaching for the kind whose name matches would send someone with
   * a team invitation to a page about candidate interviews: a wrong destination that looks right, that
   * no type can catch because the enum already contains a plausible name, and that
   * `resolveActionHref` could not even carry the id to. Hence `open-membership-invitation`, with its
   * own route entry.
   *
   * ## One row for all of them
   *
   * Same reasoning as the unread-alert rule below. Two pending invitations are two rows saying the
   * same sentence, and the queue's value is that its order means something.
   *
   * ## What replacing the banner cost, which is nothing
   *
   * A note here previously claimed this could not move because `PendingInvitationsBanner` "accepts or
   * declines in place". It does not, and never did — it renders one link per invitation to
   * `/team/invite/$invitationId`, which is exactly the shape of a queue row. The note was wrong and
   * blocked the task for as long as it stood.
   */
  {
    id: 'membership-invitation-pending',
    priority: ACTION_PRIORITY.membershipInvitation,
    evaluate: ({ membershipInvitations }) => {
      const [first, ...rest] = membershipInvitations
      if (!first) return []
      const only = rest.length === 0
      return [{
        resourceKey: only ? `membership-invitation:${first.id}` : 'membership-invitation:multiple',
        // Informational: nothing is broken and nothing expires today. An invitation is an offer, and
        // ranking it above a failed payment because it is new would be the notification-feed failure
        // the ordering comment above describes.
        severity: 'info' as const,
        title: only
          ? 'You have been invited to join a team'
          : `You have been invited to join ${membershipInvitations.length} teams`,
        detail: only
          ? 'Review the invitation to accept or decline it.'
          : 'Review each invitation to accept or decline it.',
        dueAt: null,
        kind: 'open-membership-invitation' as const,
        // Only a single invitation can carry an id. With several there is no one page to open, and
        // picking the first would choose for the user; `resolveActionHref` renders no link rather
        // than guessing, which is the behaviour that field's `null` case exists for.
        resourceId: only ? first.id : null,
        dismissAction: null,
      }]
    },
  },
  /*
   * **Onboarding unification.** This rule ships the row that replaces
   * `OnboardingBanner`. The banner is deleted when this row renders in
   * production. The skip is a real server action
   * (`POST /api/onboarding/skip`, counted against `MAX_SKIPS`) rather
   * than a link, and the queue widget documents exactly one primary
   * action per row. The skip is therefore surfaced as a secondary
   * `dismissAction` rather than a second primary action.
   *
   * `resourceId` is null because onboarding is not a resource — the
   * action links to `/onboarding`, which always exists.
   */
  {
    id: 'onboarding-incomplete',
    priority: ACTION_PRIORITY.onboardingIncomplete,
    evaluate: ({ onboarding }) => {
      if (!onboarding || onboarding.complete) return []
      return [
        {
          resourceKey: 'onboarding',
          severity: 'info' as const,
          title: 'Finish onboarding',
          detail: 'A few quick steps set up your tracking keywords.',
          dueAt: null,
          kind: 'open-onboarding' as const,
          resourceId: null,
          dismissAction: {
            label: 'Skip',
            endpoint: '/api/onboarding/skip',
            method: 'POST' as const,
            bodyKey: null,
          },
        },
      ]
    },
  },
  /* Onboarding rule is the one above (`onboarding-incomplete`). It
   * renders a row with a primary `Continue` link to `/onboarding` and a
   * secondary `Skip` POST to `/api/onboarding/skip` (the dismissAction).
   * The corresponding `OnboardingBanner` is deleted below; the banner's
   * `localStorage` dismissal that hid the notice across browser reloads
   * becomes free when the queue is the single source of truth. */
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
        dismissAction: null,
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
        dismissAction: null,
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
        dismissAction: null,
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
    dismissAction: output.dismissAction ?? null,
  }))

  return { items, overflow: Math.max(0, ordered.length - items.length) }
}
