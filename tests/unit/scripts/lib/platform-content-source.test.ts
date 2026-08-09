import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  changelogEntryId,
  loadChangelogSource,
  loadRoadmapSource,
  parseChangelogFile,
  parseRoadmapFile,
  roadmapItemId,
  serializeChangelogEntry,
  serializeRoadmapItem,
} from '../../../../scripts/lib/platform-content-source'

const CHANGELOG = `---
title: A thing shipped
slug: a-thing-shipped
date: 2026-07-27
tags: [feature, improvement]
---

Body copy, with a **bold** word.
`

const ROADMAP = `---
title: A thing planned
slug: a-thing-planned
status: planned
category: features
ship_estimate: null
order: 40
---

Why it matters.
`

describe('parseChangelogFile', () => {
  it('reads frontmatter and trims the body', () => {
    const entry = parseChangelogFile(CHANGELOG, 'a-thing-shipped.md')
    expect(entry).toEqual({
      slug: 'a-thing-shipped',
      title: 'A thing shipped',
      date: '2026-07-27',
      tags: ['feature', 'improvement'],
      content: 'Body copy, with a **bold** word.',
    })
  })

  it('accepts an unquoted YAML date, which gray-matter hands back as a Date', () => {
    // The whole reason normalizeDate exists: `date: 2026-07-27` is a Date here,
    // `date: '2026-07-27'` is a string, and both must produce the same field.
    const quoted = parseChangelogFile(CHANGELOG.replace('date: 2026-07-27', "date: '2026-07-27'"), 'a-thing-shipped.md')
    expect(quoted.date).toBe('2026-07-27')
  })

  it('rejects a slug that does not match the filename', () => {
    // The public URL is /changelog/<slug>; a mismatch publishes at a URL no
    // link in the app points to.
    expect(() => parseChangelogFile(CHANGELOG, 'different-name.md')).toThrow(/does not match the filename/)
  })

  it('rejects an empty body', () => {
    const empty = CHANGELOG.replace('Body copy, with a **bold** word.\n', '')
    expect(() => parseChangelogFile(empty, 'a-thing-shipped.md')).toThrow(/body is empty/)
  })

  it('rejects a malformed date and names the field', () => {
    expect(() => parseChangelogFile(CHANGELOG.replace('2026-07-27', 'July 2026'), 'a-thing-shipped.md')).toThrow(
      /date: must be an ISO date/,
    )
  })

  it('rejects a slug with characters a URL segment cannot carry', () => {
    expect(() => parseChangelogFile(CHANGELOG.replace(/a-thing-shipped/g, 'A Thing'), 'A Thing.md')).toThrow(
      /slug: must be lowercase/,
    )
  })

  it('defaults tags to an empty array rather than failing', () => {
    const entry = parseChangelogFile(CHANGELOG.replace('tags: [feature, improvement]\n', ''), 'a-thing-shipped.md')
    expect(entry.tags).toEqual([])
  })
})

describe('parseRoadmapFile', () => {
  it('maps frontmatter onto the roadmap_items shape', () => {
    expect(parseRoadmapFile(ROADMAP, 'a-thing-planned.md')).toEqual({
      slug: 'a-thing-planned',
      title: 'A thing planned',
      description: 'Why it matters.',
      status: 'planned',
      category: 'features',
      shipEstimate: null,
      order: 40,
    })
  })

  it('keeps a ship estimate as the free text it is', () => {
    const item = parseRoadmapFile(ROADMAP.replace('ship_estimate: null', 'ship_estimate: Q4 2026'), 'a-thing-planned.md')
    expect(item.shipEstimate).toBe('Q4 2026')
  })

  it('rejects a status the database check constraint would not recognize', () => {
    expect(() => parseRoadmapFile(ROADMAP.replace('status: planned', 'status: nearly'), 'a-thing-planned.md')).toThrow(
      /status/,
    )
  })

  it('requires an explicit order so the public column is deterministic', () => {
    expect(() => parseRoadmapFile(ROADMAP.replace('order: 40\n', ''), 'a-thing-planned.md')).toThrow(/order/)
  })
})

