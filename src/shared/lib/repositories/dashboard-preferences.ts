import { and, eq, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { dashboardPreferences } from '../db/schema'
import {
  DASHBOARD_PREFERENCES_SCHEMA_VERSION,
  DEFAULT_PREFERENCES_DOCUMENT,
  migratePreferenceDocument,
  type DashboardPreferencesDocument,
  type DashboardPreferencesWrite,
} from '../dashboard/preferences-contract'

/**
 * Dashboard layout preferences, per (organization, user) — plans/ui-dashboard Wave 6.
 *
 * ## What was wrong with local storage
 *
 * Structural problem 10: density lived in `window.localStorage` under a single key. Two consequences,
 * and the second is the one that mattered. It was per *browser*, so the same person got a different
 * dashboard on their laptop and their phone and lost both when they cleared site data. And it was
 * keyed by nothing, so switching organizations carried one workspace's layout into another — hide
 * Billing in a personal workspace and it stays hidden in the team's, where a different person's
 * decisions apply.
 *
 * ## Reads never fail the page
 *
 * `getDashboardPreferences` returns the defaults when there is no row, and the caller treats a thrown
 * error the same way. A layout preference is not worth a broken dashboard, and the default layout is
 * a correct answer to "what should this person see" — just not their preferred one.
 *
 * ## Writes can fail, and say why
 *
 * A save carries the revision it read. When they differ the write is refused rather than applied,
 * because an arrangement is not a toggle: two tabs each moving one widget produce two complete
 * sequences, and last-write-wins throws away an entire layout instead of one switch.
 */

export type DashboardPreferences = DashboardPreferencesDocument

export const DEFAULT_DASHBOARD_PREFERENCES: DashboardPreferences = DEFAULT_PREFERENCES_DOCUMENT

/** Narrows a jsonb column typed `string[]`. The CHECK guarantees an array; this filters its contents. */
function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

export async function getDashboardPreferences(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
): Promise<DashboardPreferences> {
  const [row] = await transaction
    .select({
      density: dashboardPreferences.density,
      hiddenWidgetIds: dashboardPreferences.hiddenWidgetIds,
      pinnedWidgetIds: dashboardPreferences.pinnedWidgetIds,
      orderedWidgetIds: dashboardPreferences.orderedWidgetIds,
      schemaVersion: dashboardPreferences.schemaVersion,
      revision: dashboardPreferences.revision,
    })
    .from(dashboardPreferences)
    .where(and(
      eq(dashboardPreferences.organizationId, organizationId),
      eq(dashboardPreferences.userId, userId),
    ))
    .limit(1)

  if (!row) return DEFAULT_DASHBOARD_PREFERENCES

  return migratePreferenceDocument({
    // The CHECK constrains the column, so this narrowing is about the *type*, not about trusting the
    // database — a value that violated it could not have been written.
    density: row.density === 'sections' ? 'sections' : 'bento',
    hiddenWidgetIds: idList(row.hiddenWidgetIds),
    pinnedWidgetIds: idList(row.pinnedWidgetIds),
    orderedWidgetIds: idList(row.orderedWidgetIds),
    schemaVersion: row.schemaVersion,
    revision: row.revision,
  })
}

export type SavePreferencesResult =
  | { ok: true; document: DashboardPreferences }
  /** Somebody else saved first. `current` is the winning document, so the caller can hand it back. */
  | { ok: false; reason: 'conflict'; current: DashboardPreferences }

/**
 * Writes the whole preference, creating the row if it is the user's first change.
 *
 * An upsert rather than read-then-write: two tabs saving at once would otherwise both see "no row"
 * and both insert, and one would get a primary-key violation it has nothing useful to do with.
 *
 * The conflict check rides on the upsert's `where` rather than on a prior `SELECT`. Between a read
 * and a write there is a window in which the other tab commits, and a check performed in that window
 * passes and then overwrites — the exact race the revision exists to close. Postgres evaluates the
 * `WHERE` on the conflicting row inside the same statement, so there is no window at all.
 *
 * `RETURNING` needs the SELECT grant as well as the write grant; `builderhunt_app` has both. A
 * write-only role fails here even though the plain write succeeds, which is a mistake this repository
 * has made before.
 */
export async function saveDashboardPreferences(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
  preferences: DashboardPreferencesWrite,
): Promise<SavePreferencesResult> {
  const [written] = await transaction
    .insert(dashboardPreferences)
    .values({
      organizationId,
      userId,
      density: preferences.density,
      hiddenWidgetIds: preferences.hiddenWidgetIds,
      pinnedWidgetIds: preferences.pinnedWidgetIds,
      orderedWidgetIds: preferences.orderedWidgetIds,
      schemaVersion: DASHBOARD_PREFERENCES_SCHEMA_VERSION,
      revision: 1,
    })
    .onConflictDoUpdate({
      target: [dashboardPreferences.organizationId, dashboardPreferences.userId],
      set: {
        density: preferences.density,
        hiddenWidgetIds: preferences.hiddenWidgetIds,
        pinnedWidgetIds: preferences.pinnedWidgetIds,
        orderedWidgetIds: preferences.orderedWidgetIds,
        schemaVersion: DASHBOARD_PREFERENCES_SCHEMA_VERSION,
        revision: sql`${dashboardPreferences.revision} + 1`,
        updatedAt: sql`now()`,
      },
      where: eq(dashboardPreferences.revision, preferences.revision),
    })
    .returning({ revision: dashboardPreferences.revision })

  if (!written) {
    /*
     * No row came back, so the `WHERE` refused the update. Re-read to tell the caller what won.
     *
     * The read cannot come up empty: nothing deletes a preference row, and a conflict proves one
     * exists. If it somehow does, the defaults are still a correct document to reconcile against.
     */
    return {
      ok: false,
      reason: 'conflict',
      current: await getDashboardPreferences(transaction, organizationId, userId),
    }
  }

  return {
    ok: true,
    document: {
      ...preferences,
      schemaVersion: DASHBOARD_PREFERENCES_SCHEMA_VERSION,
      revision: written.revision,
    },
  }
}
