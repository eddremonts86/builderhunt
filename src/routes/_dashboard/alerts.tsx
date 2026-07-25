/**
 * Smart alerts (plan: smart-alerts).
 *
 * Two deliberately distinct zones, because they answer two different
 * questions and used to look like one undifferentiated stack of rows:
 *
 *   1. "Your radars"  — configuration. What am I watching, how often, is it on?
 *   2. "Matches"      — the inbox. Who did it find, and what do I do about them?
 *
 * Matches are grouped under the radar that produced them rather than shown as
 * one flat chronological list: a match is only meaningful next to the query
 * that caught it ("this came from my Rust radar"), and grouping is what makes
 * a noisy radar visible at a glance.
 *
 * Each match renders through `PersonResultCard` — the same component Search,
 * Explore and public radars use — with a Track button beside it (the card has
 * no built-in action; see the sibling pattern in sprints/$sprintId). That is
 * what turns a match from a dead-end username into something actionable.
 */
import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Bell, BellOff, Bookmark, Check, Clock, Inbox, Pause, Play, Plus, Radar, Trash2, X } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { formatDistanceToNow } from '~/shared/lib/format'
// From `alerts-shared`, never `alerts`: the latter imports `node:crypto` and
// the tenant DB repositories, which Vite externalizes in the browser bundle
// and which crashes this page at runtime.
import { readAlertMatchPayload, type AlertMatchPayload } from '~/shared/lib/alerts-shared'
import { PersonResultCard, type PersonCardData } from '~/modules/search/components/PersonResultCard'
import { Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui'
import { Button } from '~/components/ui/button'

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
  frequency?: string
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

const FREQUENCY_OPTIONS: Array<{ value: 'hourly' | 'daily' | 'weekly'; label: string }> = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily digest' },
  { value: 'weekly', label: 'Weekly digest' },
]

const EVENT_LABELS: Record<string, string> = {
  new_repo: 'New repository',
  new_product: 'New product launch',
  keyword_match: 'Matched your keywords',
  any_activity: 'New activity',
}

/** `POST /api/builders/track`'s source enum. Bluesky/Devpost/Product Hunt can
 *  appear in a match but are not trackable yet, so their Track button is
 *  disabled with a reason rather than failing with a 400 on click. */
const TRACKABLE_SOURCES = new Set([
  'github', 'reddit', 'hn', 'devto', 'lobsters', 'stackoverflow',
  'npm', 'huggingface', 'gitlab', 'codeberg', 'hashnode', 'sourcehut',
])

export const Route = createFileRoute('/_dashboard/alerts')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    return { user }
  },
  component: AlertsInboxPage,
})

interface MatchGroup {
  alertId: string
  alertName: string
  enabled: boolean
  triggers: Trigger[]
  unread: number
}

/** Groups matches under their radar, newest group first. Triggers whose alert
 *  was deleted still surface (under a neutral label) rather than vanishing —
 *  the match already happened and the recruiter may still want to act on it. */
function groupByAlert(triggers: Trigger[], alerts: AlertRow[]): MatchGroup[] {
  const byId = new Map(alerts.map((a) => [a.id, a]))
  const groups = new Map<string, MatchGroup>()
  for (const trigger of triggers) {
    let group = groups.get(trigger.alertId)
    if (!group) {
      const alert = byId.get(trigger.alertId)
      group = {
        alertId: trigger.alertId,
        alertName: alert?.name ?? 'Deleted radar',
        enabled: alert?.enabled ?? false,
        triggers: [],
        unread: 0,
      }
      groups.set(trigger.alertId, group)
    }
    group.triggers.push(trigger)
    if (!trigger.readAt) group.unread++
  }
  return [...groups.values()]
}

function toCardData(id: string, match: AlertMatchPayload): PersonCardData {
  return {
    id,
    username: match.username,
    displayName: match.displayName ?? match.name,
    source: match.source,
    avatarUrl: match.avatarUrl ?? null,
    bio: match.bio ?? null,
    followersCount: match.followersCount ?? 0,
    profileUrl: match.profileUrl,
    language: match.language ?? null,
    country: match.country ?? null,
    topics: match.topics ?? [],
    score: match.score,
  }
}

