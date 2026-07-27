/**
 * Reads and writes the per-surface robots directives.
 *
 * Read path (`publicDb`, the plain web-runtime role) runs on every render of an
 * affected public page, on `robots.txt` and on `sitemap.xml`, so it is memoized
 * for a few seconds — long enough that a crawl does not become a query per
 * request, short enough that flipping a switch in the admin panel is visible
 * almost immediately.
 *
 * Write path uses `platformDb`: this is platform configuration, not tenant data.
 */
import { inArray } from 'drizzle-orm'
import { platformDb, publicDb } from '../db/client'
import { publicSurfaceIndexing } from '../db/schema'
import {
  DEFAULT_DIRECTIVES,
  SEO_SURFACES,
  type RobotsDirectives,
  type SeoSurface,
} from '../seo/surfaces'

export type SurfaceDirectiveMap = Record<SeoSurface, RobotsDirectives>

function allDefaults(): SurfaceDirectiveMap {
  return Object.fromEntries(SEO_SURFACES.map((surface) => [surface, { ...DEFAULT_DIRECTIVES }])) as SurfaceDirectiveMap
}

const TTL_MS = 5_000
let cache: { value: SurfaceDirectiveMap; at: number } | null = null

/** Drops the memo so the next read reflects a write made in this process. */
export function invalidateSurfaceIndexingCache(): void {
  cache = null
}

/**
 * Every surface's directives, defaults filled in for surfaces with no row.
 *
 * Never throws: a failed lookup returns the fail-closed defaults, because the
 * alternative is a 500 on a public marketing page over a robots meta tag.
 */
export async function getSurfaceDirectives(now = Date.now()): Promise<SurfaceDirectiveMap> {
  if (cache && now - cache.at < TTL_MS) return cache.value

  const value = allDefaults()
  try {
    const rows = await publicDb
      .select({
        surface: publicSurfaceIndexing.surface,
        noindex: publicSurfaceIndexing.noindex,
        nofollow: publicSurfaceIndexing.nofollow,
      })
      .from(publicSurfaceIndexing)
      .where(inArray(publicSurfaceIndexing.surface, [...SEO_SURFACES]))
    for (const row of rows) {
      // `inArray` already filters, but a row for a retired surface would still
      // key an object we then hand to callers typed as SurfaceDirectiveMap.
      if (row.surface in value) {
        value[row.surface as SeoSurface] = { noindex: row.noindex, nofollow: row.nofollow }
      }
    }
    cache = { value, at: now }
  } catch (error) {
    console.error('surface indexing lookup failed — applying noindex defaults:', error)
  }
  return value
}

export async function getSurfaceRobots(surface: SeoSurface): Promise<RobotsDirectives> {
  return (await getSurfaceDirectives())[surface]
}

/** Platform-admin write. Upserts, so a surface with no row yet gets one. */
export async function setSurfaceDirectives(
  surface: SeoSurface,
  directives: RobotsDirectives,
  updatedBy: string | null,
): Promise<RobotsDirectives> {
  const [row] = await platformDb
    .insert(publicSurfaceIndexing)
    .values({ surface, noindex: directives.noindex, nofollow: directives.nofollow, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: publicSurfaceIndexing.surface,
      set: {
        noindex: directives.noindex,
        nofollow: directives.nofollow,
        updatedBy,
        updatedAt: new Date(),
      },
    })
    .returning({ noindex: publicSurfaceIndexing.noindex, nofollow: publicSurfaceIndexing.nofollow })
  invalidateSurfaceIndexingCache()
  return row ?? directives
}

/** Admin-panel projection: current directives plus who last touched them. */
export async function listSurfaceIndexingForAdmin() {
  const rows = await platformDb
    .select({
      surface: publicSurfaceIndexing.surface,
      noindex: publicSurfaceIndexing.noindex,
      nofollow: publicSurfaceIndexing.nofollow,
      updatedAt: publicSurfaceIndexing.updatedAt,
      updatedBy: publicSurfaceIndexing.updatedBy,
    })
    .from(publicSurfaceIndexing)
  const bySurface = new Map(rows.map((row) => [row.surface, row]))
  return SEO_SURFACES.map((surface) => {
    const row = bySurface.get(surface)
    return {
      surface,
      noindex: row?.noindex ?? DEFAULT_DIRECTIVES.noindex,
      nofollow: row?.nofollow ?? DEFAULT_DIRECTIVES.nofollow,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
      /** False when the row does not exist yet and the fail-closed default applies. */
      persisted: row !== undefined,
    }
  })
}
