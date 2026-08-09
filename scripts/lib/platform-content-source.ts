// Server-only: the committed, file-based source of truth for the two public
// platform-content surfaces that live in Postgres — `changelog` and
// `roadmap_items`.
//
// Why files at all, when both tables already have an admin CRUD UI: a row
// typed into the admin panel exists only in whichever database it was typed
// into. It is not in git, it is not in a review, and it does not survive a
// restore onto a fresh volume. Everything under `content/` is committed,
// deploys with the image (see `COPY content ./content` in the Dockerfile) and
// is pushed into the database idempotently by `pnpm content:sync`.
//
// The division of labour, so neither side surprises the other:
//   - files own the entries they define, keyed by slug. `content:sync` upserts
//     those on every run, so editing a file and deploying updates production.
//   - the admin UI owns everything else. Rows it creates have random ids and
//     slugs that appear in no file, and `content:sync` never touches them
//     (`--prune` is opt-in, and even then only removes file-managed ids).
//   - `pnpm content:sync --export` writes the current database rows back out
//     as files, which is how an entry drafted in the admin UI becomes
//     committed content instead of a row that only one environment has.
//
// Parsing is split from reading so the validation rules are unit-testable
// without touching the filesystem (see tests/unit/shared/lib/platform-content-source.test.ts).

import matter from 'gray-matter'
import { z } from 'zod'

export const ROADMAP_STATUSES = ['planned', 'in_progress', 'shipped'] as const
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number]

/** Kept in step with the tag chips the public /changelog page knows how to colour. */
export const CHANGELOG_TAGS = ['feature', 'improvement', 'bugfix', 'breaking'] as const

export interface ChangelogSourceEntry {
  slug: string
  title: string
  /** `YYYY-MM-DD`. Becomes `changelog.published_at`. */
  date: string
  tags: string[]
  /** Markdown body. */
  content: string
}

export interface RoadmapSourceItem {
  slug: string
  title: string
  description: string
  status: RoadmapStatus
  category: string
  shipEstimate: string | null
  /** Ascending display order within the public board. Becomes `roadmap_items.sort_order`. */
  order: number
}

const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9-]+$/, 'must be lowercase letters, numbers and dashes only')

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date, YYYY-MM-DD')

const changelogFrontmatterSchema = z.object({
  title: z.string().min(1).max(200),
  slug: slugSchema,
  date: dateSchema,
  tags: z.array(z.string().min(1)).default([]),
})

const roadmapFrontmatterSchema = z.object({
  title: z.string().min(1).max(200),
  slug: slugSchema,
  status: z.enum(ROADMAP_STATUSES),
  category: z.string().min(1).max(40).default('general'),
  ship_estimate: z.string().min(1).max(60).nullable().default(null),
  order: z.number().int(),
})

/**
 * `date:` unquoted in YAML is parsed by gray-matter into a `Date`, and a
 * `Date` fails `dateSchema`. Normalizing before validation means an author
 * can write either `2026-07-27` or `'2026-07-27'` and get the same result,
 * which is the same normalization `blog.ts` does for post dates.
 */
function normalizeDate(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'string') return value.slice(0, 10)
  return value
}

function describeIssues(filename: string, error: z.ZodError): never {
  const detail = error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
  throw new Error(`${filename}: invalid frontmatter — ${detail}`)
}

/** Basename without its extension, used to cross-check the declared slug. */
function basename(filename: string): string {
  const last = filename.split('/').pop() ?? filename
  return last.replace(/\.md$/, '')
}

export function parseChangelogFile(raw: string, filename: string): ChangelogSourceEntry {
  const { data, content } = matter(raw)
  const parsed = changelogFrontmatterSchema.safeParse({
    ...data,
    date: normalizeDate((data as { date?: unknown }).date),
  })
  if (!parsed.success) describeIssues(filename, parsed.error)

  const body = content.trim()
  if (!body) throw new Error(`${filename}: body is empty — a changelog entry needs content`)
  if (parsed.data.slug !== basename(filename)) {
    throw new Error(
      `${filename}: slug "${parsed.data.slug}" does not match the filename — ` +
        'the public URL is /changelog/<slug>, so the two must agree',
    )
  }
  return { ...parsed.data, content: body }
}

