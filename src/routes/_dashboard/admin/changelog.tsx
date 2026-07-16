import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { BookOpen, Plus, Save, X, Trash2 } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'

interface ChangelogEntry {
  id: string
  title: string
  content: string
  slug: string
  tags: string[]
  publishedAt: string
}

const TAG_OPTIONS = ['feature', 'bugfix', 'breaking', 'improvement'] as const
const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)

export const Route = createFileRoute('/_dashboard/admin/changelog')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (ADMIN_IDS.length === 0 || !ADMIN_IDS.includes(user.userId)) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: AdminChangelogPage,
})

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 100)
}

function AdminChangelogPage() {
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

  const startEdit = (entry: ChangelogEntry) => {
    setForm({
      title: entry.title,
      slug: entry.slug,
      content: entry.content,
      tags: entry.tags,
    })
    setEditingId(entry.id)
  }

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

  const remove = async (id: string) => {
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
  }

  return (
    <div className="p-6 max-w-5xl mx-auto" data-testid="admin-changelog-page">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-bh-accent" aria-hidden="true" />
            Changelog
          </h1>
          <p className="text-sm text-bh-text-muted mt-1">
            Publish product updates. Public at /changelog.
          </p>
        </div>
        <button
          type="button"
          onClick={startCreate}
          className="btn-primary"
          data-testid="admin-changelog-new"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          New entry
        </button>
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
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="input w-full"
              placeholder="e.g. Smart alerts for new builder activity"
              data-testid="admin-changelog-title"
            />
          </div>
          {creatingNew && (
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1">
                Slug (auto from title if blank)
              </label>
              <input
                type="text"
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                className="input w-full"
                placeholder="smart-alerts"
                data-testid="admin-changelog-slug"
              />
            </div>
          )}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1">
              Content (markdown)
            </label>
            <textarea
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              className="input w-full min-h-[200px] font-mono text-sm"
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
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleTag(t)}
                  className={`btn-sm ${
                    form.tags.includes(t) ? 'btn-primary' : 'btn-secondary'
                  }`}
                  data-testid={`admin-changelog-tag-${t}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={creatingNew ? create : update}
              disabled={saving}
              className="btn-primary"
              data-testid="admin-changelog-save"
            >
              <Save className="w-4 h-4" aria-hidden="true" />
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="btn-secondary"
              data-testid="admin-changelog-cancel"
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
        ) : entries.length === 0 ? (
          <p className="text-sm text-bh-text-muted">No changelog entries yet.</p>
        ) : (
          entries.map((e) => (
            <div
              key={e.id}
              className="card p-4 flex items-start gap-3"
              data-testid={`admin-changelog-row-${e.id}`}
            >
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm">{e.title}</p>
                <p className="text-xs text-bh-text-dim mt-1">
                  {new Date(e.publishedAt).toLocaleString()} · /{e.slug}
                  {e.tags.length > 0 && ` · ${e.tags.join(', ')}`}
                </p>
                <p className="text-xs text-bh-text-muted mt-1 line-clamp-2">
                  {e.content.slice(0, 200)}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => startEdit(e)}
                  className="btn-sm btn-secondary"
                  data-testid="admin-changelog-edit"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => remove(e.id)}
                  className="btn-sm btn-secondary"
                  data-testid="admin-changelog-delete"
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
