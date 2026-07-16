import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Download, Trash2, Shield, AlertTriangle, FileJson, CheckCircle2, Clock, X } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'

interface ExportRecord {
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

export const Route = createFileRoute('/_dashboard/settings/privacy')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    return { user }
  },
  component: PrivacySettingsPage,
})

function PrivacySettingsPage() {
  const [exports, setExports] = React.useState<ExportRecord[]>([])
  const [deletion, setDeletion] = React.useState<DeletionRecord | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [success, setSuccess] = React.useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)

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
    try {
      const res = await fetch('/api/me/delete-account', {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed')
      setSuccess('Account scheduled for deletion. You have 30 days to cancel.')
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
    try {
      const res = await fetch('/api/me/delete-account', {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed')
      setSuccess('Deletion cancelled. Your account is safe.')
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const daysRemaining = deletion && deletion.status === 'pending'
    ? Math.max(0, Math.ceil((new Date(deletion.gracePeriodEndsAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : 0

  return (
    <div className="p-6 max-w-3xl mx-auto" data-testid="privacy-settings-page">
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
          {error}
        </div>
      )}
      {success && (
        <div className="card border-bh-success/30 bg-bh-success/5 p-3 mb-4 text-sm text-bh-success" data-testid="privacy-success">
          {success}
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
              <button
                type="button"
                onClick={cancelDeletion}
                disabled={busy}
                className="btn-primary btn-sm"
                data-testid="cancel-deletion-btn"
              >
                Cancel deletion
              </button>
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
        <button
          type="button"
          onClick={requestExport}
          disabled={busy}
          className="btn-primary btn-sm"
          data-testid="request-export-btn"
        >
          <FileJson className="w-4 h-4" aria-hidden="true" />
          {busy ? 'Preparing…' : 'Request export'}
        </button>

        {exports.length > 0 && (
          <div className="mt-4 space-y-2" data-testid="export-list">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim">Past exports</h3>
            {exports.slice(0, 5).map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-sm py-1.5 border-b border-bh-border/40">
                <span className={`text-[10px] uppercase tracking-wider font-bold ${
                  e.status === 'ready' ? 'text-bh-success' :
                  e.status === 'expired' ? 'text-bh-text-dim' :
                  e.status === 'failed' ? 'text-bh-danger' : 'text-bh-warning'
                }`}>
                  {e.status}
                </span>
                <span className="text-bh-text-muted text-xs flex-1">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
                {e.status === 'ready' && (
                  <button
                    type="button"
                    onClick={() => downloadExport(e.id)}
                    className="btn-ghost btn-sm"
                    data-testid={`export-download-${e.id}`}
                  >
                    Download
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Delete account */}
      <section className="card border-bh-danger/30 p-5 mb-6" data-testid="delete-section">
        <h2 className="font-semibold flex items-center gap-2 mb-2 text-bh-danger">
          <AlertTriangle className="w-4 h-4" aria-hidden="true" />
          Delete account
        </h2>
        <p className="text-sm text-bh-text-muted mb-4">
          Schedules your account, saved searches, saved builders, notes, alerts, and all personal data for permanent deletion.
          You have <strong>30 days</strong> to cancel. After 30 days, the data is irrecoverable.
        </p>

        {(!deletion || deletion.status !== 'pending') && !confirmDelete && (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="btn-sm bg-bh-danger/10 text-bh-danger hover:bg-bh-danger/20 border border-bh-danger/30"
            data-testid="delete-account-btn"
          >
            <Trash2 className="w-4 h-4" aria-hidden="true" />
            Delete my account
          </button>
        )}

        {(!deletion || deletion.status !== 'pending') && confirmDelete && (
          <div className="border border-bh-danger/30 rounded-lg p-4 bg-bh-danger/5" data-testid="delete-confirm">
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
              <button
                type="button"
                onClick={requestDeletion}
                disabled={busy}
                className="btn-sm bg-bh-danger text-white hover:bg-bh-danger/90"
                data-testid="confirm-delete-btn"
              >
                {busy ? 'Scheduling…' : 'Yes, schedule deletion'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={busy}
                className="btn-secondary btn-sm"
                data-testid="cancel-confirm-btn"
              >
                <X className="w-3 h-3" aria-hidden="true" />
                Cancel
              </button>
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
          <li>Email <a href="mailto:privacy@builderhunt.dev" className="text-bh-accent hover:underline">privacy@builderhunt.dev</a> for any privacy request</li>
        </ul>
      </section>
    </div>
  )
}
