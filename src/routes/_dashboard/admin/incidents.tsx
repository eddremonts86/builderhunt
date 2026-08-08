// table-surface-bounded: the incident log, read whole and bounded by OPERATOR_LIST_LIMIT.
import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { AlertTriangle, Plus, Save, X } from 'lucide-react'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { Button, Input, Textarea, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui'
import { DataTable } from '~/shared/components/table'
import { emptyTableSearch } from '~/shared/lib/table/query-url'
import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult, TableQuery } from '~/shared/lib/table/types'

type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'
type IncidentSeverity = 'minor' | 'major' | 'critical'

interface Incident extends Record<string, unknown> {
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
    await requirePlatformAdminPage()
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

  // Memoised because the column definitions depend on it: a new function identity every render
  // would rebuild every cell of every row on every keystroke elsewhere on the page.
  const updateStatus = React.useCallback(async (id: string, status: IncidentStatus) => {
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
  }, [load])

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

  const [query, setQuery] = React.useState<TableQuery>(() => emptyTableSearch().query)

  /**
   * A page that is always the whole list.
   *
   * `/api/admin/incidents` returns every incident, and there are a handful — this is a status page
   * for outages, not a feed. `nextCursor: null` says so, and if incidents ever became numerous the
   * change is a keyset endpoint behind the same component, not a rewrite of this page.
   */
  const page: PageResult<Incident> = React.useMemo(() => ({
    rows: incidents,
    nextCursor: null,
    total: incidents.length,
    facets: {},
  }), [incidents])

  const columns = React.useMemo<ColumnDef<Incident>[]>(() => [
    {
      id: 'title',
      header: 'Incident',
      priority: 'primary',
      value: (incident) => incident.title,
      cell: (incident) => (
        <span className="min-w-0">
          <span className="block truncate font-medium">{incident.title}</span>
          {incident.description && (
            <span className="block truncate text-xs text-bh-text-muted">{incident.description}</span>
          )}
        </span>
      ),
    },
    {
      id: 'severity',
      header: 'Severity',
      value: (incident) => incident.severity,
      cell: (incident) => (
        <span className={`text-[10px] font-bold uppercase tracking-wider ${
          incident.severity === 'critical' ? 'text-bh-danger'
            : incident.severity === 'major' ? 'text-bh-warning' : 'text-bh-text-dim'
        }`}>
          {incident.severity}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      groupable: true,
      value: (incident) => incident.status,
      cell: (incident) => incident.status,
    },
    {
      id: 'components',
      header: 'Components',
      priority: 'detail',
      value: (incident) => incident.affectedComponents.join(', '),
      cell: (incident) => incident.affectedComponents?.length > 0 ? incident.affectedComponents.join(', ') : '—',
    },
    {
      id: 'startedAt',
      header: 'Started',
      align: 'end',
      priority: 'secondary',
      value: (incident) => incident.startedAt,
      cell: (incident) => new Date(incident.startedAt).toLocaleString(),
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (incident) => incident.status === 'resolved' ? null : (
        <span className="flex items-center gap-2">
          {incident.status === 'investigating' && (
            <Button
              type="button"
              onClick={() => void updateStatus(incident.id, 'identified')}
              disabled={saving}
              variant="secondary"
              size="sm"
              data-testid="admin-incident-mark-identified"
            >
              Mark identified
            </Button>
          )}
          {(incident.status === 'identified' || incident.status === 'monitoring') && (
            <Button
              type="button"
              onClick={() => void updateStatus(incident.id, 'monitoring')}
              disabled={saving}
              variant="secondary"
              size="sm"
            >
              Monitoring
            </Button>
          )}
          <Button
            type="button"
            onClick={() => void updateStatus(incident.id, 'resolved')}
            disabled={saving}
            size="sm"
            data-testid="admin-incident-resolve"
          >
            Resolve
          </Button>
        </span>
      ),
    },
  ], [saving, updateStatus])

  /**
   * One form, two places.
   *
   * Create renders it above the grid; edit renders it in the row's expansion slot. Duplicating
   * ninety lines of inputs so each could have its own copy is how two forms drift into disagreeing
   * about which fields exist.
   */
  const renderForm = () => (
          <div className="card p-5 mb-6 space-y-3" data-testid="admin-incident-form">
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
                      <Button
                        key={c}
                        type="button"
                        onClick={() => toggleComponent(c)}
                        variant={form.affectedComponents.includes(c) ? 'primary' : 'secondary'}
                        size="sm"
                        data-testid={`admin-incident-component-${c}`}
                      >
                        {c}
                      </Button>
                    ))}
                  </div>
                </div>
              </>
            )}
            <div className="flex gap-2 pt-2">
              <Button
                type="button"
                onClick={creatingNew ? create : update}
                disabled={saving}
                data-testid="admin-incident-save"
              >
                <Save className="w-4 h-4" aria-hidden="true" />
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button
                type="button"
                onClick={resetForm}
                variant="secondary"
                data-testid="admin-incident-cancel"
              >
                <X className="w-4 h-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
          </div>
  )

  return (
    <div data-testid="admin-incidents-page">
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
        <Button
          type="button"
          onClick={startCreate}
          data-testid="admin-incident-new"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          New incident
        </Button>
      </header>

      {error && (
        <div className="card border-bh-danger/30 bg-bh-danger/5 p-3 mb-4 text-sm text-bh-danger">
          {error}
        </div>
      )}

      {creatingNew && renderForm()}

      <DataTable
        label="Incidents"
        columns={columns}
        page={page}
        query={query}
        onQueryChange={setQuery}
        rowTestId={(incident) => `admin-incident-row-${incident.id}`}
        // Explicit, because `expandedRowId` is compared against `rowId` — and `rowId` defaults to
        // `rowTestId`, which is prefixed. Without this the page would set `editingId` to a raw id
        // and the shell would look for a prefixed one, so no row would ever open.
        rowId={(incident) => incident.id}
        status={loading ? 'loading' : 'ready'}
        // Expanding a row *is* editing that incident, so the page owns which one is open rather
        // than mirroring a flag the shell keeps. `startEdit` loads the incident into the form on
        // open and `resetForm` clears it on close — one answer to "which row is being edited".
        expansion={() => renderForm()}
        expandedRowId={editingId}
        onExpandedChange={(rowId) => {
          const incident = rowId ? incidents.find((candidate) => candidate.id === rowId) : null
          if (incident) startEdit(incident)
          else resetForm()
        }}
        emptyState={(
          <div className="px-4 py-12 text-center text-sm text-bh-text-muted" data-testid="admin-incidents-empty">
            No incidents yet. Create one when something breaks.
          </div>
        )}
      />
    </div>
  )
}
