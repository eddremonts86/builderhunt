/**
 * Roadmap CRUD, extracted from `_dashboard/admin/roadmap.tsx` so the standalone
 * route and `/admin/content` share one implementation. All `data-testid`
 * attributes are unchanged — regression tests drive this UI by those ids.
 *
 * Added over the original: a status filter (the board is 30+ items now, and an
 * undifferentiated list of 30 is not reviewable) and a marker on rows that are
 * defined by a file in `content/roadmap/`.
 */
import * as React from 'react'
// `Map` is aliased: the lucide icon shadows the global `Map` constructor, and
// `new Map<string, number>()` below silently resolved to the React component.
import { ArrowDown, ArrowUp, Map as MapIcon, Plus, Save, Trash2, X } from 'lucide-react'
import { Input, Textarea, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui'
import { Button } from '~/components/ui/button'
import { DataTable } from '~/shared/components/table'
import { emptyTableSearch } from '~/shared/lib/table/query-url'
import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult, TableQuery } from '~/shared/lib/table/types'

type RoadmapStatus = 'planned' | 'in_progress' | 'shipped'

export interface RoadmapItem extends Record<string, unknown> {
  id: string
  title: string
  description: string | null
  status: RoadmapStatus
  shipEstimate: string | null
  category: string | null
  sortOrder: number
}

const STATUS_OPTIONS: Array<{ value: RoadmapStatus; label: string }> = [
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'shipped', label: 'Shipped' },
]
const CATEGORIES = ['integrations', 'features', 'infrastructure', 'general'] as const

/** Items whose id carries this prefix are owned by `content/roadmap/*.md`. */
const FILE_MANAGED_PREFIX = 'content-roadmap-'

