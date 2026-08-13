// table-surface-bounded: this person's own consents and export requests, both bounded by USER_SCOPED_LIMIT.
import * as React from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Download, Trash2, Shield, AlertTriangle, FileJson, CheckCircle2, Clock, X, Users } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { Button } from '~/components/ui/button'
import { DataTable, DateCell, StatusCell, type StatusTone } from '~/shared/components/table'
import { emptyTableSearch } from '~/shared/lib/table/query-url'
import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult } from '~/shared/lib/table/types'

interface ExportRecord extends Record<string, unknown> {
  id: string
  status: 'pending' | 'ready' | 'failed' | 'expired'
  expiresAt: string | null
  createdAt: string
  hasPayload: boolean
}

interface DeletionRecord {
  id: string
  status: 'pending' | 'completed' | 'cancelled'
  gracePeriodEndsAt: string
  completedAt: string | null
  createdAt: string
}

interface BlockingOrganization {
  organizationId: string
  organizationName: string
}

export const Route = createFileRoute('/_dashboard/settings/privacy')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    return { user }
  },
  component: PrivacySettingsPage,
})

/**
 * An expired export is not a failure — the file is simply gone, which is the privacy behaviour
 * working. It reads neutral so that the one tone on this page a person has to act on is `failed`.
 */
const EXPORT_STATUS_TONES: Record<string, StatusTone> = {
  ready: 'success',
  expired: 'neutral',
  failed: 'danger',
  pending: 'warning',
}

