import { and, eq, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { dashboardPreferences } from '../db/schema'

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
 */

export interface DashboardPreferences {
  density: 'bento' | 'sections'
  hiddenWidgetIds: string[]
}

export const DEFAULT_DASHBOARD_PREFERENCES: DashboardPreferences = {
  density: 'bento',
  hiddenWidgetIds: [],
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
    })
    .from(dashboardPreferences)
    .where(and(
      eq(dashboardPreferences.organizationId, organizationId),
      eq(dashboardPreferences.userId, userId),
    ))
    .limit(1)

  if (!row) return DEFAULT_DASHBOARD_PREFERENCES
  return {
    // The CHECK constrains the column, so this narrowing is about the *type*, not about trusting the
    // database — a value that violated it could not have been written.
    density: row.density === 'sections' ? 'sections' : 'bento',
    hiddenWidgetIds: Array.isArray(row.hiddenWidgetIds) ? row.hiddenWidgetIds : [],
  }
}

/**
 * Writes the whole preference, creating the row if it is the user's first change.
 *
 * An upsert rather than read-then-write: two tabs saving at once would otherwise both see "no row"
 * and both insert, and one would get a primary-key violation it has nothing useful to do with. The
 * loser here simply overwrites, which is what "the last change wins" means for a layout preference —
 * there is no merge worth doing between two versions of "which widgets I hid".
 */
export async function saveDashboardPreferences(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
  preferences: DashboardPreferences,
): Promise<void> {
  await transaction
    .insert(dashboardPreferences)
    .values({
      organizationId,
      userId,
      density: preferences.density,
      hiddenWidgetIds: preferences.hiddenWidgetIds,
    })
    .onConflictDoUpdate({
      target: [dashboardPreferences.organizationId, dashboardPreferences.userId],
      set: {
        density: preferences.density,
        hiddenWidgetIds: preferences.hiddenWidgetIds,
        updatedAt: sql`now()`,
      },
    })
}