export function RoadmapManager() {
  const [items, setItems] = React.useState<RoadmapItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [creatingNew, setCreatingNew] = React.useState(false)
  const [statusFilter, setStatusFilter] = React.useState<RoadmapStatus | 'all'>('all')
  const [form, setForm] = React.useState({
    title: '',
    description: '',
    status: 'planned' as RoadmapStatus,
    shipEstimate: '',
    category: 'general',
    sortOrder: 0,
  })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/admin/roadmap', { credentials: 'include' })
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`)
        return
      }
      const data = await res.json()
      setItems(Array.isArray(data) ? data : [])
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
    setForm({ title: '', description: '', status: 'planned', shipEstimate: '', category: 'general', sortOrder: 0 })
    setCreatingNew(false)
    setEditingId(null)
  }

  const startCreate = () => {
    resetForm()
    setCreatingNew(true)
  }

  const startEdit = React.useCallback((item: RoadmapItem) => {
    setForm({
      title: item.title,
      description: item.description ?? '',
      status: item.status,
      shipEstimate: item.shipEstimate ?? '',
      category: item.category ?? 'general',
      sortOrder: item.sortOrder,
    })
    setEditingId(item.id)
  }, [])

  const create = async () => {
    if (!form.title.trim()) return setError('Title required')
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/roadmap', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          description: form.description || undefined,
          status: form.status,
          shipEstimate: form.shipEstimate || undefined,
          category: form.category,
          sortOrder: form.sortOrder,
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
      const res = await fetch(`/api/admin/roadmap/${editingId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          description: form.description || null,
          status: form.status,
          shipEstimate: form.shipEstimate || null,
          category: form.category,
          sortOrder: form.sortOrder,
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
    if (!confirm('Delete this roadmap item?')) return
    try {
      await fetch(`/api/admin/roadmap/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      await load()
    } catch (e) {
      setError(String(e))
    }
  }, [load])

  const moveSort = React.useCallback(async (id: string, current: number, delta: number) => {
    const target = current + delta
    try {
      await fetch(`/api/admin/roadmap/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sortOrder: target }),
      })
      await load()
    } catch (e) {
      setError(String(e))
    }
  }, [load])

  const counts = STATUS_OPTIONS.map((s) => ({ ...s, count: items.filter((i) => i.status === s.value).length }))
  const visible = statusFilter === 'all' ? items : items.filter((i) => i.status === statusFilter)

  const [query, setQuery] = React.useState<TableQuery>(() => emptyTableSearch().query)

  /**
   * The complete item set, filtered and sorted in the browser.
   *
   * `/api/admin/roadmap` returns every item, so this is sorting complete data rather than the fifty
   * rows that happened to load — the distinction phase 3 is about. Default order is `sortOrder`,
   * which is the whole point of a roadmap and what the move-up/move-down buttons edit.
   */
  const page: PageResult<RoadmapItem> = React.useMemo(() => {
    const term = query.search.trim().toLowerCase()
    const statusFilterValues = query.filters.status ?? []

    const searched = term === ''
      ? items
      : items.filter((item) =>
        item.title.toLowerCase().includes(term) || (item.description ?? '').toLowerCase().includes(term))
    let rows = statusFilterValues.length > 0
      ? searched.filter((item) => statusFilterValues.includes(item.status))
      : searched

    const sortTerm = query.sort[0]
    rows = [...rows].sort((a, b) => {
      if (!sortTerm) return a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)
      const direction = sortTerm.dir === 'asc' ? 1 : -1
      const left = sortTerm.id === 'title' ? a.title : sortTerm.id === 'status' ? a.status : String(a.sortOrder).padStart(8, '0')
      const right = sortTerm.id === 'title' ? b.title : sortTerm.id === 'status' ? b.status : String(b.sortOrder).padStart(8, '0')
      // Same tiebreaker rule as the SQL builder: without it two items sharing a status have no
      // defined order and the list reshuffles on every render.
      return left === right ? a.id.localeCompare(b.id) : (left < right ? -1 : 1) * direction
    })

    // Counted before the status filter, so a chip says what it would add rather than zero.
    const statusCounts = new Map<string, number>()
    for (const item of searched) statusCounts.set(item.status, (statusCounts.get(item.status) ?? 0) + 1)

    return {
      rows,
      nextCursor: null,
      total: rows.length,
      facets: {
        status: STATUS_OPTIONS
          .filter((option) => statusCounts.has(option.value))
          .map((option) => ({ value: option.value, count: statusCounts.get(option.value) ?? 0 })),
      },
    }
  }, [items, query])

  const columns = React.useMemo<ColumnDef<RoadmapItem>[]>(() => [
    {
      id: 'order',
      header: 'Order',
      // The move buttons edit `sortOrder`, so they live in the column that shows it.
      cell: (item) => (
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void moveSort(item.id, item.sortOrder, -1)}
            className="btn-icon"
            aria-label={`Move ${item.title} up`}
            data-testid="admin-roadmap-move-up"
          >
            <ArrowUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => void moveSort(item.id, item.sortOrder, 1)}
            className="btn-icon"
            aria-label={`Move ${item.title} down`}
            data-testid="admin-roadmap-move-down"
          >
            <ArrowDown className="h-3 w-3" />
          </button>
          <span className="tabular-nums text-xs text-bh-text-dim">{item.sortOrder}</span>
        </span>
      ),
      sortable: true,
      value: (item) => item.sortOrder,
    },
    {
      id: 'title',
      header: 'Item',
      sortable: true,
      priority: 'primary',
      value: (item) => item.title,
      cell: (item) => (
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{item.title}</span>
            {item.id.startsWith(FILE_MANAGED_PREFIX) && (
              <span
                className="rounded border border-bh-cyan/30 bg-bh-cyan/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-bh-cyan-text"
                title={`Defined by content/roadmap/${item.id.slice(FILE_MANAGED_PREFIX.length)}.md — edits here are overwritten by the next content:sync`}
              >
                in git
              </span>
            )}
          </span>
          {item.description && (
            <span className="block truncate text-xs text-bh-text-muted">{item.description}</span>
          )}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      groupable: true,
      value: (item) => item.status,
      cell: (item) => (
        <span className={`text-[10px] font-bold uppercase tracking-wider ${
          item.status === 'shipped' ? 'text-bh-success'
            : item.status === 'in_progress' ? 'text-bh-warning' : 'text-bh-text-dim'
        }`}>
          {item.status}
        </span>
      ),
    },
    {
      id: 'category',
      header: 'Category',
      priority: 'detail',
      value: (item) => item.category,
      cell: (item) => item.category ?? '—',
    },
    {
      id: 'shipEstimate',
      header: 'Estimate',
      priority: 'secondary',
      value: (item) => item.shipEstimate,
      cell: (item) => item.shipEstimate ?? '—',
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (item) => (
        <span className="flex items-center gap-2">
          <Button type="button" onClick={() => startEdit(item)} variant="secondary" size="sm" data-testid="admin-roadmap-edit">
            Edit
          </Button>
          <Button type="button" onClick={() => void remove(item.id)} variant="secondary" size="sm" data-testid="admin-roadmap-delete">
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </span>
      ),
    },
  ], [moveSort, startEdit, remove])

  return (
    <div data-testid="admin-roadmap-page">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <MapIcon className="w-6 h-6 text-bh-accent" aria-hidden="true" />
            Roadmap
            <span className="text-sm font-normal text-bh-text-dim">({items.length})</span>
          </h1>
          <p className="text-sm text-bh-text-muted mt-1">
            What we&apos;re building next. Public at{' '}
            <a href="/roadmap" className="text-bh-accent hover:underline" target="_blank" rel="noreferrer">
              /roadmap
            </a>
            , where signed-in users can vote.
          </p>
        </div>
        <Button
          type="button"
          onClick={startCreate}
          variant="primary"
          data-testid="admin-roadmap-new"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          New item
        </Button>
      </header>

      {/*
        The status filter is the shell's facet chips now, in the toolbar. This element stays so the
        id `admin-roadmap-filters` keeps meaning "the filter controls" for anything driving the page
        by it, and it points at where they went rather than pretending they are still here.
      */}
      <div className="sr-only" data-testid="admin-roadmap-filters">
        Status filters are in the table toolbar below.
      </div>

      {error && (
        <div className="card border-bh-danger/30 bg-bh-danger/5 p-3 mb-4 text-sm text-bh-danger">
          {error}
        </div>
      )}

      {(creatingNew || editingId) && (
        <div className="card p-5 mb-6 space-y-3" data-testid="admin-roadmap-form">
          <h2 className="font-semibold">
            {creatingNew ? 'New roadmap item' : 'Edit item'}
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
              placeholder="e.g. Code fingerprinting"
              data-testid="admin-roadmap-title"
            />
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1">
              Description
            </label>
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full min-h-[80px]"
              placeholder="What it is and why it matters."
              data-testid="admin-roadmap-description"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1">
                Status
              </label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm({ ...form, status: v as RoadmapStatus })}
              >
                <SelectTrigger className="w-full" data-testid="admin-roadmap-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1">
                Ship estimate
              </label>
              <Input
                type="text"
                value={form.shipEstimate}
                onChange={(e) => setForm({ ...form, shipEstimate: e.target.value })}
                className="w-full"
                placeholder="Q3 2026"
                data-testid="admin-roadmap-estimate"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1">
                Category
              </label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm({ ...form, category: v })}
              >
                <SelectTrigger className="w-full" data-testid="admin-roadmap-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1">
                Sort order
              </label>
              <Input
                type="number"
                value={form.sortOrder}
                onChange={(e) => setForm({ ...form, sortOrder: parseInt(e.target.value, 10) || 0 })}
                className="w-full"
                data-testid="admin-roadmap-sort"
              />
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              onClick={creatingNew ? create : update}
              disabled={saving}
              variant="primary"
              data-testid="admin-roadmap-save"
            >
              <Save className="w-4 h-4" aria-hidden="true" />
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              onClick={resetForm}
              variant="secondary"
              data-testid="admin-roadmap-cancel"
            >
              <X className="w-4 h-4" aria-hidden="true" />
              Cancel
            </Button>
          </div>
        </div>
      )}

      <DataTable
        label="Roadmap items"
        columns={columns}
        page={page}
        query={query}
        onQueryChange={setQuery}
        rowTestId={(item) => `admin-roadmap-row-${item.id}`}
        rowId={(item) => item.id}
        status={loading ? 'loading' : 'ready'}
        filterLabels={{ status: 'Status' }}
        emptyState={(
          <div className="px-4 py-12 text-center text-sm text-bh-text-muted" data-testid="admin-roadmap-empty">
            No roadmap items yet.
          </div>
        )}
      />
    </div>
  )
}
