import * as React from 'react'
import { Laptop, LogOut, ShieldAlert, Sparkles } from 'lucide-react'
import { authClient } from '~/shared/lib/auth/client'

export interface ActiveSessionEntry {
  id: string
  token: string
  isCurrent: boolean
  createdAt: string
  lastActiveAt: string
  uaFamily: string | null
  trustState: string | null
  isNewDevice: boolean | null
  country: string | null
}

const UA_FAMILY_LABELS: Record<string, string> = {
  chrome: 'Chrome',
  firefox: 'Firefox',
  safari: 'Safari',
  edge: 'Edge',
  other: 'Other browser',
  unknown: 'Unknown device',
}

function deviceLabel(entry: ActiveSessionEntry): string {
  if (!entry.uaFamily) return 'Unknown device'
  return UA_FAMILY_LABELS[entry.uaFamily] ?? entry.uaFamily
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

/**
 * abuse-and-usage-integrity plan, Phase 1 "`/settings/security` — active
 * sessions + logbook". Lists sessions from the enriched `/api/me/sessions`
 * read model (device family, new-device flag, last-active, current badge —
 * "coarse location" isn't included yet, no ASN/geo-lookup capability exists).
 * Revoke actions call better-auth's own client methods directly — no custom
 * revoke route needed.
 */
export function ActiveSessionsPanel() {
  const [sessions, setSessions] = React.useState<ActiveSessionEntry[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busyToken, setBusyToken] = React.useState<string | null>(null)
  const [busyAll, setBusyAll] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/me/sessions', { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSessions(await res.json())
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const signOutSession = async (token: string) => {
    setBusyToken(token)
    setError(null)
    try {
      const { error: revokeError } = await authClient.revokeSession({ token })
      if (revokeError) throw new Error(revokeError.message ?? 'Failed to sign out')
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusyToken(null)
    }
  }

  const signOutOthers = async () => {
    setBusyAll(true)
    setError(null)
    try {
      const { error: revokeError } = await authClient.revokeOtherSessions()
      if (revokeError) throw new Error(revokeError.message ?? 'Failed to sign out other sessions')
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusyAll(false)
    }
  }

  return (
    <section className="glass-panel p-5" data-testid="active-sessions-panel">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <Laptop className="w-4 h-4 text-bh-accent" aria-hidden="true" />
            Active sessions
          </h2>
          <p className="text-sm text-bh-text-muted mt-1">
            Devices currently signed in to your account.
          </p>
        </div>
        {sessions && sessions.length > 1 && (
          <button
            type="button"
            onClick={signOutOthers}
            disabled={busyAll}
            className="btn-secondary btn-sm shrink-0"
            data-testid="sign-out-others-btn"
          >
            <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
            {busyAll ? 'Signing out…' : 'Sign out everywhere else'}
          </button>
        )}
      </div>

      {error && (
        <div className="text-sm text-bh-danger mb-3" data-testid="active-sessions-error">{error}</div>
      )}

      {!sessions && !error && (
        <p className="text-sm text-bh-text-muted" data-testid="active-sessions-loading">Loading…</p>
      )}

      {sessions && sessions.length === 0 && (
        <p className="text-sm text-bh-text-muted" data-testid="active-sessions-empty">No active sessions.</p>
      )}

      {sessions && sessions.length > 0 && (
        <ul className="space-y-2" data-testid="active-sessions-list">
          {sessions.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center justify-between gap-3 py-2 border-b border-bh-border/40 last:border-b-0"
              data-testid={`session-row-${entry.id}`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-bh-text">
                  {deviceLabel(entry)}
                  {entry.isCurrent && (
                    <span className="text-[10px] uppercase tracking-wider font-bold text-bh-success" data-testid="current-session-badge">
                      This device
                    </span>
                  )}
                  {entry.isNewDevice && (
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-bh-accent" data-testid="new-device-badge">
                      <Sparkles className="w-3 h-3" aria-hidden="true" />
                      New
                    </span>
                  )}
                  {entry.trustState === 'flagged' && (
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-bh-danger" data-testid="flagged-device-badge">
                      <ShieldAlert className="w-3 h-3" aria-hidden="true" />
                      Flagged
                    </span>
                  )}
                </div>
                <p className="text-xs text-bh-text-muted">
                  Last active {relativeTime(entry.lastActiveAt)}
                </p>
              </div>
              {!entry.isCurrent && (
                <button
                  type="button"
                  onClick={() => signOutSession(entry.token)}
                  disabled={busyToken === entry.token}
                  className="btn-ghost btn-sm shrink-0"
                  data-testid={`sign-out-btn-${entry.id}`}
                >
                  {busyToken === entry.token ? 'Signing out…' : 'Sign out'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
