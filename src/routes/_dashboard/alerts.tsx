import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Bell, Check, Sparkles, ExternalLink, Clock } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { formatDistanceToNow } from '~/shared/lib/format'

interface Trigger {
  id: string
  alertId: string
  userId: string
  builderId: string | null
  eventType: string
  payload: Record<string, unknown>
  matchedAt: string
  readAt: string | null
}

const EVENT_LABELS: Record<string, string> = {
  new_repo: 'New repository',
  new_product: 'New product launch',
  keyword_match: 'Keyword match',
  any_activity: 'New activity',
}

const EVENT_ICONS: Record<string, typeof Sparkles> = {
  new_repo: Sparkles,
  new_product: Bell,
  keyword_match: Check,
  any_activity: Bell,
}

export const Route = createFileRoute('/_dashboard/alerts')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    return { user }
  },
  component: AlertsInboxPage,
})

function AlertsInboxPage() {
  const [triggers, setTriggers] = React.useState<Trigger[]>([])
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/alerts/triggers', { credentials: 'include' })
      if (!res.ok) {
        setTriggers([])
        return
      }
      setTriggers(await res.json())
    } catch {
      setTriggers([])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const markRead = async (id: string) => {
    await fetch(`/api/alerts/triggers/${id}`, {
      method: 'PATCH',
      credentials: 'include',
    })
    await load()
  }

  const unread = triggers.filter((t) => !t.readAt).length

  return (
    <div className="p-6 max-w-3xl mx-auto" data-testid="alerts-inbox-page">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Bell className="w-6 h-6 text-bh-accent" aria-hidden="true" />
            Smart alerts
          </h1>
          <p className="text-sm text-bh-text-muted mt-1">
            Triggered events from your saved searches and watched builders.
            {unread > 0 && (
              <span className="ml-2 text-bh-accent font-semibold" data-testid="unread-count">
                {unread} unread
              </span>
            )}
          </p>
        </div>
        <Link to="/dashboard" className="btn-ghost btn-sm">
          Back to dashboard
        </Link>
      </header>

      {loading ? (
        <p className="text-bh-text-muted">Loading…</p>
      ) : triggers.length === 0 ? (
        <div className="card text-center py-12" data-testid="alerts-empty">
          <Bell className="w-8 h-8 text-bh-text-dim mx-auto mb-3" aria-hidden="true" />
          <p className="text-bh-text-muted mb-2">No alerts triggered yet.</p>
          <p className="text-xs text-bh-text-dim">
            Create a saved search and the system will start matching events for you.
          </p>
        </div>
      ) : (
        <div className="space-y-2" data-testid="alerts-list">
          {triggers.map((t) => {
            const Icon = EVENT_ICONS[t.eventType] ?? Bell
            const label = EVENT_LABELS[t.eventType] ?? t.eventType
            return (
              <article
                key={t.id}
                className={`card p-4 flex items-start gap-3 ${!t.readAt ? 'border-bh-accent/30 bg-bh-accent/5' : ''}`}
                data-testid={`alert-trigger-${t.id}`}
              >
                <div className="w-9 h-9 rounded-full bg-bh-accent/10 flex items-center justify-center shrink-0">
                  <Icon className="w-4 h-4 text-bh-accent" aria-hidden="true" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <p className="font-semibold text-sm text-bh-text">{label}</p>
                    {t.builderId && (
                      <Link
                        to="/builders/$builderId"
                        params={{ builderId: t.builderId }}
                        className="text-xs text-bh-accent hover:underline inline-flex items-center gap-1"
                      >
                        View builder
                        <ExternalLink className="w-2.5 h-2.5" />
                      </Link>
                    )}
                    <span className="ml-auto text-xs text-bh-text-dim flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatDistanceToNow(new Date(t.matchedAt))}
                    </span>
                  </div>
                  {t.payload?.description && typeof t.payload.description === 'string' && (
                    <p className="text-sm text-bh-text-muted line-clamp-2">
                      {t.payload.description}
                    </p>
                  )}
                  {t.payload?.name && typeof t.payload.name === 'string' && (
                    <p className="text-sm font-mono text-bh-text mt-1">
                      {t.payload.name}
                    </p>
                  )}
                </div>
                {!t.readAt && (
                  <button
                    type="button"
                    onClick={() => markRead(t.id)}
                    className="btn-ghost btn-sm shrink-0"
                    data-testid="alert-mark-read"
                    aria-label="Mark as read"
                  >
                    <Check className="w-3 h-3" />
                  </button>
                )}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
