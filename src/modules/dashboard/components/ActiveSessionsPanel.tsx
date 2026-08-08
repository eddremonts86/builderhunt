// table-surface-bounded: this person's live sessions, read whole — one row per device they signed in from.
import * as React from 'react'
import { Laptop, LogOut, ShieldAlert, Sparkles } from 'lucide-react'
import { authClient } from '~/shared/lib/auth/client'
import { Button } from '~/components/ui'
import { DataTable } from '~/shared/components/table'
import { emptyTableSearch } from '~/shared/lib/table/query-url'
import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult } from '~/shared/lib/table/types'

export interface ActiveSessionEntry extends Record<string, unknown> {
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

  /**
   * A page that is always the whole list.
   *
   * Sessions are model-bounded — a person has as many as they have devices — so there is no cursor
   * and no keyset endpoint. The shell renders a `PageResult` it is handed, and for a bounded list
   * one page is the last page: `nextCursor: null`, `total` the length. That is the cheap form of
   * this migration, and it is the honest one; inventing pagination here would be machinery for a
   * list that cannot grow.
   */
  const page: PageResult<ActiveSessionEntry> = React.useMemo(() => ({
    rows: sessions ?? [],
    nextCursor: null,
    total: sessions?.length ?? 0,
    facets: {},
  }), [sessions])

  const columns = React.useMemo<ColumnDef<ActiveSessionEntry>[]>(() => [
    {
      id: 'device',
      header: 'Device',
      priority: 'primary',
      value: (entry) => deviceLabel(entry),
      cell: (entry) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{deviceLabel(entry)}</span>
          {entry.isCurrent && (
            <span className="text-[10px] font-bold uppercase tracking-wider text-bh-success" data-testid="current-session-badge">
              This device
            </span>
          )}
          {entry.isNewDevice && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-bh-accent" data-testid="new-device-badge">
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              New
            </span>
          )}
          {entry.trustState === 'flagged' && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-bh-danger" data-testid="flagged-device-badge">
              <ShieldAlert className="h-3 w-3" aria-hidden="true" />
              Flagged
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'lastActive',
      header: 'Last active',
      align: 'end',
      priority: 'secondary',
      value: (entry) => entry.lastActiveAt,
      cell: (entry) => relativeTime(entry.lastActiveAt),
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      priority: 'secondary',
      // Per-row, and it stays per-row: revoking a session is not a bulk operation, and a
      // multi-select over "which of my devices to sign out" is a worse affordance than a button.
      cell: (entry) => entry.isCurrent ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void signOutSession(entry.token)}
          disabled={busyToken === entry.token}
          className="shrink-0"
          data-testid={`sign-out-btn-${entry.id}`}
        >
          {busyToken === entry.token ? 'Signing out…' : 'Sign out'}
        </Button>
      ),
    },
  ], [busyToken])

  return (
    <section className="card p-5" data-testid="active-sessions-panel">
      {/* `flex-wrap`: "Sign out everywhere else" is a long label on a `shrink-0` button, which pushed the
          document 32px past a 320px viewport. It drops below the heading there and sits beside it everywhere
          else — `shrink-0` stays, because squeezing that particular label is worse than moving it. */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <Laptop className="h-4 w-4 text-bh-accent" aria-hidden="true" />
            Active sessions
          </h2>
          <p className="mt-1 text-sm text-bh-text-muted">
            Devices currently signed in to your account.
          </p>
        </div>
        {sessions && sessions.length > 1 && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={signOutOthers}
            disabled={busyAll}
            className="shrink-0"
            data-testid="sign-out-others-btn"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            {busyAll ? 'Signing out…' : 'Sign out everywhere else'}
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-3 text-sm text-bh-danger" data-testid="active-sessions-error">{error}</div>
      )}

      <DataTable
        label="Active sessions"
        columns={columns}
        page={page}
        query={emptyTableSearch().query}
        // Nothing to change: no column is sortable, filterable or groupable on a list this size.
        onQueryChange={() => {}}
        rowTestId={(entry) => `session-row-${entry.id}`}
        status={!sessions && !error ? 'loading' : 'ready'}
        emptyState={(
          <div className="px-4 py-8 text-center text-sm text-bh-text-muted" data-testid="active-sessions-empty">
            No active sessions.
          </div>
        )}
      />
    </section>
  )
}