function PrivacySettingsPage() {
  const navigate = useNavigate()
  const [exports, setExports] = React.useState<ExportRecord[]>([])
  const [deletion, setDeletion] = React.useState<DeletionRecord | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [success, setSuccess] = React.useState<string | null>(null)
  const [referenceId, setReferenceId] = React.useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [blockingOrganizations, setBlockingOrganizations] = React.useState<BlockingOrganization[]>([])

  const load = React.useCallback(async () => {
    try {
      const [expRes, delRes] = await Promise.all([
        fetch('/api/me/data-export', { credentials: 'include' }),
        fetch('/api/me/delete-account', { credentials: 'include' }),
      ])
      if (expRes.ok) setExports(await expRes.json())
      if (delRes.ok) {
        const d = await delRes.json()
        setDeletion(d.request)
      }
    } catch (e) {
      setError(String(e))
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const requestExport = async () => {
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch('/api/me/data-export', {
        method: 'POST',
        credentials: 'include',
      })
      const data = await res.json()
      if (res.status === 429) {
        setError(`Throttled. Try again later. (${data.error})`)
      } else if (!res.ok) {
        setError(data.error ?? 'Failed')
      } else {
        setSuccess('Export ready. Downloading…')
        // Auto-download
        await load()
        await downloadExport(data.id)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const downloadExport = async (id: string) => {
    try {
      const res = await fetch(`/api/me/data-export/${id}`, { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json()
      if (data.status !== 'ready' || !data.payload) return
      const blob = new Blob([JSON.stringify(data.payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `builderhunt-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(String(e))
    }
  }

  const requestDeletion = async () => {
    setBusy(true)
    setError(null)
    setSuccess(null)
    setReferenceId(null)
    setBlockingOrganizations([])
    try {
      const res = await fetch('/api/me/delete-account', {
        method: 'POST',
        credentials: 'include',
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409 && Array.isArray(data.organizations)) {
        setBlockingOrganizations(data.organizations)
        setError(data.error ?? 'Transfer ownership of your organizations before deleting your account')
        return
      }
      if (!res.ok) throw new Error(data.error ?? 'Failed')
      setSuccess('Account scheduled for deletion. You have 30 days to cancel.')
      setReferenceId(data.id ?? null)
      setConfirmDelete(false)
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const cancelDeletion = async () => {
    setBusy(true)
    setReferenceId(null)
    try {
      const res = await fetch('/api/me/delete-account', {
        method: 'DELETE',
        credentials: 'include',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error('Failed')
      setSuccess('Deletion cancelled. Your account is safe.')
      setReferenceId(data.requestId ?? null)
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const goManageOrganization = async (organizationId: string) => {
    await fetch('/api/organizations/switch', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId }),
    })
    navigate({ to: '/settings/team' })
  }

  const daysRemaining = deletion && deletion.status === 'pending'
    ? Math.max(0, Math.ceil((new Date(deletion.gracePeriodEndsAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : 0

  /**
   * The five most recent exports, as a page that is always the last page.
   *
   * `.slice(0, 5)` was already the bound before this migration and it stays one: a person's export
   * history is model-bounded, so `nextCursor` is null and `total` is what is shown. The shell gets
   * the same list; what changes is that it now has a header, an empty state and keyboard access
   * like every other list in the app.
   */
  const exportPage: PageResult<ExportRecord> = React.useMemo(() => {
    const rows = exports.slice(0, 5)
    return { rows, nextCursor: null, total: rows.length, facets: {} }
  }, [exports])

  const exportColumns = React.useMemo<ColumnDef<ExportRecord>[]>(() => [
    {
      id: 'createdAt',
      header: 'Requested',
      // The primary column, because a data export *is* the request that produced it: three rows
      // reading "ready", "ready", "expired" identify nothing, and the date is the only thing that
      // tells one from another.
      kind: 'primary',
      priority: 'primary',
      value: (record) => record.createdAt,
      cell: (record) => <DateCell value={record.createdAt} withTime />,
    },
    {
      id: 'status',
      header: 'Status',
      kind: 'status',
      value: (record) => record.status,
      cell: (record) => <StatusCell label={record.status} tone={EXPORT_STATUS_TONES[record.status] ?? 'warning'} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      kind: 'actions',
      cell: (record) => record.status !== 'ready' ? null : (
        <Button
          type="button"
          onClick={() => void downloadExport(record.id)}
          variant="ghost"
          size="sm"
          data-testid={`export-download-${record.id}`}
        >
          Download
        </Button>
      ),
    },
  ], [])

  return (
    <div data-testid="privacy-settings-page">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Shield className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          Privacy &amp; data
        </h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Export, manage, or delete your data. GDPR Art. 15–22, CCPA, and friends.
        </p>
      </header>

      {error && (
        <div className="card border-bh-danger/30 bg-bh-danger/5 p-3 mb-4 text-sm text-bh-danger" data-testid="privacy-error">
          <p>{error}</p>
          {blockingOrganizations.length > 0 && (
            <ul className="mt-2 space-y-1" data-testid="blocking-organizations">
              {blockingOrganizations.map((org) => (
                <li key={org.organizationId} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    {org.organizationName}
                  </span>
                  <Button
                    type="button"
                    onClick={() => goManageOrganization(org.organizationId)}
                    variant="ghost"
                    size="sm"
                    className="text-bh-danger shrink-0"
                    data-testid={`manage-org-${org.organizationId}`}
                  >
                    Transfer ownership
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {success && (
        <div className="card border-bh-success/30 bg-bh-success/5 p-3 mb-4 text-sm text-bh-success" data-testid="privacy-success">
          <p>{success}</p>
          {referenceId && (
            <p className="text-xs text-bh-text-dim mt-1" data-testid="privacy-reference-id">Reference: {referenceId}</p>
          )}
        </div>
      )}

      {/* Deletion warning */}
      {deletion && deletion.status === 'pending' && (
        <div className="card border-bh-warning/30 bg-bh-warning/5 p-5 mb-6" data-testid="deletion-warning">
          <div className="flex items-start gap-3">
            <Clock className="w-5 h-5 text-bh-warning shrink-0 mt-0.5" aria-hidden="true" />
            <div className="flex-1">
              <h2 className="font-semibold text-bh-text mb-1">Account scheduled for deletion</h2>
              <p className="text-sm text-bh-text-muted mb-3">
                {daysRemaining} day{daysRemaining === 1 ? '' : 's'} remaining
                (ends {new Date(deletion.gracePeriodEndsAt).toLocaleString()}).
                After this date, all your data will be permanently deleted.
              </p>
              <Button
                type="button"
                onClick={cancelDeletion}
                disabled={busy}
                variant="primary"
                size="sm"
                data-testid="cancel-deletion-btn"
              >
                Cancel deletion
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Data export */}
      <section className="card p-5 mb-6" data-testid="export-section">
        <h2 className="font-semibold flex items-center gap-2 mb-2">
          <Download className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Export my data
        </h2>
        <p className="text-sm text-bh-text-muted mb-4">
          Download all your data as a JSON file: profile, saved searches, saved builders, notes, alerts, consents, and claim history.
          Throttled to once per 24 hours.
        </p>
        <Button
          type="button"
          onClick={requestExport}
          disabled={busy}
          variant="primary"
          size="sm"
          data-testid="request-export-btn"
        >
          <FileJson className="w-4 h-4" aria-hidden="true" />
          {busy ? 'Preparing…' : 'Request export'}
        </Button>

        {exports.length > 0 && (
          <div className="mt-4" data-testid="export-list">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-bh-text-dim">Past exports</h3>
            <DataTable
              label="Past data exports"
              columns={exportColumns}
              page={exportPage}
              query={emptyTableSearch().query}
              // Five rows of one's own export history: nothing to sort, filter or group.
              onQueryChange={() => {}}
              rowTestId={(record) => `export-row-${record.id}`}
              rowId={(record) => record.id}
            />
          </div>
        )}
      </section>

      {/* Delete account */}
      <section className="card border-bh-danger/30 p-5 mb-6" data-testid="delete-section">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="sm:pr-6">
            <h2 className="font-semibold flex items-center gap-2 text-bh-danger">
              <AlertTriangle className="w-4 h-4" aria-hidden="true" />
              Delete account
            </h2>
            <p className="text-sm text-bh-text-muted mt-1 max-w-[60ch]">
              Schedules your account, saved searches, saved builders, notes, alerts, and all personal data for permanent
              deletion. You have <strong className="text-bh-text">30 days</strong> to cancel. After that, the data is
              irrecoverable.
            </p>
          </div>

          {(!deletion || deletion.status !== 'pending') && !confirmDelete && (
            <Button
              type="button"
              onClick={() => setConfirmDelete(true)}
              variant="danger-outline"
              size="sm"
              className="shrink-0"
              data-testid="delete-account-btn"
            >
              <Trash2 className="w-4 h-4" aria-hidden="true" />
              Delete my account
            </Button>
          )}
        </div>

        {(!deletion || deletion.status !== 'pending') && confirmDelete && (
          <div className="mt-4 pt-4 border-t border-bh-danger/20" data-testid="delete-confirm">
            <p className="text-sm text-bh-danger font-semibold mb-3">
              Are you absolutely sure? This will:
            </p>
            <ul className="text-sm text-bh-text-muted space-y-1 list-disc pl-5 mb-4">
              <li>Delete your account permanently after 30 days</li>
              <li>Delete all saved searches, saved builders, and notes</li>
              <li>Cancel any active builder profile claims</li>
              <li>Cancel any pending exports</li>
            </ul>
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={requestDeletion}
                disabled={busy}
                variant="danger"
                size="sm"
                data-testid="confirm-delete-btn"
              >
                {busy ? 'Scheduling…' : 'Yes, schedule deletion'}
              </Button>
              <Button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={busy}
                variant="secondary"
                size="sm"
                data-testid="cancel-confirm-btn"
              >
                <X className="w-3 h-3" aria-hidden="true" />
                Cancel
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="font-semibold flex items-center gap-2 mb-2">
          <CheckCircle2 className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Your rights
        </h2>
        <ul className="text-sm text-bh-text-muted space-y-1 list-disc pl-5">
          <li>Read our <Link to="/legal/privacy" className="text-bh-accent hover:underline">Privacy Policy</Link></li>
          <li>Read our <Link to="/legal/terms" className="text-bh-accent hover:underline">Terms of Service</Link></li>
          <li>Read our <Link to="/legal/cookies" className="text-bh-accent hover:underline">Cookie Policy</Link></li>
          <li>Email <a href="mailto:privacy@builderhunt.dev" className="text-bh-accent underline">privacy@builderhunt.dev</a> for any privacy request</li>
        </ul>
      </section>
    </div>
  )
}
