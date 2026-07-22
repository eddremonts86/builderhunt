import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Map, Plus, Save, X, Trash2, ArrowUp, ArrowDown } from 'lucide-react'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'
import { Input, Textarea, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui'

type RoadmapStatus = 'planned' | 'in_progress' | 'shipped'

interface RoadmapItem {
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
export const Route = createFileRoute('/_dashboard/admin/roadmap')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!(await getIsAppAdmin())) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: AdminRoadmapPage,
})

function AdminRoadmapPage() {
  const [items, setItems] = React.useState<RoadmapItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [creatingNew, setCreatingNew] = React.useState(false)
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

  const startEdit = (item: RoadmapItem) => {
    setForm({
      title: item.title,
      description: item.description ?? '',
      status: item.status,
      shipEstimate: item.shipEstimate ?? '',
      category: item.category ?? 'general',
      sortOrder: item.sortOrder,
    })
    setEditingId(item.id)
  }

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

  const remove = async (id: string) => {
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
  }

  const moveSort = async (id: string, current: number, delta: number) => {
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
  }

  return (
    <div data-testid="admin-roadmap-page">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Map className="w-6 h-6 text-bh-accent" aria-hidden="true" />
            Roadmap
          </h1>
          <p className="text-sm text-bh-text-muted mt-1">
            What we're building next. Public at /roadmap.
          </p>
        </div>
        <button
          type="button"
          onClick={startCreate}
          className="btn-primary"
          data-testid="admin-roadmap-new"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          New item
        </button>
      </header>

      {error && (
        <div className="glass-panel border-bh-danger/30 bg-bh-danger/5 p-3 mb-4 text-sm text-bh-danger">
          {error}
        </div>
      )}

      {(creatingNew || editingId) && (
        <div className="glass-panel p-5 mb-6 space-y-3" data-testid="admin-roadmap-form">
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
            <button
              type="button"
              onClick={creatingNew ? create : update}
              disabled={saving}
              className="btn-primary"
              data-testid="admin-roadmap-save"
            >
              <Save className="w-4 h-4" aria-hidden="true" />
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="btn-secondary"
              data-testid="admin-roadmap-cancel"
            >
              <X className="w-4 h-4" aria-hidden="true" />
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {loading ? (
          <p className="text-sm text-bh-text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-bh-text-muted">No roadmap items yet.</p>
        ) : (
          items.map((i) => (
            <div
              key={i.id}
              className="glass-panel p-4 flex items-start gap-3"
              data-testid={`admin-roadmap-row-${i.id}`}
            >
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => moveSort(i.id, i.sortOrder, -1)}
                  className="btn-icon"
                  aria-label="Move up"
                  data-testid="admin-roadmap-move-up"
                >
                  <ArrowUp className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => moveSort(i.id, i.sortOrder, 1)}
                  className="btn-icon"
                  aria-label="Move down"
                  data-testid="admin-roadmap-move-down"
                >
                  <ArrowDown className="w-3 h-3" />
                </button>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className={`text-[10px] uppercase tracking-wider font-bold ${
                    i.status === 'shipped' ? 'text-bh-success' :
                    i.status === 'in_progress' ? 'text-bh-warning' : 'text-bh-text-dim'
                  }`}>
                    {i.status}
                  </span>
                  {i.shipEstimate && (
                    <span className="text-[10px] text-bh-text-dim">· {i.shipEstimate}</span>
                  )}
                  {i.category && (
                    <span className="text-[10px] text-bh-text-dim">· {i.category}</span>
                  )}
                </div>
                <p className="font-semibold text-sm">{i.title}</p>
                {i.description && (
                  <p className="text-xs text-bh-text-muted mt-1 line-clamp-2">
                    {i.description}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => startEdit(i)}
                  className="btn-sm btn-secondary"
                  data-testid="admin-roadmap-edit"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => remove(i.id)}
                  className="btn-sm btn-secondary"
                  data-testid="admin-roadmap-delete"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
