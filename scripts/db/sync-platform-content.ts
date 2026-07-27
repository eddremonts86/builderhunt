/**
 * sync-platform-content.ts — make the database's public content match `content/`.
 *
 * The public /changelog and /roadmap pages read Postgres. Postgres is not in
 * git. Before this script the only way to put an entry on the live site was to
 * type it into the admin panel of that specific environment, which meant local
 * and production always disagreed and a restore onto a fresh volume lost the
 * lot. `content/changelog/*.md` and `content/roadmap/*.md` are the committed
 * source; this pushes them in.
 *
 * Usage:
 *   pnpm content:sync                 # upsert every file into the database
 *   pnpm content:sync --dry-run       # print the plan, change nothing
 *   pnpm content:sync --prune         # also delete file-managed rows whose file is gone
 *   pnpm content:sync --export        # opposite direction: database rows -> files
 *
 * Guarantees:
 *   - Idempotent. Re-running changes nothing unless a file changed.
 *   - Never touches rows it does not own. File-managed rows have deterministic
 *     ids (`content-changelog-<slug>` / `content-roadmap-<slug>`); anything
 *     created in the admin UI has a random id and is left alone, including by
 *     --prune.
 *   - Preserves `shipped_at` on a roadmap item that was already shipped, and
 *     preserves roadmap votes, because ids are stable across runs.
 *
 * Connects as `DATABASE_PLATFORM_URL` when set (the role that migration 0012
 * grants INSERT/UPDATE/DELETE on these three tables) and falls back to
 * `DATABASE_URL`, which is the DB owner locally.
 */

import postgres from 'postgres'

import {
  CHANGELOG_ID_PREFIX,
  ROADMAP_ID_PREFIX,
  changelogEntryId,
  loadChangelogSource,
  loadRoadmapSource,
  roadmapItemId,
  serializeChangelogEntry,
  serializeRoadmapItem,
  type ChangelogSourceEntry,
  type RoadmapSourceItem,
} from '../../src/shared/lib/platform-content-source.ts'

const DRY_RUN = process.argv.includes('--dry-run')
const PRUNE = process.argv.includes('--prune')
const EXPORT = process.argv.includes('--export')

const DATABASE_URL = process.env.DATABASE_PLATFORM_URL ?? process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('❌  Neither DATABASE_PLATFORM_URL nor DATABASE_URL is set.')
  process.exit(1)
}

type Sql = ReturnType<typeof postgres>

async function pushChangelog(sql: Sql, entries: ChangelogSourceEntry[]) {
  let inserted = 0
  let updated = 0
  for (const entry of entries) {
    const id = changelogEntryId(entry.slug)
    // `published_at` is derived from the file's `date`, so re-dating an entry in
    // the file re-orders it on the public page. `created_at` is left at whatever
    // the first insert set — it is the row's age, not the entry's date.
    const rows = await sql`
      INSERT INTO changelog (id, title, content, slug, tags, published_at)
      VALUES (
        ${id}, ${entry.title}, ${entry.content}, ${entry.slug},
        ${sql.json(entry.tags)}, ${new Date(`${entry.date}T12:00:00Z`)}
      )
      ON CONFLICT (slug) DO UPDATE SET
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        tags = EXCLUDED.tags,
        published_at = EXCLUDED.published_at
      RETURNING (xmax = 0) AS was_inserted
    `
    if (rows[0]?.was_inserted) inserted++
    else updated++
  }
  return { inserted, updated }
}

async function pushRoadmap(sql: Sql, items: RoadmapSourceItem[]) {
  let inserted = 0
  let updated = 0
  for (const item of items) {
    const id = roadmapItemId(item.slug)
    // shipped_at: set once, on the run that first sees `status: shipped`, and
    // preserved afterwards. Recomputing it every run would make the public
    // "shipped" date the date of the last deploy.
    const rows = await sql`
      INSERT INTO roadmap_items (
        id, title, description, status, ship_estimate, category, sort_order, shipped_at
      )
      VALUES (
        ${id}, ${item.title}, ${item.description}, ${item.status},
        ${item.shipEstimate}, ${item.category}, ${item.order},
        ${item.status === 'shipped' ? new Date() : null}
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        ship_estimate = EXCLUDED.ship_estimate,
        category = EXCLUDED.category,
        sort_order = EXCLUDED.sort_order,
        shipped_at = CASE
          WHEN EXCLUDED.status = 'shipped' THEN COALESCE(roadmap_items.shipped_at, now())
          ELSE NULL
        END,
        updated_at = now()
      RETURNING (xmax = 0) AS was_inserted
    `
    if (rows[0]?.was_inserted) inserted++
    else updated++
  }
  return { inserted, updated }
}

