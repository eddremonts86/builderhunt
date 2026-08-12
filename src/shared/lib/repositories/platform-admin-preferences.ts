import { eq } from 'drizzle-orm'
import { platformDb } from '../db/client'
import { platformAdminPreferences } from '../db/schema'
import {
  ADMIN_METRIC_RANGES,
  ADMIN_METRIC_SECTIONS,
  variantsFor,
  type AdminMetricRange,
  type AdminMetricSection,
} from '../admin-metrics/contracts'

/**
 * Platform-admin console preferences (plan 57, Admin track — "Persist isolated platform-admin preferences").
 *
 * ## The isolation, and where it actually lives
 *
 * In the grants, not here. `platform_admin_preferences` is granted to `builderhunt_platform` and
 * `builderhunt_readonly`; `builderhunt_app` has no grant at all, so a tenant-scoped query is refused by Postgres
 * with 42501 rather than by a `WHERE` clause somebody has to remember. Verified against the real database:
 * connecting as the app role and selecting from this table answers `permission denied for table
 * platform_admin_preferences`.
 *
 * That is why this is a separate table rather than a column on `dashboard_preferences` — see the migration for the
 * full reasoning, but the short version is that the tenant table's RLS predicate scopes every row to
 * `app.organization_id`, and a platform admin has no organization in the admin console.
 *
 * ## Why a stored value is validated on read, not trusted
 *
 * The columns are plain text with a length check. The section, range and variant vocabularies live in
 * `admin-metrics/contracts.ts`, and a `CHECK` constraint naming them would be a second copy that drifts the first
 * time a section is added. So the allowlist is applied here, on the way out — which also handles the case a
 * constraint could never handle: a preference that was valid when it was written and names a section this build
 * has since removed. That is expected rather than exceptional, and it falls back instead of failing.
 */

/** Widgets an admin may not hide, because they are how somebody finds out something is wrong. */
export const REQUIRED_ADMIN_WIDGETS = [
  /**
   * The action queue. Hiding it is the one preference that could cost money or a legal deadline: it is the panel
   * that says a webhook is dead-lettered or a removal request is past its date, and it is *already* absent
   * whenever it has nothing to say. A control to hide it would only ever be used on a day it had a row.
   */
  'action_queue',
] as const

export interface PlatformAdminPreferences {
  landing: { section: AdminMetricSection; range: AdminMetricRange; variant: string }
  hiddenWidgetIds: string[]
  version: number
}

/** The shape this build writes and reads. Bumped when a stored row stops being readable as-is. */
export const PLATFORM_ADMIN_PREFERENCES_VERSION = 1

const DEFAULTS: PlatformAdminPreferences = {
  landing: { section: 'overview', range: '24h', variant: 'summary' },
  hiddenWidgetIds: [],
  version: PLATFORM_ADMIN_PREFERENCES_VERSION,
}

/**
 * Normalizes a stored row against this build's vocabularies.
 *
 * Every field falls back independently: a row naming a section this build removed keeps its range. And the variant
 * is resolved *against the resolved section*, for the same reason the URL state does it that way — carrying one
 * section's variant onto another produces a request the API refuses.
 */
function normalize(row: {
  landingSection: string
  landingRange: string
  landingVariant: string
  hiddenWidgetIds: string[]
  version: number
}): PlatformAdminPreferences {
  const section = ADMIN_METRIC_SECTIONS.find((candidate) => candidate === row.landingSection) ?? 'overview'
  const range = ADMIN_METRIC_RANGES.find((candidate) => candidate === row.landingRange) ?? '24h'
  const allowed = variantsFor(section)
  const variant = allowed.find((candidate) => candidate === row.landingVariant) ?? allowed[0]

  return {
    landing: { section, range, variant },
    /**
     * A required widget in the stored list is dropped on read as well as refused on write.
     *
     * Refusing the write is the guard; dropping on read is what makes a row written by an older build — or by a
     * direct database edit — unable to hide the action queue anyway. A permission enforced only at the door is a
     * permission that a pre-existing row walks past.
     */
    hiddenWidgetIds: row.hiddenWidgetIds.filter(
      (id) => !(REQUIRED_ADMIN_WIDGETS as readonly string[]).includes(id),
    ),
    version: row.version,
  }
}

/**
 * This admin's preferences, or the defaults.
 *
 * A row from a *future* version returns the defaults rather than being read field by field. Reading forward means
 * guessing what a shape you have never seen means, and the failure is silent — the console would open somewhere
 * the admin did not choose and there would be nothing to notice. Defaults are visibly wrong, which is better.
 */
export async function readPlatformAdminPreferences(userId: string): Promise<PlatformAdminPreferences> {
  const [row] = await platformDb
    .select()
    .from(platformAdminPreferences)
    .where(eq(platformAdminPreferences.userId, userId))
    .limit(1)

  if (!row) return DEFAULTS
  if (row.version > PLATFORM_ADMIN_PREFERENCES_VERSION) return DEFAULTS
  return normalize(row)
}

export interface PlatformAdminPreferencesUpdate {
  section?: string
  range?: string
  variant?: string
  hiddenWidgetIds?: string[]
}

export type SavePlatformAdminPreferencesResult =
  | { ok: true; preferences: PlatformAdminPreferences }
  | { ok: false; error: 'required_widget_hidden'; widgetId: string }

/**
 * Upserts this admin's preferences, refusing to hide a required widget.
 *
 * The refusal is an explicit result rather than a silent filter, because the two are different messages: silently
 * dropping the id would tell the client its request succeeded and then not honour it, and the next read would
 * disagree with what the UI showed. A named error is something a control can render.
 *
 * Whatever is not supplied is left alone. An update that meant to change the range should not reset the landing
 * section as a side effect of the client not sending it.
 */
export async function savePlatformAdminPreferences(
  userId: string,
  update: PlatformAdminPreferencesUpdate,
): Promise<SavePlatformAdminPreferencesResult> {
  const requiredHidden = (update.hiddenWidgetIds ?? []).find((id) =>
    (REQUIRED_ADMIN_WIDGETS as readonly string[]).includes(id),
  )
  if (requiredHidden) {
    return { ok: false, error: 'required_widget_hidden', widgetId: requiredHidden }
  }

  const current = await readPlatformAdminPreferences(userId)
  // Normalized before the write, so an invalid value is refused storage rather than stored and corrected on every
  // subsequent read. The column length checks are a backstop for a direct database edit, not the validation.
  const next = normalize({
    landingSection: update.section ?? current.landing.section,
    landingRange: update.range ?? current.landing.range,
    landingVariant: update.variant ?? current.landing.variant,
    hiddenWidgetIds: update.hiddenWidgetIds ?? current.hiddenWidgetIds,
    version: PLATFORM_ADMIN_PREFERENCES_VERSION,
  })

  await platformDb
    .insert(platformAdminPreferences)
    .values({
      userId,
      landingSection: next.landing.section,
      landingRange: next.landing.range,
      landingVariant: next.landing.variant,
      hiddenWidgetIds: next.hiddenWidgetIds,
      version: PLATFORM_ADMIN_PREFERENCES_VERSION,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: platformAdminPreferences.userId,
      set: {
        landingSection: next.landing.section,
        landingRange: next.landing.range,
        landingVariant: next.landing.variant,
        hiddenWidgetIds: next.hiddenWidgetIds,
        version: PLATFORM_ADMIN_PREFERENCES_VERSION,
        updatedAt: new Date(),
      },
    })

  return { ok: true, preferences: next }
}
