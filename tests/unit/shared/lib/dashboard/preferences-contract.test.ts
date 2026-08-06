import { describe, expect, it } from 'vitest'
import {
  DASHBOARD_PREFERENCES_SCHEMA_VERSION,
  DEFAULT_PREFERENCES_DOCUMENT,
  WIDGET_ID_LIST_LIMIT,
  dashboardPreferencesWriteSchema,
  mergeWidgetOrder,
  migratePreferenceDocument,
} from '~/shared/lib/dashboard/preferences-contract'

/**
 * plans/ui-dashboard Wave 6, "Persist versioned per-user/per-organization preferences" — verify line:
 * "user/org isolation, stale update, unknown ID, duplicate ID, required-widget hiding, size limit, and
 * schema migration tests pass."
 *
 * Isolation, stale updates and required-widget hiding are properties of the route, the repository and
 * the registry respectively, and are tested where they live — an assertion here could only restate
 * this module's own types. What is genuinely this module's to prove is the parsing boundary and the
 * two transforms every stored document passes through on its way to a render.
 */

const VALID = {
  revision: 3,
  density: 'bento' as const,
  hiddenWidgetIds: ['activity'],
  pinnedWidgetIds: [],
  orderedWidgetIds: ['action-queue', 'activity'],
}

describe('dashboardPreferencesWriteSchema', () => {
  it('accepts an id it has never heard of', () => {
    /*
     * Deliberate, not lax. During a rolling deploy one server has a widget another does not, and
     * rejecting the unknown id would fail the save of a user who happened to be routed to the older
     * instance — losing a preference for the ordinary act of being load-balanced.
     */
    const parsed = dashboardPreferencesWriteSchema.safeParse({
      ...VALID,
      hiddenWidgetIds: ['a-widget-from-next-week'],
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses an id shaped like anything but a widget id', () => {
    // The only reason to send one is to find out what happens.
    for (const bad of ['../etc/passwd', 'has space', '<script>', '']) {
      expect(dashboardPreferencesWriteSchema.safeParse({ ...VALID, hiddenWidgetIds: [bad] }).success).toBe(false)
    }
  })

  it('refuses a duplicate rather than de-duplicating it', () => {
    // A repeated id in an *order* is an ambiguous instruction. Quietly picking one of the two
    // readings is how a layout drifts without anyone changing anything.
    const parsed = dashboardPreferencesWriteSchema.safeParse({
      ...VALID,
      orderedWidgetIds: ['activity', 'activity'],
    })
    expect(parsed.success).toBe(false)
  })

  it('refuses a list past the bound instead of truncating it', () => {
    // A truncating parser turns "this client appends instead of replacing" into a row that looks fine
    // until the payload gets slow.
    const tooMany = Array.from({ length: WIDGET_ID_LIST_LIMIT + 1 }, (_, index) => `widget-${index}`)
    expect(dashboardPreferencesWriteSchema.safeParse({ ...VALID, orderedWidgetIds: tooMany }).success).toBe(false)
  })

  it('has no schemaVersion to send', () => {
    // The shape of the stored document is the server's fact about its own storage. A client that
    // could assert it could also claim to be a version it is not, and skip a migration.
    const parsed = dashboardPreferencesWriteSchema.safeParse({ ...VALID, schemaVersion: 99 })
    expect(parsed.success).toBe(true)
    expect(parsed.success && 'schemaVersion' in parsed.data).toBe(false)
  })
})

describe('migratePreferenceDocument', () => {
  it('fills in what a version-1 row never had', () => {
    const migrated = migratePreferenceDocument({
      schemaVersion: 1,
      revision: 4,
      density: 'sections',
      hiddenWidgetIds: ['activity'],
    })
    expect(migrated).toEqual({
      schemaVersion: DASHBOARD_PREFERENCES_SCHEMA_VERSION,
      revision: 4,
      density: 'sections',
      hiddenWidgetIds: ['activity'],
      pinnedWidgetIds: [],
      orderedWidgetIds: [],
    })
  })

  it('reads a document from a newer build rather than discarding it', () => {
    // A stored version above this build's means a rollback. Refusing would hand the user the default
    // layout instead of the parts of their own that this build still understands.
    const migrated = migratePreferenceDocument({
      schemaVersion: DASHBOARD_PREFERENCES_SCHEMA_VERSION + 1,
      revision: 9,
      density: 'sections',
      hiddenWidgetIds: [],
      pinnedWidgetIds: ['source-mix'],
      orderedWidgetIds: [],
    })
    expect(migrated.density).toBe('sections')
    expect(migrated.pinnedWidgetIds).toEqual(['source-mix'])
    expect(migrated.schemaVersion).toBe(DASHBOARD_PREFERENCES_SCHEMA_VERSION)
  })

  it('turns an empty row into the defaults', () => {
    expect(migratePreferenceDocument({})).toEqual(DEFAULT_PREFERENCES_DOCUMENT)
  })
})

describe('mergeWidgetOrder', () => {
  it('drops ids with no widget behind them', () => {
    expect(mergeWidgetOrder(['a', 'retired', 'b'], ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('inserts a new widget after its registry predecessor, not at the end', () => {
    // Appending is the obvious reading of "append newly required widgets" and it is wrong the first
    // time a new widget belongs near the top: `queue` is registry-first and the user has never seen it.
    expect(mergeWidgetOrder(['c', 'a'], ['queue', 'a', 'b', 'c'])).toEqual(['queue', 'c', 'a', 'b'])
  })

  it('keeps consecutive newcomers in registry order relative to each other', () => {
    expect(mergeWidgetOrder(['a'], ['a', 'x', 'y', 'z'])).toEqual(['a', 'x', 'y', 'z'])
  })

  it('never swaps a pair the user arranged', () => {
    /*
     * The property that matters most: a deploy may insert widgets anywhere, but it may not scramble
     * what someone deliberately set. Checked as a relation over every saved pair rather than against
     * one expected array, so it holds for insertions this test did not think of.
     */
    const saved = ['d', 'b', 'a']
    const merged = mergeWidgetOrder(saved, ['a', 'b', 'c', 'd', 'e', 'f'])
    const positions = saved.map((id) => merged.indexOf(id))
    expect([...positions].sort((x, y) => x - y)).toEqual(positions)
    expect(merged).toHaveLength(6)
  })

  it('returns the registry itself when nothing has been saved', () => {
    expect(mergeWidgetOrder([], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })
})
