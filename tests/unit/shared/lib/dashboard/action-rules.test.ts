import { describe, expect, it } from 'vitest'
import { buildActionQueue, type ActionQueueInput } from '~/shared/lib/dashboard/action-rules'
import { DASHBOARD_ROW_LIMITS, dashboardActionItemSchema } from '~/shared/lib/dashboard/contracts'

/**
 * plans/ui-dashboard Wave 2, "Implement the deterministic action-rule registry" — verify line:
 * "table-driven tests cover priority ties, expiry, duplicate underlying resources, unauthorized
 * fields, and clock boundaries."
 *
 * The queue is the one part of this dashboard whose *order* is the product. Everything else can be
 * read in any sequence and still be understood; a list that claims to be ranked by urgency and is
 * not is worse than an unranked list, because the reader stops at the top.
 */

const NOW = new Date('2027-03-10T12:00:00.000Z')

function input(overrides: Partial<ActionQueueInput> = {}): ActionQueueInput {
  return {
    now: NOW,
    onboarding: { complete: true },
    membershipInvitations: [],
    unreadAlerts: [],
    sprints: [],
    usage: null,
    upcoming: [],
    ...overrides,
  }
}

const days = (count: number) => new Date(NOW.getTime() - count * 24 * 60 * 60 * 1000)