export function parseRoadmapFile(raw: string, filename: string): RoadmapSourceItem {
  const { data, content } = matter(raw)
  const parsed = roadmapFrontmatterSchema.safeParse(data)
  if (!parsed.success) describeIssues(filename, parsed.error)

  const description = content.trim()
  if (!description) throw new Error(`${filename}: body is empty — a roadmap item needs a description`)
  if (parsed.data.slug !== basename(filename)) {
    throw new Error(`${filename}: slug "${parsed.data.slug}" does not match the filename`)
  }
  return {
    slug: parsed.data.slug,
    title: parsed.data.title,
    description,
    status: parsed.data.status,
    category: parsed.data.category,
    shipEstimate: parsed.data.ship_estimate,
    order: parsed.data.order,
  }
}

/**
 * Deterministic primary keys. A row's id is derivable from its slug, which is
 * what makes the sync idempotent across environments and lets `--prune`
 * recognize which rows it is allowed to remove.
 */
export function changelogEntryId(slug: string): string {
  return `content-changelog-${slug}`
}

export function roadmapItemId(slug: string): string {
  return `content-roadmap-${slug}`
}

export const CHANGELOG_ID_PREFIX = 'content-changelog-'
export const ROADMAP_ID_PREFIX = 'content-roadmap-'

/** A duplicate slug would make the second entry silently overwrite the first. */
function assertUniqueSlugs(slugs: string[], kind: string): void {
  const seen = new Set<string>()
  for (const slug of slugs) {
    if (seen.has(slug)) throw new Error(`duplicate ${kind} slug "${slug}"`)
    seen.add(slug)
  }
}

async function readMarkdownDir(dir: string): Promise<Array<{ filename: string; raw: string }>> {
  const { readdir, readFile } = await import('fs/promises')
  const { join } = await import('path')
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  // `_`-prefixed files are authoring scaffolding, same convention as content/posts.
  const markdown = files.filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort()
  return Promise.all(
    markdown.map(async (filename) => ({ filename, raw: await readFile(join(dir, filename), 'utf-8') })),
  )
}

export function contentRoot(): string {
  return `${process.cwd()}/content`
}

export async function loadChangelogSource(dir = `${contentRoot()}/changelog`): Promise<ChangelogSourceEntry[]> {
  const files = await readMarkdownDir(dir)
  const entries = files.map(({ filename, raw }) => parseChangelogFile(raw, filename))
  assertUniqueSlugs(entries.map((e) => e.slug), 'changelog')
  // Newest first, same order the public page renders.
  return entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug < b.slug ? -1 : 1))
}

export async function loadRoadmapSource(dir = `${contentRoot()}/roadmap`): Promise<RoadmapSourceItem[]> {
  const files = await readMarkdownDir(dir)
  const items = files.map(({ filename, raw }) => parseRoadmapFile(raw, filename))
  assertUniqueSlugs(items.map((i) => i.slug), 'roadmap')
  return items.sort((a, b) => a.order - b.order || (a.slug < b.slug ? -1 : 1))
}

/** Serializes an entry back to the exact on-disk shape `parseChangelogFile` accepts. */
export function serializeChangelogEntry(entry: ChangelogSourceEntry): string {
  const tags = entry.tags.length > 0 ? `[${entry.tags.join(', ')}]` : '[]'
  return [
    '---',
    `title: ${yamlScalar(entry.title)}`,
    `slug: ${entry.slug}`,
    `date: ${entry.date}`,
    `tags: ${tags}`,
    '---',
    '',
    entry.content.trim(),
    '',
  ].join('\n')
}

export function serializeRoadmapItem(item: RoadmapSourceItem): string {
  return [
    '---',
    `title: ${yamlScalar(item.title)}`,
    `slug: ${item.slug}`,
    `status: ${item.status}`,
    `category: ${item.category}`,
    `ship_estimate: ${item.shipEstimate === null ? 'null' : yamlScalar(item.shipEstimate)}`,
    `order: ${item.order}`,
    '---',
    '',
    item.description.trim(),
    '',
  ].join('\n')
}

/**
 * Quotes only when YAML would otherwise misread the value — a leading `-`, a
 * `:` followed by a space, or a leading/trailing space. Titles are prose, so
 * blanket-quoting would make every file noisier to read in a diff.
 */
function yamlScalar(value: string): string {
  const needsQuotes = /^[-?:,[\]{}#&*!|>'"%@`]|: |\s$|^\s/.test(value) || value.includes('\n')
  if (!needsQuotes) return value
  return `'${value.replace(/'/g, "''")}'`
}
