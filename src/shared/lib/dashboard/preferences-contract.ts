import { z } from 'zod'

/**
 * The dashboard preference document, parsed on both sides (plans/ui-dashboard Wave 6, "Persist
 * versioned per-user/per-organization preferences").
 *
 * ## Two numbers, because they answer different questions
 *
 * `schemaVersion` describes the *shape* of the document and changes when a deploy changes it.
 * `revision` counts *writes* and changes on every save. Collapsing them into one integer — which was
 * the first thing I tried — makes "is this document old enough to need migrating?" and "did somebody
 * else save while I was editing?" the same question, and they have different answers and different
 * remedies: one is a read-time transform, the other is a 409.
 *
 * ## Why optimistic concurrency at all, when the merge rule is last-write-wins
 *
 * For density and hides it genuinely does not matter — there is nothing to reconcile between two
 * versions of "which widgets I hid", and the loser simply overwrites. Ordering is different. A move
 * is expressed as a whole new sequence, so two tabs each moving a different widget produce two
 * complete orders, and last-write-wins silently discards one *entire arrangement* rather than one
 * toggle. The revision turns that into a refusal the client can recover from by adopting the newer
 * document, which is the only outcome that does not lose work the user can see.
 *
 * ## Every list is bounded, unique, and shaped
 *
 * These are the only user-supplied arrays this product stores and then iterates on every dashboard
 * render. The bound is not really about abuse: a client that appended instead of replacing would grow
 * the row without limit and nothing downstream would notice until the payload got slow. Uniqueness is
 * refused rather than de-duplicated because a duplicate in an *order* is an ambiguous instruction, and
 * silently picking one of the two readings is how a layout drifts.
 *
 * Ids are constrained to the shape a widget id can take. Ids that are merely *unknown* are accepted —
 * see `mergeWidgetOrder` for why that is deliberate rather than lax.
 */

/**
 * Bumped when a stored document needs transforming before this build can read it.
 *
 * 1 — density and hidden ids (`0151`).
 * 2 — pinned ids, ordered ids, and the revision counter (`0153`).
 *
 * Unlike the overview contract's version, a *lower* stored version is normal and expected: rows
 * written before a deploy are migrated on read by `migratePreferenceDocument`. A *higher* one means a
 * rollback, and is handled by reading the fields this build understands rather than by refusing —
 * refusing would hand the user the default layout instead of most of their own.
 */
export const DASHBOARD_PREFERENCES_SCHEMA_VERSION = 2

/**
 * The cap on every id list.
 *
 * Comfortably above the registry (currently 18 widgets) so a user can express a preference about all
 * of them, and far below anything that would make the row worth worrying about.
 */
export const WIDGET_ID_LIST_LIMIT = 40

const widgetIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9:_-]+$/)

const widgetIdListSchema = z
  .array(widgetIdSchema)
  .max(WIDGET_ID_LIST_LIMIT)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'widget ids must be unique',
  })

export const DASHBOARD_DENSITIES = ['bento', 'sections'] as const
export type DashboardDensity = (typeof DASHBOARD_DENSITIES)[number]

/**
 * What a client sends. `schemaVersion` is absent on purpose: the shape of the document is the
 * server's fact about its own storage, not something a browser gets to assert.
 */
export const dashboardPreferencesWriteSchema = z.object({
  /**
   * The revision the client last read. `0` means "I have never read a stored document" — the state a
   * first-time user is in, and the only value that may create the row.
   */
  revision: z.number().int().min(0).max(2_000_000_000),
  density: z.enum(DASHBOARD_DENSITIES),
  hiddenWidgetIds: widgetIdListSchema,
  pinnedWidgetIds: widgetIdListSchema,
  /**
   * The full sequence the user last saw, including widgets they have hidden — so unhiding one
   * restores it to where they put it rather than to wherever the registry happens to place it.
   */
  orderedWidgetIds: widgetIdListSchema,
})
export type DashboardPreferencesWrite = z.infer<typeof dashboardPreferencesWriteSchema>

