import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { AlertTriangle, Plus, Save, X } from 'lucide-react'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'
import { Input, Textarea, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui'

type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'
type IncidentSeverity = 'minor' | 'major' | 'critical'

interface Incident {
  id: string
  title: string
  description: string | null
  status: IncidentStatus
  severity: IncidentSeverity
  affectedComponents: string[]
  startedAt: string
  resolvedAt: string | null
  identifiedAt: string | null
}

const COMPONENTS = ['app', 'api', 'search', 'database', 'redis', 'email', 'auth', 'sources'] as const

export const Route = createFileRoute('/_dashboard/admin/incidents')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!(await getIsAppAdmin())) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: AdminIncidentsPage,
})

function AdminIncidentsPage() {
  const [incidents, setIncidents] = React.useState<Incident[]>([])
  const [loading, setLoading] = React.useState(true)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [creatingNew, setCreatingNew] = React.useState(false)
  const [form, setForm] = React.useState<{
    title: string
    description: string
    severity: IncidentSeverity
    affectedComponents: string[]
  }>({ title: '', description: '', severity: 'minor', affectedComponents: [] })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/admin/incidents', { credentials: 'include' })
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`)
        return
      }
      const data = await res.json()
      setIncidents(Array.isArray(data) ? data : [])
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
    setForm({ title: '', description: '', severity: 'minor', affectedComponents: [] })
    setCreatingNew(false)
    setEditingId(null)
  }

  const startCreate = () => {
    resetForm()
    setCreatingNew(true)
  }

  const startEdit = (i: Incident) => {
    setForm({
      title: i.title,
      description: i.description ?? '',
      severity: i.severity,
      affectedComponents: i.affectedComponents ?? [],
    })
    setEditingId(i.id)
  }

  const toggleComponent = (c: string) => {
    setForm((f) => ({
      ...f,
      affectedComponents: f.affectedComponents.includes(c)
        ? f.affectedComponents.filter((x) => x !== c)
        : [...f.affectedComponents, c],
    }))
  }

  const create = async () => {
    if (!form.title.trim()) return setError('Title required')
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/incidents', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
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

  const updateStatus = async (id: string, status: IncidentStatus) => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/incidents/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
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
      const res = await fetch(`/api/admin/incidents/${editingId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          description: form.description,
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

  return (
    <div className="p-6 max-w-5xl mx-auto" data-testid="admin-incidents-page">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <AlertTriangle className="w-6 h-6 text-bh-warning" aria-hidden="true" />
            Incidents
          </h1>
          <p className="text-sm text-bh-text-muted mt-1">
            Manage active and historical incidents. Status page auto-updates.
          </p>
        </div>
        <button
          type="button"
          onClick={startCreate}
          className="btn-primary"
          data-testid="admin-incident-new"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          New incident
        </button>
      </header>

      {error && (
        <div className="glass-panel border-bh-danger/30 bg-bh-danger/5 p-3 mb-4 text-sm text-bh-danger">
          {error}
        </div>
      )}

      {(creatingNew || editingId) && (
        <div className="glass-panel p-5 mb-6 space-y-3" data-testid="admin-incident-form">
          <h2 className="font-semibold">
            {creatingNew ? 'New incident' : 'Edit incident'}
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
              placeholder="e.g. Search API slow responses"
              data-testid="admin-incident-title"
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
              placeholder="What's broken, what users see, what we're doing about it."
              data-testid="admin-incident-description"
            />
          </div>
          {creatingNew && (
            <>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1">
                  Severity
                </label>
                <Select
                  value={form.severity}
                  onValueChange={(v) => setForm({ ...form, severity: v as IncidentSeverity })}
                >
                  <SelectTrigger className="w-full" data-testid="admin-incident-severity">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="minor">Minor</SelectItem>
                    <SelectItem value="major">Major</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1">
                  Affected components
                </label>
                <div className="flex flex-wrap gap-2">
                  {COMPONENTS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => toggleComponent(c)}
                      className={`btn-sm ${
                        form.affectedComponents.includes(c) ? 'btn-primary' : 'btn-secondary'
                      }`}
                      data-testid={`admin-incident-component-${c}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={creatingNew ? create : update}
              disabled={saving}
              className="btn-primary"
              data-testid="admin-incident-save"
            >
              <Save className="w-4 h-4" aria-hidden="true" />
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="btn-secondary"
              data-testid="admin-incident-cancel"
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
        ) : incidents.length === 0 ? (
          <p className="text-sm text-bh-text-muted">No incidents yet. Create one when something breaks.</p>
        ) : (
          incidents.map((i) => (
            <div
              key={i.id}
              className="glass-panel p-4 flex items-start gap-3"
              data-testid={`admin-incident-row-${i.id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className={`text-[10px] uppercase tracking-wider font-bold ${
                    i.severity === 'critical' ? 'text-bh-danger' :
                    i.severity === 'major' ? 'text-bh-warning' : 'text-bh-text-dim'
                  }`}>
                    {i.severity}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider opacity-70">
                    {i.status}
                  </span>
                  {i.affectedComponents?.length > 0 && (
                    <span className="text-[10px] text-bh-text-dim">
                      · {i.affectedComponents.join(', ')}
                    </span>
                  )}
                </div>
                <p className="font-semibold text-sm">{i.title}</p>
                {i.description && (
                  <p className="text-xs text-bh-text-muted mt-1 line-clamp-2">
                    {i.description}
                  </p>
                )}
                <p className="text-xs text-bh-text-dim mt-1">
                  Started {new Date(i.startedAt).toLocaleString()}
                  {i.resolvedAt && ` · Resolved ${new Date(i.resolvedAt).toLocaleString()}`}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {i.status !== 'resolved' && (
                  <>
                    {i.status === 'investigating' && (
                      <button
                        type="button"
                        onClick={() => updateStatus(i.id, 'identified')}
                        disabled={saving}
                        className="btn-sm btn-secondary"
                        data-testid="admin-incident-mark-identified"
                      >
                        Mark identified
                      </button>
                    )}
                    {(i.status === 'identified' || i.status === 'monitoring') && (
                      <button
                        type="button"
                        onClick={() => updateStatus(i.id, 'monitoring')}
                        disabled={saving}
                        className="btn-sm btn-secondary"
                      >
                        Monitoring
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => updateStatus(i.id, 'resolved')}
                      disabled={saving}
                      className="btn-sm btn-primary"
                      data-testid="admin-incident-resolve"
                    >
                      Resolve
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => startEdit(i)}
                  className="btn-sm btn-secondary"
                  data-testid="admin-incident-edit"
                >
                  Edit
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