describe('deterministic ids', () => {
  it('derives the primary key from the slug, so a re-sync updates instead of duplicating', () => {
    expect(changelogEntryId('a-thing-shipped')).toBe('content-changelog-a-thing-shipped')
    expect(roadmapItemId('a-thing-planned')).toBe('content-roadmap-a-thing-planned')
  })
})

describe('serialize round-trip', () => {
  it('re-parses a serialized changelog entry to the same value', () => {
    const entry = parseChangelogFile(CHANGELOG, 'a-thing-shipped.md')
    expect(parseChangelogFile(serializeChangelogEntry(entry), 'a-thing-shipped.md')).toEqual(entry)
  })

  it('re-parses a serialized roadmap item to the same value', () => {
    const item = parseRoadmapFile(ROADMAP, 'a-thing-planned.md')
    expect(parseRoadmapFile(serializeRoadmapItem(item), 'a-thing-planned.md')).toEqual(item)
  })

  it('quotes a title YAML would otherwise misread', () => {
    const entry = { ...parseChangelogFile(CHANGELOG, 'a-thing-shipped.md'), title: 'Shipped: at last' }
    const reparsed = parseChangelogFile(serializeChangelogEntry(entry), 'a-thing-shipped.md')
    expect(reparsed.title).toBe('Shipped: at last')
  })
})

describe('directory loaders', () => {
  it('sorts changelog newest-first, roadmap by order, and skips _-prefixed scaffolding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-content-'))
    writeFileSync(join(dir, 'older.md'), CHANGELOG.replace('2026-07-27', '2026-07-01').replace(/a-thing-shipped/g, 'older'))
    writeFileSync(join(dir, 'newer.md'), CHANGELOG.replace(/a-thing-shipped/g, 'newer'))
    writeFileSync(join(dir, '_scaffold.md'), CHANGELOG.replace(/a-thing-shipped/g, '_scaffold'))
    expect((await loadChangelogSource(dir)).map((e) => e.slug)).toEqual(['newer', 'older'])

    const roadmapDir = mkdtempSync(join(tmpdir(), 'bh-roadmap-'))
    writeFileSync(join(roadmapDir, 'last.md'), ROADMAP.replace('order: 40', 'order: 90').replace(/a-thing-planned/g, 'last'))
    writeFileSync(join(roadmapDir, 'first.md'), ROADMAP.replace('order: 40', 'order: 10').replace(/a-thing-planned/g, 'first'))
    expect((await loadRoadmapSource(roadmapDir)).map((i) => i.slug)).toEqual(['first', 'last'])
  })

  it('returns nothing rather than throwing when the directory is absent', async () => {
    // The production image copies content/, but a partial checkout or a future
    // build stage that forgets it must degrade to an empty sync, not a crash.
    expect(await loadChangelogSource(join(tmpdir(), 'bh-does-not-exist'))).toEqual([])
  })

  it('fails loudly on two files claiming the same slug', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-dupe-'))
    // Same declared slug, different filenames: the second would silently
    // overwrite the first in the database.
    writeFileSync(join(dir, 'dupe.md'), CHANGELOG.replace(/a-thing-shipped/g, 'dupe'))
    writeFileSync(join(dir, 'dupe-2.md'), CHANGELOG.replace('slug: a-thing-shipped', 'slug: dupe').replace('a-thing-shipped.md', 'x'))
    await expect(loadChangelogSource(dir)).rejects.toThrow()
  })
})

describe('the repository’s own content', () => {
  it('every committed changelog entry and roadmap item parses', async () => {
    // This is the guard that matters: a typo in content/ must fail CI, not the
    // deploy's post-deployment command.
    const entries = await loadChangelogSource()
    const items = await loadRoadmapSource()
    expect(entries.length).toBeGreaterThan(0)
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(['planned', 'in_progress', 'shipped']).toContain(item.status)
    }
  })
})