export const dashboardPreferencesDocumentSchema = dashboardPreferencesWriteSchema.extend({
  schemaVersion: z.number().int().min(1),
})
export type DashboardPreferencesDocument = z.infer<typeof dashboardPreferencesDocumentSchema>

export const DEFAULT_PREFERENCES_DOCUMENT: DashboardPreferencesDocument = {
  schemaVersion: DASHBOARD_PREFERENCES_SCHEMA_VERSION,
  revision: 0,
  density: 'bento',
  hiddenWidgetIds: [],
  pinnedWidgetIds: [],
  orderedWidgetIds: [],
}

/**
 * The body of a refused write, so the client can recover in the same round trip.
 *
 * A bare 409 would force a refetch, and the tab that lost would show its own stale arrangement in the
 * meantime. Returning the winning document means the loser can adopt it immediately and, if it wants,
 * reapply the single change the user just made on top.
 */
export const dashboardPreferencesConflictSchema = z.object({
  error: z.literal('Preferences changed elsewhere'),
  current: dashboardPreferencesDocumentSchema,
})

/**
 * Reads a stored document of any version into the current shape.
 *
 * Additive so far, so every earlier version migrates by filling in what it lacks. That will not always
 * be true; when it stops being true this is the one place that has to know, which is the whole reason
 * the version is stored rather than inferred from which fields are present.
 */
export function migratePreferenceDocument(
  stored: Partial<DashboardPreferencesDocument> & { schemaVersion?: number },
): DashboardPreferencesDocument {
  return {
    ...DEFAULT_PREFERENCES_DOCUMENT,
    ...stored,
    // A stored version *higher* than this build's is a rollback. Reporting it as the current version
    // is the honest answer to "what shape is the object I am handing you", and the fields this build
    // does not know about are simply not read.
    schemaVersion: DASHBOARD_PREFERENCES_SCHEMA_VERSION,
  }
}

/**
 * Reconciles a user's saved sequence with the registry that exists today.
 *
 * ## The rule
 *
 * Saved ids that no longer exist are dropped. A registry widget the user has never seen is inserted
 * **after every widget it follows in registry order** — not appended to the end, which is what
 * "append newly required widgets" would give you and which is wrong the first time a new widget
 * belongs near the top: an action-queue-adjacent widget appended below "Source coverage" is a widget
 * nobody sees.
 *
 * "After every predecessor" rather than "after the nearest one", which is what this did first and
 * what a unit test caught. The two differ exactly when the user has reordered: with a saved sequence
 * of `[beta, alpha]` and a new `gamma` that follows both, the nearest-predecessor rule places gamma
 * above alpha — contradicting the registry for the alpha/gamma pair, about which the user said
 * nothing. Taking the last of them keeps every registry relation the user has not overridden.
 *
 * Consecutive newcomers keep their registry order relative to each other, because each one becomes a
 * predecessor of the next. No saved pair ever swaps: insertion never moves an existing entry past
 * another.
 *
 * ## Why unknown ids survive a round trip but not this function
 *
 * The *storage* keeps an id it does not recognise, because during a rolling deploy one server may not
 * yet have a widget another one does, and dropping the preference on read-then-write would lose a
 * user's hide for the ordinary act of being served by the older instance. This function is about
 * *rendering*, where an id with no widget behind it has nothing to place.
 */
export function mergeWidgetOrder(
  savedOrder: readonly string[],
  registryIds: readonly string[],
): string[] {
  const known = new Set(registryIds)
  const merged = savedOrder.filter((id) => known.has(id))
  const placed = new Set(merged)
  const predecessors: string[] = []

  for (const id of registryIds) {
    if (placed.has(id)) {
      predecessors.push(id)
      continue
    }
    // The furthest-along predecessor decides. A newcomer with none present goes to the front, which
    // is right: everything already there is something it precedes.
    let insertAt = 0
    for (const earlier of predecessors) {
      const at = merged.indexOf(earlier)
      if (at >= insertAt) insertAt = at + 1
    }
    merged.splice(insertAt, 0, id)
    placed.add(id)
    predecessors.push(id)
  }

  return merged
}