describe('buildActionQueue', () => {
  it('is empty for a workspace with nothing to do', () => {
    expect(buildActionQueue(input())).toEqual({ items: [], overflow: 0 })
  })

  it('ranks by problem kind, not by how alarming each one looks', () => {
    /**
     * The distinction `priority` and `severity` exist to keep apart. An unread alert is `info` and a
     * seat limit is a `warning`, yet the alert ranks *above* it: the alert is a person to look at
     * now, while the seat limit is a purchase decision that will still be there tomorrow. Sorting by
     * severity would invert the pair and turn the queue into a notification feed sorted by colour.
     */
    const queue = buildActionQueue(input({
      unreadAlerts: [{ id: 'a1', highValue: true, triggeredAt: days(1) }],
      usage: { seatsUsed: 5, seatsAllowed: 5, creditBalanceUnits: 10, paidActionsAllowed: true },
    }))

    expect(queue.items.map((item) => item.action.kind)).toEqual(['open-alert', 'open-billing'])
    expect(queue.items[0].severity).toBe('info')
    expect(queue.items[1].severity).toBe('warning')
  })

  it('shows one entry per underlying resource, keeping the more urgent rule', () => {
    // A completed sprint whose last run is long past matches both `sprint-has-results` and the
    // stall window. Two entries would ask the user to deal with one thing twice and push a genuinely
    // separate problem off a bounded list, so the higher-priority rule wins and the other is dropped.
    const queue = buildActionQueue(input({
      sprints: [{
        id: 'sprint-1',
        name: 'Rust backend',
        status: 'completed',
        resultCount: 4,
        lastRunAt: days(10),
      }],
    }))

    expect(queue.items).toHaveLength(1)
    expect(queue.items[0].title).toContain('4 results to review')
  })

  it('treats a paused sprint as needing attention regardless of when it last moved', () => {
    const queue = buildActionQueue(input({
      sprints: [{ id: 's', name: 'Paused', status: 'paused', resultCount: 0, lastRunAt: NOW }],
    }))
    expect(queue.items).toHaveLength(1)
    expect(queue.items[0].severity).toBe('warning')
  })

  it.each([
    ['just under the threshold', 2.9, 0],
    ['just over the threshold', 3.1, 1],
  ])('an active sprint stalls %s', (_label, daysAgo, expected) => {
    // The clock is an argument, so the boundary is exact rather than approximately reproducible.
    const queue = buildActionQueue(input({
      sprints: [{
        id: 's',
        name: 'Active',
        status: 'active',
        resultCount: 0,
        lastRunAt: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000),
      }],
    }))
    expect(queue.items).toHaveLength(expected)
  })

  it('does not call a never-run sprint stalled', () => {
    // No recorded progress is not the same as no progress: the sprint may have started a minute ago.
    const queue = buildActionQueue(input({
      sprints: [{ id: 's', name: 'Fresh', status: 'active', resultCount: 0, lastRunAt: null }],
    }))
    expect(queue.items).toEqual([])
  })

  it('cannot raise a usage item for a role that was given no usage', () => {
    // Not because the rule checks a role — because it has nothing to read. A member's snapshot omits
    // `usage` entirely, so the authorization is structural rather than conditional.
    const queue = buildActionQueue(input({ usage: null }))
    expect(queue.items).toEqual([])
  })

  it('ignores an empty credit balance when the plan cannot take paid actions anyway', () => {
    // Telling a free workspace it has no credits is advice about a wall it is not walking towards.
    const queue = buildActionQueue(input({
      usage: { seatsUsed: 1, seatsAllowed: 5, creditBalanceUnits: 0, paidActionsAllowed: false },
    }))
    expect(queue.items).toEqual([])
  })

  it('only counts alerts that were already judged high value', () => {
    const queue = buildActionQueue(input({
      unreadAlerts: [
        { id: 'a1', highValue: false, triggeredAt: days(1) },
        { id: 'a2', highValue: true, triggeredAt: days(2) },
      ],
    }))
    expect(queue.items).toHaveLength(1)
    expect(queue.items[0].title).toBe('An alert matched someone worth looking at')
  })

  it('collapses several unread alerts into one row', () => {
    /*
     * Observed on the real dashboard before this rule aggregated: five consecutive rows with
     * identical text, an identical action, and the same destination, which between them pushed two
     * billing warnings to the bottom. A ranked list whose top half is one repeated sentence has
     * stopped ranking anything — and there is no per-trigger destination for those rows to differ
     * by, so it was five copies of one decision.
     */
    const queue = buildActionQueue(input({
      unreadAlerts: [
        { id: 'a1', highValue: true, triggeredAt: days(1) },
        { id: 'a2', highValue: true, triggeredAt: days(5) },
        { id: 'a3', highValue: true, triggeredAt: days(3) },
      ],
    }))

    expect(queue.items).toHaveLength(1)
    expect(queue.items[0].title).toBe('3 alerts matched someone worth looking at')
    // The oldest trigger, so the time column says how long this has waited rather than how recently
    // it was topped up.
    expect(queue.items[0].dueAt).toBe(days(5).toISOString())
    expect(queue.items[0].action.resourceId).toBeNull()
  })

  it('orders a tie by due time, soonest first, with undated items last', () => {
    const queue = buildActionQueue(input({
      sprints: [
        { id: 'older', name: 'Older', status: 'paused', resultCount: 0, lastRunAt: days(5) },
        { id: 'newer', name: 'Newer', status: 'paused', resultCount: 0, lastRunAt: days(1) },
        { id: 'never', name: 'Never run', status: 'paused', resultCount: 0, lastRunAt: null },
      ],
    }))
    expect(queue.items.map((item) => item.action.resourceId)).toEqual(['older', 'newer', 'never'])
  })

  it('produces the same order twice for the same input', () => {
    // A partial order reshuffles between requests and reads as the page changing on its own.
    const fixture = input({
      unreadAlerts: [
        { id: 'a1', highValue: true, triggeredAt: days(1) },
        { id: 'a2', highValue: true, triggeredAt: days(1) },
      ],
      sprints: [
        { id: 's2', name: 'Two', status: 'paused', resultCount: 0, lastRunAt: null },
        { id: 's1', name: 'One', status: 'paused', resultCount: 0, lastRunAt: null },
      ],
    })
    const first = buildActionQueue(fixture).items.map((item) => item.id)
    const second = buildActionQueue(fixture).items.map((item) => item.id)
    expect(first).toEqual(second)
    expect(new Set(first).size, 'two items share an id').toBe(first.length)
  })

  it('caps the list and reports what did not fit rather than truncating silently', () => {
    const many = Array.from({ length: DASHBOARD_ROW_LIMITS.actionQueue + 5 }, (_, index) => ({
      id: `sprint-${String(index).padStart(2, '0')}`,
      name: `Sprint ${index}`,
      status: 'paused' as const,
      resultCount: 0,
      lastRunAt: days(index + 1),
    }))
    const queue = buildActionQueue(input({ sprints: many }))

    expect(queue.items).toHaveLength(DASHBOARD_ROW_LIMITS.actionQueue)
    expect(queue.overflow).toBe(5)

    /*
     * The cap is applied after ordering, so what falls off is the least urgent — here the five
     * sprints that stopped most recently. `dueAt` carries the last run, and sorting soonest-first
     * puts the longest-idle sprint at the top: one untouched for seventeen days is a worse fact
     * than one that paused this morning.
     */
    expect(queue.items[0].action.resourceId).toBe('sprint-16')
    const kept = new Set(queue.items.map((item) => item.action.resourceId))
    for (const newest of ['sprint-00', 'sprint-01', 'sprint-02', 'sprint-03', 'sprint-04']) {
      expect(kept.has(newest), `${newest} survived the cap ahead of a longer-idle sprint`).toBe(false)
    }
  })

  it('emits items the wire contract accepts, including the resource-id pattern', () => {
    const queue = buildActionQueue(input({
      sprints: [{ id: 'sprint-1', name: 'X', status: 'paused', resultCount: 0, lastRunAt: null }],
      usage: { seatsUsed: 5, seatsAllowed: 5, creditBalanceUnits: 0, paidActionsAllowed: true },
      unreadAlerts: [{ id: 'a1', highValue: true, triggeredAt: days(1) }],
      onboarding: { complete: false },
    }))

    for (const item of queue.items) {
      const parsed = dashboardActionItemSchema.safeParse(item)
      expect(parsed.success, `${item.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
    }
  })

  it('carries no free text beyond the titles and a sprint name', () => {
    // The rules are handed a redacted snapshot, so this asserts the other half: nothing they emit
    // reintroduces content. A sprint name is user-authored and intended for display; there is no
    // note text, candidate email, transcript or provider metadata in the input at all.
    const queue = buildActionQueue(input({
      sprints: [{ id: 's', name: 'Backend hiring', status: 'paused', resultCount: 0, lastRunAt: null }],
    }))
    expect(queue.items[0].detail).toBe('Backend hiring')
    expect(JSON.stringify(queue.items)).not.toMatch(/@|http|token/i)
  })
})

describe('the interview-readiness rule', () => {
  /**
   * plans/ui-dashboard Wave 3, "Add interview-readiness and scheduling action rules".
   *
   * The window is the whole design here. An interview next week with no brief is not a problem —
   * briefs get written the day before, and a queue that says otherwise is wrong about how the work
   * happens and gets scrolled past for it. The agenda already labels every unbriefed interview
   * regardless of distance; that is information. This rule is the point where it becomes urgency.
   */
  const interview = (overrides: Partial<{ eventId: string; title: string; startsAt: Date; type: string; hasActiveBrief: boolean }> = {}) => ({
    eventId: 'evt-1',
    title: 'Interview: Senior Backend Engineer',
    startsAt: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
    type: 'interview',
    hasActiveBrief: false,
    ...overrides,
  })

  it('raises an unbriefed interview inside the day', () => {
    const queue = buildActionQueue(input({ upcoming: [interview()] }))
    expect(queue.items).toHaveLength(1)
    expect(queue.items[0].severity).toBe('warning')
    expect(queue.items[0].action).toEqual({ kind: 'open-interview', resourceId: 'evt-1' })
  })

  it.each([
    ['inside the window', 23, 1],
    ['outside the window', 25, 0],
  ])('an interview %s hours away raises %s', (_label, hoursAway, expected) => {
    const queue = buildActionQueue(input({
      upcoming: [interview({ startsAt: new Date(NOW.getTime() + hoursAway * 60 * 60 * 1000) })],
    }))
    expect(queue.items).toHaveLength(expected)
  })

  it('still raises one that has already started', () => {
    // `listUpcomingAppointments` excludes anything that has finished, so a negative offset here is a
    // meeting in progress — the most unprepared anyone can be, not the least.
    const queue = buildActionQueue(input({
      upcoming: [interview({ startsAt: new Date(NOW.getTime() - 10 * 60 * 1000) })],
    }))
    expect(queue.items).toHaveLength(1)
  })

  it('says nothing about an interview that has a brief', () => {
    expect(buildActionQueue(input({ upcoming: [interview({ hasActiveBrief: true })] })).items).toEqual([])
  })

  it('says nothing about a non-interview appointment', () => {
    // `calendar_events_type_check` allows exactly `personal` and `interview`. A personal block with
    // no interview brief is not a gap; it is a block.
    expect(buildActionQueue(input({ upcoming: [interview({ type: 'personal' })] })).items).toEqual([])
  })

  it('outranks every other rule, because it expires and the others do not', () => {
    const queue = buildActionQueue(input({
      upcoming: [interview()],
      unreadAlerts: [{ id: 'a1', highValue: true, triggeredAt: days(1) }],
      sprints: [{ id: 's', name: 'Paused', status: 'paused', resultCount: 0, lastRunAt: null }],
      usage: { seatsUsed: 5, seatsAllowed: 5, creditBalanceUnits: 0, paidActionsAllowed: true },
    }))
    expect(queue.items[0].action.kind).toBe('open-interview')
  })
})