async function prune(sql: Sql, changelogSlugs: string[], roadmapIds: string[]) {
  // `<> ALL(...)` with an empty array is true for every row, which is the
  // correct behaviour: no files means every file-managed row is orphaned.
  const changelog = await sql`
    DELETE FROM changelog
    WHERE id LIKE ${`${CHANGELOG_ID_PREFIX}%`}
      AND slug <> ALL(${sql.array(changelogSlugs)}::text[])
    RETURNING slug
  `
  const roadmap = await sql`
    DELETE FROM roadmap_items
    WHERE id LIKE ${`${ROADMAP_ID_PREFIX}%`}
      AND id <> ALL(${sql.array(roadmapIds)}::text[])
    RETURNING id
  `
  return {
    changelog: changelog.map((r) => r.slug as string),
    roadmap: roadmap.map((r) => (r.id as string).slice(ROADMAP_ID_PREFIX.length)),
  }
}

/**
 * Database -> files. This is how an entry drafted in the admin UI becomes
 * committed content: export, review the diff, commit. Rows the admin UI created
 * get a slug-derived filename so they round-trip on the next push.
 */
async function exportToFiles(sql: Sql) {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const root = join(process.cwd(), 'content')

  const changelogRows = await sql`
    SELECT title, content, slug, tags, published_at FROM changelog ORDER BY published_at DESC
  `
  const roadmapRows = await sql`
    SELECT id, title, description, status, ship_estimate, category, sort_order
    FROM roadmap_items ORDER BY sort_order ASC
  `

  await mkdir(join(root, 'changelog'), { recursive: true })
  await mkdir(join(root, 'roadmap'), { recursive: true })

  for (const row of changelogRows) {
    const file = serializeChangelogEntry({
      slug: row.slug as string,
      title: row.title as string,
      date: (row.published_at as Date).toISOString().slice(0, 10),
      tags: (row.tags as string[]) ?? [],
      content: row.content as string,
    })
    await writeFile(join(root, 'changelog', `${row.slug}.md`), file)
  }

  for (const row of roadmapRows) {
    const id = row.id as string
    const slug = id.startsWith(ROADMAP_ID_PREFIX) ? id.slice(ROADMAP_ID_PREFIX.length) : slugify(row.title as string)
    const file = serializeRoadmapItem({
      slug,
      title: row.title as string,
      description: (row.description as string | null) ?? '',
      status: row.status as 'planned' | 'in_progress' | 'shipped',
      category: (row.category as string | null) ?? 'general',
      shipEstimate: (row.ship_estimate as string | null) ?? null,
      order: row.sort_order as number,
    })
    await writeFile(join(root, 'roadmap', `${slug}.md`), file)
  }

  return { changelog: changelogRows.length, roadmap: roadmapRows.length }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 100)
}

async function main() {
  const sql = postgres(DATABASE_URL!, { max: 1, prepare: false })
  try {
    if (EXPORT) {
      const counts = await exportToFiles(sql)
      console.log(`✅  exported ${counts.changelog} changelog entries and ${counts.roadmap} roadmap items to content/`)
      console.log('    review the diff and commit — files are what deploys.')
      return
    }

    // Parsing happens before any write: a malformed file must fail the whole
    // run, not leave the database half-updated.
    const [entries, items] = await Promise.all([loadChangelogSource(), loadRoadmapSource()])
    console.log(`📄  ${entries.length} changelog entries, ${items.length} roadmap items in content/`)

    if (DRY_RUN) {
      for (const entry of entries) console.log(`    changelog ${entry.date}  ${entry.slug}`)
      for (const item of items) console.log(`    roadmap   ${item.status.padEnd(11)} ${item.slug}`)
      console.log('(dry-run — nothing written)')
      return
    }

    const changelog = await pushChangelog(sql, entries)
    const roadmap = await pushRoadmap(sql, items)
    console.log(`✅  changelog: ${changelog.inserted} inserted, ${changelog.updated} updated`)
    console.log(`✅  roadmap:   ${roadmap.inserted} inserted, ${roadmap.updated} updated`)

    if (PRUNE) {
      const removed = await prune(sql, entries.map((e) => e.slug), items.map((i) => roadmapItemId(i.slug)))
      const total = removed.changelog.length + removed.roadmap.length
      console.log(
        total === 0
          ? '✅  prune: nothing orphaned'
          : `🗑   prune: removed ${[...removed.changelog, ...removed.roadmap].join(', ')}`,
      )
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error('❌  content sync failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