function SummaryStat({ label, value, icon: Icon }: {
  label: string
  value: number | string
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-9 h-9 rounded-full bg-bh-accent/10 flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-bh-accent" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-bold leading-none text-bh-text">{value}</p>
        <p className="text-xs text-bh-text-dim mt-1 truncate">{label}</p>
      </div>
    </div>
  )
}

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
  const [frequency, setFrequency] = React.useState<'hourly' | 'daily' | 'weekly'>('daily')
  const [markingAll, setMarkingAll] = React.useState(false)
  const [togglingId, setTogglingId] = React.useState<string | null>(null)
  const [trackingId, setTrackingId] = React.useState<string | null>(null)
  const [trackedKeys, setTrackedKeys] = React.useState<Set<string>>(new Set())
  const [trackError, setTrackError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const [triggersRes, alertsRes] = await Promise.all([
        fetch('/api/alerts/triggers', { credentials: 'include' }),
        fetch('/api/alerts', { credentials: 'include' }),
      ])
      // Both endpoints return a bare array on success but an `{ error }`
      // object on failure — guard, or a failed request poisons `.filter`.
      const triggerData = triggersRes.ok ? await triggersRes.json() : []
      const alertData = alertsRes.ok ? await alertsRes.json() : []
      setTriggers(Array.isArray(triggerData) ? triggerData : [])
      setUserAlerts(Array.isArray(alertData) ? alertData : [])
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
    await fetch(`/api/alerts/triggers/${id}`, { method: 'PATCH', credentials: 'include' })
    await load()
  }

  const markAllRead = async (ids?: string[]) => {
    const unreadIds = ids ?? triggers.filter((t) => !t.readAt).map((t) => t.id)
    if (unreadIds.length === 0) return
    setMarkingAll(true)
    try {
      await Promise.all(
        unreadIds.map((id) =>
          fetch(`/api/alerts/triggers/${id}`, { method: 'PATCH', credentials: 'include' }),
        ),
      )
      await load()
    } finally {
      setMarkingAll(false)
    }
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
          frequency,
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

  const toggleAlertEnabled = async (id: string, enabled: boolean) => {
    setTogglingId(id)
    try {
      await fetch(`/api/alerts/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      })
      await load()
    } finally {
      setTogglingId(null)
    }
  }

  const updateAlertFrequency = async (id: string, nextFrequency: 'hourly' | 'daily' | 'weekly') => {
    await fetch(`/api/alerts/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frequency: nextFrequency }),
    })
    await load()
  }

  /** Tracks a matched person straight from the inbox. `/api/builders/track`
   *  upserts the identity, so nothing needs to exist beforehand. */
  const trackMatch = async (triggerId: string, match: AlertMatchPayload) => {
    setTrackingId(triggerId)
    setTrackError(null)
    try {
      const res = await fetch('/api/builders/track', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: match.source,
          sourceId: match.sourceId,
          username: match.username,
          profileUrl: match.profileUrl,
          displayName: match.displayName ?? null,
          avatarUrl: match.avatarUrl ?? null,
          bio: match.bio ?? null,
          language: match.language ?? null,
          country: match.country ?? null,
          followersCount: match.followersCount ?? null,
          topics: match.topics ?? [],
          score: match.score,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 402) {
        setTrackError(data.error ?? 'You have reached your plan limit for tracked builders.')
        return
      }
      if (!res.ok) {
        setTrackError(data.error ?? 'Could not track this builder.')
        return
      }
      setTrackedKeys((prev) => new Set(prev).add(`${match.source}:${match.sourceId}`))
    } catch {
      setTrackError('Could not track this builder.')
    } finally {
      setTrackingId(null)
    }
  }

  const unread = triggers.filter((t) => !t.readAt).length
  const hasAlerts = userAlerts.length > 0
  const groups = React.useMemo(() => groupByAlert(triggers, userAlerts), [triggers, userAlerts])
  const activeRadars = userAlerts.filter((a) => a.enabled).length

  return (
    <div data-testid="alerts-inbox-page">
      <header className="mb-6 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Bell className="w-6 h-6 text-bh-accent" aria-hidden="true" />
            Smart alerts
          </h1>
          <p className="text-sm text-bh-text-muted mt-1 flex items-center gap-2 flex-wrap">
            <span>Builders your radars found while you were away.</span>
            {unread > 0 && (
              <span className="badge" data-testid="unread-count">
                {unread} unread
              </span>
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          data-testid="new-alert-button"
          onClick={() => setShowForm((s) => !s)}
        >
          {showForm ? <X className="w-4 h-4" aria-hidden="true" /> : <Plus className="w-4 h-4" aria-hidden="true" />}
          {showForm ? 'Cancel' : 'New radar'}
        </Button>
      </header>

      {showForm && (
        <form
          onSubmit={createAlert}
          className="card p-5 mb-6 space-y-4"
          data-testid="alert-create-form"
        >
          <div>
            <label htmlFor="alert-name" className="block text-sm font-medium mb-1">Radar name</label>
            <Input
              id="alert-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Rust async runtime builders"
              data-testid="alert-name-input"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="alert-event-type" className="block text-sm font-medium mb-1">Notify me when…</label>
              <Select value={eventType} onValueChange={setEventType}>
                <SelectTrigger id="alert-event-type" data-testid="alert-event-type-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label htmlFor="alert-keywords" className="block text-sm font-medium mb-1">Using tech… (comma-separated)</label>
              <Input
                id="alert-keywords"
                type="text"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="rust, async, webassembly"
                data-testid="alert-keywords-input"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="alert-min-stars" className="block text-sm font-medium mb-1">Min stars / followers</label>
              <Input
                id="alert-min-stars"
                type="number"
                min={0}
                value={minStars}
                onChange={(e) => setMinStars(e.target.value)}
                placeholder="0"
                data-testid="alert-min-stars-input"
              />
            </div>

            <div>
              <label htmlFor="alert-delivery" className="block text-sm font-medium mb-1">Delivery</label>
              <Select value={deliveryChannel} onValueChange={(v) => setDeliveryChannel(v as 'email' | 'dashboard')}>
                <SelectTrigger id="alert-delivery" data-testid="alert-delivery-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Email digest + dashboard</SelectItem>
                  <SelectItem value="dashboard">Dashboard only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label htmlFor="alert-frequency" className="block text-sm font-medium mb-1">Digest frequency</label>
              <Select value={frequency} onValueChange={(v) => setFrequency(v as 'hourly' | 'daily' | 'weekly')}>
                <SelectTrigger id="alert-frequency" data-testid="alert-frequency-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FREQUENCY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {formError && (
            <p className="text-sm text-bh-danger" data-testid="alert-form-error">{formError}</p>
          )}

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={submitting} variant="primary" size="sm" data-testid="alert-submit">
              {submitting ? 'Creating…' : 'Create radar'}
            </Button>
            <Button type="button" onClick={() => setShowForm(false)} variant="ghost" size="sm">
              Cancel
            </Button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="animate-pulse space-y-6" aria-hidden="true">
          <div className="card h-20 bg-bh-surface/50" />
          <div className="space-y-2">
            <div className="h-3 w-24 bg-bh-surface rounded" />
            <div className="card h-16 bg-bh-surface/50" />
          </div>
          <div className="space-y-2">
            <div className="h-3 w-20 bg-bh-surface rounded" />
            <div className="card h-24 bg-bh-surface/50" />
            <div className="card h-24 bg-bh-surface/50" />
          </div>
        </div>
      ) : (
        <>
          {hasAlerts && (
            <div className="card p-5 mb-8 grid grid-cols-2 sm:grid-cols-4 gap-4" data-testid="alerts-summary">
              <SummaryStat label="Matches found" value={triggers.length} icon={Inbox} />
              <SummaryStat label="Unread" value={unread} icon={Bell} />
              <SummaryStat label="Active radars" value={activeRadars} icon={Radar} />
              <SummaryStat label="Paused radars" value={userAlerts.length - activeRadars} icon={BellOff} />
            </div>
          )}

          {/* ── Zone 1: configuration ─────────────────────────────────── */}
          {hasAlerts && (
            <section className="mb-10" aria-labelledby="your-radars-heading">
              <h2
                id="your-radars-heading"
                className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-3"
              >
                Your radars
              </h2>
              <div className="space-y-2" data-testid="alerts-config-list">
                {userAlerts.map((a) => {
                  const matchCount = triggers.filter((t) => t.alertId === a.id).length
                  return (
                    // Wraps on narrow viewports: the frequency Select (128px)
                    // plus two icon buttons leave ~50px for the name at 375px,
                    // which truncated every radar to "P…". Below `sm` the
                    // controls drop to their own full-width row instead.
                    <div
                      key={a.id}
                      className="card p-3 flex flex-wrap items-center gap-3"
                      data-testid={`alert-config-${a.id}`}
                    >
                      <div
                        className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                          a.enabled ? 'bg-bh-accent/10' : 'bg-bh-bg-alt'
                        }`}
                      >
                        <Radar
                          className={`w-4 h-4 ${a.enabled ? 'text-bh-accent' : 'text-bh-text-dim'}`}
                          aria-hidden="true"
                        />
                      </div>
                      {/* `basis-[calc(100%-3rem)]` on mobile = full row minus
                          the 36px icon + 12px gap, which forces the controls
                          below onto their own line instead of squeezing the
                          name into ~50px. */}
                      <div className="min-w-0 flex-1 basis-[calc(100%-3rem)] sm:basis-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium truncate">{a.name}</p>
                          {!a.enabled && (
                            <span className="badge-neutral text-[0.6875rem] px-2 py-0.5">Paused</span>
                          )}
                          <span className="text-xs text-bh-text-dim">
                            {matchCount === 1 ? '1 match' : `${matchCount} matches`}
                          </span>
                        </div>
                        <p className="text-xs text-bh-text-dim mt-0.5 truncate">
                          {EVENT_TYPE_OPTIONS.find((o) => o.value === a.triggerConditions.eventType)?.label
                            ?? a.triggerConditions.eventType}
                          {a.triggerConditions.keywords?.length ? ` · ${a.triggerConditions.keywords.join(', ')}` : ''}
                          {' · '}
                          {a.deliveryChannel === 'email' ? 'Email + dashboard' : 'Dashboard only'}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                        <Select
                          value={a.frequency ?? 'daily'}
                          onValueChange={(v) => updateAlertFrequency(a.id, v as 'hourly' | 'daily' | 'weekly')}
                        >
                          <SelectTrigger
                            className="w-32 shrink-0 text-xs"
                            aria-label="Digest frequency"
                            data-testid={`alert-frequency-edit-${a.id}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {FREQUENCY_OPTIONS.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          onClick={() => toggleAlertEnabled(a.id, a.enabled)}
                          disabled={togglingId === a.id}
                          variant="ghost"
                          size="sm"
                          className="shrink-0"
                          aria-label={a.enabled ? 'Pause radar' : 'Resume radar'}
                          title={a.enabled ? 'Pause radar' : 'Resume radar'}
                          data-testid={`alert-toggle-${a.id}`}
                        >
                          {a.enabled ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                        </Button>
                        <Button
                          type="button"
                          onClick={() => deleteAlert(a.id)}
                          variant="ghost"
                          size="sm"
                          className="shrink-0 hover:text-bh-danger hover:bg-bh-danger/10"
                          aria-label="Delete radar"
                          title="Delete radar"
                          data-testid={`alert-delete-${a.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* ── Zone 2: the inbox ─────────────────────────────────────── */}
          <section aria-labelledby="matches-heading">
            <div className="flex items-center justify-between mb-3 gap-3">
              <h2
                id="matches-heading"
                className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim"
              >
                Matches
              </h2>
              {unread > 0 && (
                <Button
                  type="button"
                  onClick={() => markAllRead()}
                  disabled={markingAll}
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  data-testid="alerts-mark-all-read"
                >
                  {markingAll ? 'Marking…' : 'Mark all as read'}
                </Button>
              )}
            </div>

            {trackError && (
              <p className="text-sm text-bh-danger mb-3" data-testid="alert-track-error">{trackError}</p>
            )}

            {groups.length === 0 ? (
              <div className="card text-center py-12" data-testid="alerts-empty">
                <Inbox className="w-8 h-8 text-bh-text-dim mx-auto mb-3" aria-hidden="true" />
                <p className="text-bh-text-muted mb-2">
                  {hasAlerts ? 'No matches yet — sit tight.' : 'No radars set up yet.'}
                </p>
                <p className="text-xs text-bh-text-dim">
                  {hasAlerts
                    ? "We'll list every builder your radars find right here."
                    : 'Create a radar above and we\'ll start watching for builders that fit.'}
                </p>
              </div>
            ) : (
              <div className="space-y-8" data-testid="alerts-list">
                {groups.map((group) => (
                  <div key={group.alertId} data-testid={`alert-group-${group.alertId}`}>
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <p className="text-sm font-semibold text-bh-text flex items-center gap-2 min-w-0">
                        <Radar className="w-3.5 h-3.5 text-bh-accent shrink-0" aria-hidden="true" />
                        <span className="truncate">{group.alertName}</span>
                        <span className="text-xs font-normal text-bh-text-dim shrink-0">
                          {group.triggers.length === 1 ? '1 match' : `${group.triggers.length} matches`}
                          {group.unread > 0 ? ` · ${group.unread} new` : ''}
                        </span>
                      </p>
                      {group.unread > 0 && (
                        <Button
                          type="button"
                          onClick={() => markAllRead(group.triggers.filter((t) => !t.readAt).map((t) => t.id))}
                          disabled={markingAll}
                          variant="ghost"
                          size="sm"
                          className="text-xs shrink-0"
                        >
                          Mark group read
                        </Button>
                      )}
                    </div>

                    <ul className="space-y-2">
                      {group.triggers.map((t) => (
                        <MatchRow
                          key={t.id}
                          trigger={t}
                          tracked={trackedKeys}
                          trackingId={trackingId}
                          onTrack={trackMatch}
                          onMarkRead={markRead}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function MatchRow({ trigger, tracked, trackingId, onTrack, onMarkRead }: {
  trigger: Trigger
  tracked: Set<string>
  trackingId: string | null
  onTrack: (triggerId: string, match: AlertMatchPayload) => void
  onMarkRead: (id: string) => void
}) {
  const match = readAlertMatchPayload(trigger.payload)
  const label = EVENT_LABELS[trigger.eventType] ?? trigger.eventType
  const isUnread = !trigger.readAt

  const meta = (
    <div className="flex items-center gap-2 text-xs text-bh-text-dim shrink-0">
      {/* `xl` only — this label is what drives the action column's width, and
          at `lg` it would eat space the person card still needs. */}
      <span className="hidden xl:inline">{label}</span>
      <span className="flex items-center gap-1">
        <Clock className="w-3 h-3" aria-hidden="true" />
        {formatDistanceToNow(new Date(trigger.matchedAt))}
      </span>
      {isUnread && (
        <Button
          type="button"
          onClick={() => onMarkRead(trigger.id)}
          variant="ghost"
          size="sm"
          data-testid="alert-mark-read"
          aria-label="Mark as read"
          title="Mark as read"
        >
          <Check className="w-3 h-3" />
        </Button>
      )}
    </div>
  )

  // Rows written before the payload carried a full person snapshot (and any
  // future non-person event) can't render a person card — fall back to the
  // plain summary rather than dropping the match.
  if (!match) {
    return (
      <li
        className={`card p-4 flex items-start gap-3 ${isUnread ? 'border-bh-accent/30 bg-bh-accent/5' : ''}`}
        data-testid={`alert-trigger-${trigger.id}`}
      >
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-bh-text">{label}</p>
          {typeof trigger.payload?.name === 'string' && (
            <p className="text-sm font-mono text-bh-text mt-1">{trigger.payload.name as string}</p>
          )}
          {trigger.builderId && (
            <Link
              to="/builders/$builderId"
              params={{ builderId: trigger.builderId }}
              className="text-xs text-bh-accent hover:underline"
            >
              View builder
            </Link>
          )}
        </div>
        {meta}
      </li>
    )
  }

  const trackKey = `${match.source}:${match.sourceId}`
  const isTracked = tracked.has(trackKey)
  const canTrack = TRACKABLE_SOURCES.has(match.source)

  return (
    // The row itself is the card, with `flatten-nested-card` stripping the
    // chrome off the `PersonResultCard` inside it — otherwise the person sits
    // in its own bordered box and the Track/read actions dangle outside it,
    // so one match reads as two broken pieces instead of a single item.
    // Stacks below `lg`, not `sm`: the action column is a fixed ~248px, so
    // side-by-side only works once the row can still leave the person real
    // space — at ~800px the card was squeezed to ~490px and
    // PersonResultCard's `truncate`d name collapsed to nothing, rendering a
    // match as a bare "@user…" with no name at all.
    <li
      className={`card flatten-nested-card p-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-3 ${
        isUnread ? 'border-bh-accent/40 bg-bh-accent/5' : ''
      }`}
      data-testid={`alert-trigger-${trigger.id}`}
    >
      <>
        <div className="flex-1 min-w-0">
          <PersonResultCard builder={toCardData(trigger.id, match)} />
        </div>
        <div className="flex flex-row-reverse items-center justify-between gap-2 shrink-0 border-t border-bh-border/60 pt-2 lg:flex-col lg:items-end lg:justify-center lg:gap-1.5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-3 lg:self-stretch">
          <Button
            type="button"
            onClick={() => onTrack(trigger.id, match)}
            disabled={isTracked || !canTrack || trackingId === trigger.id}
            variant={isTracked ? 'primary' : 'secondary'}
            size="sm"
            title={canTrack ? undefined : `Tracking ${match.source} builders isn't supported yet`}
            data-testid={`alert-track-${trigger.id}`}
          >
            <Bookmark className="w-3.5 h-3.5" aria-hidden="true" />
            {isTracked ? 'Tracked' : trackingId === trigger.id ? 'Tracking…' : 'Track'}
          </Button>
          {meta}
        </div>
      </>
    </li>
  )
}
