/**
 * Changelog CRUD, extracted from `_dashboard/admin/changelog.tsx` so the
 * standalone route and the `/admin/content` studio render the same component
 * instead of two copies that drift. Every `data-testid` is preserved verbatim —
 * `tests/regression/test-status-and-trust.mjs` drives this UI by those ids.
 */
// table-surface-bounded: one row per shipped release, read whole; the operator writes them by hand.
import * as React from 'react'
import { BookOpen, ExternalLink, Plus, Save, Trash2, X } from 'lucide-react'
import { Button, Input, Textarea } from '~/components/ui'
import { DataTable, DateCell, EmptyCell, PrimaryCell } from '~/shared/components/table'
import { emptyTableSearch } from '~/shared/lib/table/query-url'
import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult, TableQuery } from '~/shared/lib/table/types'

export interface ChangelogEntry extends Record<string, unknown> {
  id: string
  title: string
  content: string
  slug: string
  tags: string[]
  publishedAt: string
}

const TAG_OPTIONS = ['feature', 'bugfix', 'breaking', 'improvement'] as const

/** Entries whose id carries this prefix are owned by `content/changelog/*.md`. */
const FILE_MANAGED_PREFIX = 'content-changelog-'

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 100)
}

export function ChangelogManager() {
  const [entries, setEntries] = React.useState<ChangelogEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [creatingNew, setCreatingNew] = React.useState(false)
  const [form, setForm] = React.useState({
    title: '',
    slug: '',
    content: '',
    tags: [] as string[],
  })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/admin/changelog', { credentials: 'include' })
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`)
        return
      }
      const data = await res.json()
      setEntries(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const resetForm = () => {
    setForm({ title: '', slug: '', content: '', tags: [] })
    setCreatingNew(false)
    setEditingId(null)
  }

  const startCreate = () => {
    resetForm()
    setCreatingNew(true)
  }

  // Memoised: the column definitions depend on it, and a new identity per render rebuilds
  // every cell of every row.
  const startEdit = React.useCallback((entry: ChangelogEntry) => {
    setForm({
      title: entry.title,
      slug: entry.slug,
      content: entry.content,
      tags: entry.tags,
    })
    setEditingId(entry.id)
  }, [])

  const toggleTag = (t: string) => {
    setForm((f) => ({
      ...f,
      tags: f.tags.includes(t) ? f.tags.filter((x) => x !== t) : [...f.tags, t],
    }))
  }

  const create = async () => {
    if (!form.title.trim() || !form.content.trim()) {
      return setError('Title and content required')
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/changelog', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          content: form.content,
          slug: form.slug || slugify(form.title),
          tags: form.tags,
        }),
      })
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      resetForm()
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const update = async () => {
    if (!editingId) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/changelog/${editingId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          content: form.content,
          tags: form.tags,
        }),
      })
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      resetForm()
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = React.useCallback(async (id: string) => {
    if (!confirm('Delete this changelog entry?')) return
    try {
      await fetch(`/api/admin/changelog/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      await load()
    } catch (e) {
      setError(String(e))
    }
  }, [load])

  const [query, setQuery] = React.useState<TableQuery>(() => emptyTableSearch().query)

  /**
   * Filtering and sorting run over the **complete** entry set, in the browser.
   *
   * That is legitimate here and nowhere else in this phase: `/api/admin/changelog` returns every
   * entry, so "sorted by date" really is sorted by date rather than by the fifty rows that happened
   * to load. Phase 3's rule is that partial data changes what is *correct* — with complete data
   * there is nothing to be wrong about. The day this list outgrows one response it needs a keyset
   * endpoint, and the component above it does not change.
   */
  const page: PageResult<ChangelogEntry> = React.useMemo(() => {
    const term = query.search.trim().toLowerCase()
    const tagFilter = query.filters.tags ?? []

    let rows = entries
    if (term !== '') {
      rows = rows.filter((entry) =>
        entry.title.toLowerCase().includes(term) || entry.slug.toLowerCase().includes(term))
    }
    if (tagFilter.length > 0) rows = rows.filter((entry) => entry.tags.some((tag) => tagFilter.includes(tag)))

    const term0 = query.sort[0]
    if (term0) {
      const direction = term0.dir === 'asc' ? 1 : -1
      rows = [...rows].sort((a, b) => {
        const left = term0.id === 'title' ? a.title : a.publishedAt
        const right = term0.id === 'title' ? b.title : b.publishedAt
        // The tiebreaker is the same idea as the SQL one: without it, two entries published in the
        // same second have no defined order and the list reshuffles on every render.
        return left === right ? a.id.localeCompare(b.id) : (left < right ? -1 : 1) * direction
      })
    } else {
      rows = [...rows].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id))
    }

    // Facet counts come from the set *before* the tag filter, so a chip says what it would add
    // rather than zero — the same rule the server follows in `buildKeysetPage`.
    const beforeTagFilter = term === ''
      ? entries
      : entries.filter((entry) => entry.title.toLowerCase().includes(term) || entry.slug.toLowerCase().includes(term))
    const tagCounts = new Map<string, number>()
    for (const entry of beforeTagFilter) {
      for (const tag of entry.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
    }

    return {
      rows,
      nextCursor: null,
      total: rows.length,
      facets: {
        tags: [...tagCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([value, count]) => ({ value, count })),
      },
    }
  }, [entries, query])

  const columns = React.useMemo<ColumnDef<ChangelogEntry>[]>(() => [
    {
      id: 'title',
      header: 'Entry',
      kind: 'primary',
      sortable: true,
      priority: 'primary',
      value: (entry) => entry.title,
      cell: (entry) => (
        <PrimaryCell
          title={entry.title}
          meta={entry.content.slice(0, 120)}
          leading={entry.id.startsWith(FILE_MANAGED_PREFIX)
            ? (
              // Editing this row here works, and the next `pnpm content:sync` overwrites it from
              // the file. Saying so is cheaper than letting someone discover it after a deploy.
              <span
                className="tbl-chip"
                data-tone="accent"
                title={`Defined by content/changelog/${entry.slug}.md — edits here are overwritten by the next content:sync`}
              >
                in git
              </span>
              )
            : undefined}
        />
      ),
    },
    {
      id: 'slug',
      header: 'Slug',
      kind: 'category',
      priority: 'secondary',
      value: (entry) => entry.slug,
      cell: (entry) => <span className="truncate font-mono text-xs" title={`/${entry.slug}`}>/{entry.slug}</span>,
    },
    {
      id: 'tags',
      header: 'Tags',
      kind: 'category',
      priority: 'detail',
      value: (entry) => entry.tags.join(', '),
      cell: (entry) => entry.tags.length > 0
        ? <span className="truncate" title={entry.tags.join(', ')}>{entry.tags.join(', ')}</span>
        : <EmptyCell label="No tags" />,
    },
    {
      id: 'publishedAt',
      header: 'Published',
      kind: 'date',
      sortable: true,
      priority: 'secondary',
      value: (entry) => entry.publishedAt,
      cell: (entry) => <DateCell value={entry.publishedAt} withTime />,
    },
    {
      id: 'actions',
      header: 'Actions',
      kind: 'actions',
      cell: (entry) => (
        <span className="flex items-center gap-2">
          <a
            href={`/changelog/${entry.slug}`}
            target="_blank"
            rel="noreferrer"
            className="btn-icon"
            aria-label={`View ${entry.title} on the public changelog`}
            data-testid="admin-changelog-view"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
          <Button type="button" onClick={() => startEdit(entry)} variant="secondary" size="sm" data-testid="admin-changelog-edit">
            Edit
          </Button>
          <Button type="button" onClick={() => void remove(entry.id)} variant="secondary" size="sm" data-testid="admin-changelog-delete">
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </span>
      ),
    },
  ], [startEdit, remove])

  return (
    <div data-testid="admin-changelog-page">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-bh-accent" aria-hidden="true" />
            Changelog
            <span className="text-sm font-normal text-bh-text-dim">({entries.length})</span>
          </h1>
          <p className="text-sm text-bh-text-muted mt-1">
            Publish product updates. Public at{' '}
            <a href="/changelog" className="text-bh-accent hover:underline" target="_blank" rel="noreferrer">
              /changelog
            </a>
            . Content is markdown.
          </p>
        </div>
        <Button
          type="button"
          onClick={startCreate}
          data-testid="admin-changelog-new"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          New entry
        </Button>
      </header>

      {error && (
        <div className="card border-bh-danger/30 bg-bh-danger/5 p-3 mb-4 text-sm text-bh-danger">
          {error}
        </div>
      )}

      {(creatingNew || editingId) && (
        <div className="card p-5 mb-6 space-y-3" data-testid="admin-changelog-form">
          <h2 className="font-semibold">
            {creatingNew ? 'New changelog entry' : 'Edit entry'}
          </h2>
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1">
              Title
            </label>
            <Input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full"
              placeholder="e.g. Smart alerts for new builder activity"
              data-testid="admin-changelog-title"
            />
          </div>
          {creatingNew && (
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1">
                Slug (auto from title if blank)
              </label>
              <Input
                type="text"
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                className="w-full"
                placeholder="smart-alerts"
                data-testid="admin-changelog-slug"
              />
            </div>
          )}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1">
              Content (markdown)
            </label>
            <Textarea
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              className="w-full min-h-[200px] font-mono text-sm"
              placeholder="Describe what shipped and why it matters…"
              data-testid="admin-changelog-content"
            />
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1">
              Tags
            </label>
            <div className="flex flex-wrap gap-2">
              {TAG_OPTIONS.map((t) => (
                <Button
                  key={t}
                  type="button"
                  onClick={() => toggleTag(t)}
                  variant={form.tags.includes(t) ? 'primary' : 'secondary'}
                  size="sm"
                  data-testid={`admin-changelog-tag-${t}`}
                >
                  {t}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              onClick={creatingNew ? create : update}
              disabled={saving}
              data-testid="admin-changelog-save"
            >
              <Save className="w-4 h-4" aria-hidden="true" />
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              onClick={resetForm}
              variant="secondary"
              data-testid="admin-changelog-cancel"
            >
              <X className="w-4 h-4" aria-hidden="true" />
              Cancel
            </Button>
          </div>
        </div>
      )}

      <DataTable
        label="Changelog entries"
        columns={columns}
        page={page}
        query={query}
        onQueryChange={setQuery}
        rowTestId={(entry) => `admin-changelog-row-${entry.id}`}
        rowId={(entry) => entry.id}
        status={loading ? 'loading' : 'ready'}
        filterLabels={{ tags: 'Tag' }}
        emptyState={(
          <div className="px-4 py-12 text-center text-sm text-bh-text-muted" data-testid="admin-changelog-empty">
            No changelog entries yet.
          </div>
        )}
      />
    </div>
  )
}
