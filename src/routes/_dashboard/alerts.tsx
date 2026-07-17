import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Bell, Check, Sparkles, ExternalLink, Clock, Plus, Trash2, X } from 'lucide-react'
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

interface AlertRow {
  id: string
  name: string
  keywords: string[]
  enabled: boolean
  deliveryChannel: string
  triggerConditions: {
    eventType: string
    minStars?: number
    minFollowers?: number
    keywords?: string[]
  }
}

const EVENT_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'any_activity', label: 'A developer launches a new repo' },
  { value: 'new_repo', label: 'A watched builder ships a new project' },
  { value: 'keyword_match', label: 'A candidate posts about looking for roles' },
  { value: 'new_product', label: 'A watched builder launches a product' },
]

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
  const [userAlerts, setUserAlerts] = React.useState<AlertRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [showForm, setShowForm] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [name, setName] = React.useState('')
  const [eventType, setEventType] = React.useState('any_activity')
  const [keywords, setKeywords] = React.useState('')
  const [minStars, setMinStars] = React.useState('')
  const [deliveryChannel, setDeliveryChannel] = React.useState<'email' | 'dashboard'>('email')

  const load = React.useCallback(async () => {
    try {
      const [triggersRes, alertsRes] = await Promise.all([
        fetch('/api/alerts/triggers', { credentials: 'include' }),
        fetch('/api/alerts', { credentials: 'include' }),
      ])
      setTriggers(triggersRes.ok ? await triggersRes.json() : [])
      setUserAlerts(alertsRes.ok ? await alertsRes.json() : [])
    } catch {
      setTriggers([])
      setUserAlerts([])
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

  const createAlert = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    setSubmitting(true)
    try {
      const keywordList = keywords.split(',').map((k) => k.trim()).filter(Boolean)
      const res = await fetch('/api/alerts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || 'Untitled alert',
          keywords: keywordList,
          deliveryChannel,
          triggerConditions: {
            eventType,
            keywords: keywordList.length > 0 ? keywordList : undefined,
            minStars: minStars ? Number(minStars) : undefined,
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFormError(data.error ?? 'Failed to create alert')
        return
      }
      setName('')
      setKeywords('')
      setMinStars('')
      setShowForm(false)
      await load()
    } catch (e) {
      setFormError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const deleteAlert = async (id: string) => {
    await fetch('/api/alerts', {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
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
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-primary btn-sm inline-flex items-center gap-1"
            data-testid="new-alert-button"
            onClick={() => setShowForm((s) => !s)}
          >
            {showForm ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            {showForm ? 'Cancel' : 'New alert'}
          </button>
          <Link to="/dashboard" className="btn-ghost btn-sm">
            Back to dashboard
          </Link>
        </div>
      </header>

      {showForm && (
        <form
          onSubmit={createAlert}
          className="card p-5 mb-6 space-y-4"
          data-testid="alert-create-form"
        >
          <div>
            <label htmlFor="alert-name" className="block text-sm font-medium mb-1">Alert name</label>
            <input
              id="alert-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Rust async runtime builders"
              className="input w-full"
              data-testid="alert-name-input"
            />
          </div>

          <div>
            <label htmlFor="alert-event-type" className="block text-sm font-medium mb-1">Notify me when…</label>
            <select
              id="alert-event-type"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              className="input w-full"
              data-testid="alert-event-type-select"
            >
              {EVENT_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="alert-keywords" className="block text-sm font-medium mb-1">Using tech… (comma-separated keywords)</label>
            <input
              id="alert-keywords"
              type="text"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="rust, async, webassembly"
              className="input w-full"
              data-testid="alert-keywords-input"
            />
          </div>

          <div>
            <label htmlFor="alert-min-stars" className="block text-sm font-medium mb-1">With at least (stars/followers)</label>
            <input
              id="alert-min-stars"
              type="number"
              min={0}
              value={minStars}
              onChange={(e) => setMinStars(e.target.value)}
              placeholder="0"
              className="input w-full"
              data-testid="alert-min-stars-input"
            />
          </div>

          <div>
            <label htmlFor="alert-delivery" className="block text-sm font-medium mb-1">Delivery</label>
            <select
              id="alert-delivery"
              value={deliveryChannel}
              onChange={(e) => setDeliveryChannel(e.target.value as 'email' | 'dashboard')}
              className="input w-full"
              data-testid="alert-delivery-select"
            >
              <option value="email">Email digest + dashboard</option>
              <option value="dashboard">Dashboard only</option>
            </select>
          </div>

          {formError && (
            <p className="text-sm text-bh-danger" data-testid="alert-form-error">{formError}</p>
          )}

          <button type="submit" disabled={submitting} className="btn-primary btn-sm" data-testid="alert-submit">
            {submitting ? 'Creating…' : 'Create alert'}
          </button>
        </form>
      )}

      {userAlerts.length > 0 && (
        <div className="mb-6 space-y-2" data-testid="alerts-config-list">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim">Your alerts</h2>
          {userAlerts.map((a) => (
            <div key={a.id} className="card p-3 flex items-center gap-3" data-testid={`alert-config-${a.id}`}>
              <Bell className="w-4 h-4 text-bh-accent shrink-0" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{a.name}</p>
                <p className="text-xs text-bh-text-dim">
                  {EVENT_TYPE_OPTIONS.find((o) => o.value === a.triggerConditions.eventType)?.label ?? a.triggerConditions.eventType}
                  {a.triggerConditions.keywords?.length ? ` · ${a.triggerConditions.keywords.join(', ')}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => deleteAlert(a.id)}
                className="btn-ghost btn-sm"
                aria-label="Delete alert"
                data-testid={`alert-delete-${a.id}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

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
                  {typeof t.payload?.description === 'string' && (
                    <p className="text-sm text-bh-text-muted line-clamp-2">
                      {t.payload.description as string}
                    </p>
                  )}
                  {typeof t.payload?.name === 'string' && (
                    <p className="text-sm font-mono text-bh-text mt-1">
                      {t.payload.name as string}
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
