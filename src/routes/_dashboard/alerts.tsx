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
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Bell, BellOff, Check, Clock, Inbox, Pause, Play, Plus, Radar, Send, Trash2, X } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { formatDistanceToNow } from '~/shared/lib/format'
// From `alerts-shared`, never `alerts`: the latter imports `node:crypto` and
// the tenant DB repositories, which Vite externalizes in the browser bundle
// and which crashes this page at runtime.
import { readAlertMatchPayload, type AlertMatchPayload } from '~/shared/lib/alerts-shared'
import { PersonResultCard, type PersonCardData } from '~/modules/search/components/PersonResultCard'
import { DataTable } from '~/shared/components/table'
import type { ColumnDef } from '~/shared/lib/table/columns'
import {
  pickTableSearchParams,
  serializeTableSearch,
  tableSearchSchema,
  tableSearchToParams,
} from '~/shared/lib/table/query-url'
import type { PageResult, TableQuery, TableSearch } from '~/shared/lib/table/types'
import { BuilderResultActions } from '~/modules/search/components/BuilderResultActions'
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

/**
 * These are **match labels, not detected events** — the exact wording of
 * `plans/phase-1/34-smart-alerts/spec.md` §"Honest v1 semantics".
 *
 * The labels used to be event sentences: "A developer launches a new repo",
 * "A watched builder ships a new project", "A candidate posts about looking for
 * roles". Every one of those describes something the product does not observe.
 * There is no per-builder activity stream; the worker runs the radar's keyword
 * search and reports profiles it had not seen before
 * (`src/lib/alerts/worker.ts`, which files every trigger as `keyword_match`
 * for the same reason). Worse, the first option said "launches a new repo"
 * while storing `any_activity`, which `evaluateMatch` treats as matching
 * *everything* — so the one option a user would pick to get new-repo alerts was
 * the one that could never be narrowed.
 *
 * Corrected 2026-08-05 to name the label rather than assert an event. The
 * helper line under the select carries the caveat, so the honesty is on the
 * screen and not only in the spec. Real event detection arrives with
 * `plans/phase-1/33-unified-timeline`; when it does, these become real events
 * and this comment can go.
 */
const EVENT_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'any_activity', label: 'Any match' },
  { value: 'new_repo', label: 'New repository' },
  { value: 'keyword_match', label: 'Keyword match' },
  { value: 'new_product', label: 'New product launch' },
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

export const Route = createFileRoute('/_dashboard/alerts')({
  // The inbox's state is the URL: which radar, which match type, how it is grouped. Flat params,
  // not a parsed `TableSearch` — the router re-serializes whatever this returns.
  validateSearch: (raw: Record<string, unknown>) => pickTableSearchParams(raw),
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    return { user }
  },
  component: AlertsInboxPage,
})

/** A trigger plus the name of the radar that found it — see `pageOrganizationTriggers`. */
type TriggerRow = Trigger & { alertName: string | null } & Record<string, unknown>

const EMPTY_TRIGGERS: PageResult<TriggerRow> = { rows: [], nextCursor: null, total: 0, facets: {} }

const ALERT_TRIGGER_LABELS: Record<string, string> = { alertId: 'Radar', eventType: 'Match type' }

/**
 * `MatchGroup` and `groupByAlert` used to live here.
 *
 * They grouped whatever triggers the browser held — 100 of them, with no way to ask for the 101st —
 * and printed `group.triggers.length` as the group's size. For a radar with 300 matches the header
 * said "12 matches", and it looked entirely right, which is why it survived. The shell's grouping
 * replaces it: the server orders by `(alert_id, matched_at)` so a group is contiguous, and the
 * header's total comes from the server's facet over the whole filtered set.
 *
 * Grouping is by `alertId`, not by name — two radars may share one — so `groupLabel` maps the id
 * back to the name, and a match whose radar was deleted still surfaces under a neutral label rather
 * than vanishing.
 */
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
  /** `null` renders an em dash. `PageResult.total` is nullable now that a federated page can hold
   * a genuinely unknowable count; on this surface it never is, and `?? 0` would be the reflex that
   * turns "we do not know" into a confident zero on whichever surface acquires one first. */
  value: number | string | null
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-9 h-9 rounded-full bg-bh-accent/10 flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-bh-accent" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-bold leading-none text-bh-text">{value ?? '—'}</p>
        <p className="text-xs text-bh-text-dim mt-1 truncate">{label}</p>
      </div>
    </div>
  )
}

function AlertsInboxPage() {
  const params = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  // Grouped by radar unless the URL says otherwise — that is how the inbox has always read.
  const search = React.useMemo(() => {
    const parsed = tableSearchSchema(params)
    return parsed.query.groupBy === null && params.group === undefined
      ? { ...parsed, query: { ...parsed.query, groupBy: 'alertId' } }
      : parsed
  }, [params])

  const [triggersPage, setTriggersPage] = React.useState<PageResult<TriggerRow>>(EMPTY_TRIGGERS)
  const [userAlerts, setUserAlerts] = React.useState<AlertRow[]>([])
  /** The whole organization's unread count, not the loaded page's. Its own endpoint. */
  const [unread, setUnread] = React.useState(0)
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
  // Keyed by `${source}:${sourceId}` → the organization-builder id, populated only by a track
  // that happens in this session (there is no endpoint yet returning the id for a match that was
  // already tracked in an earlier session, so those still show "Track & open" — a pre-existing
  // gap, not a regression from this component now being able to open the workspace at all).
  const [trackedRowIds, setTrackedRowIds] = React.useState<Map<string, string>>(new Map())
  const [confirmingTestId, setConfirmingTestId] = React.useState<string | null>(null)
  const [sendingTestId, setSendingTestId] = React.useState<string | null>(null)
  const [testResults, setTestResults] = React.useState<Map<string, { kind: 'delivered' | 'degraded' | 'rate_limited'; message: string }>>(new Map())

  /**
   * Both endpoints answer a `PageResult` now.
   *
   * The radar list reads `.rows` and stays the card list it was — the task asked for the inbox's
   * grouping to move to the shell, not for the radar cards (test-send, frequency, enable, the last
   * evaluation error) to become table cells. Its read is bounded either way.
   */
  const load = React.useCallback(async (next: TableSearch, append = false) => {
    try {
      const [triggersRes, alertsRes, unreadRes] = await Promise.all([
        fetch(`/api/alerts/triggers?${tableSearchToParams(next).toString()}`, { credentials: 'include' }),
        fetch('/api/alerts', { credentials: 'include' }),
        fetch('/api/alerts/triggers/unread-count', { credentials: 'include' }),
      ])
      const triggerPage = triggersRes.ok ? await triggersRes.json() as PageResult<TriggerRow> : EMPTY_TRIGGERS
      const alertPage = alertsRes.ok ? await alertsRes.json() as PageResult<AlertRow> : null
      const unreadBody = unreadRes.ok ? await unreadRes.json() as { count?: number } : null
      setTriggersPage((current) => append
        ? { ...triggerPage, rows: [...current.rows, ...triggerPage.rows] }
        : triggerPage)
      setUserAlerts(Array.isArray(alertPage?.rows) ? alertPage.rows : [])
      setUnread(unreadBody?.count ?? 0)
    } catch {
      setTriggersPage(EMPTY_TRIGGERS)
      setUserAlerts([])
    } finally {
      setLoading(false)
    }
  }, [])

  const searchKey = tableSearchToParams(search).toString()
  React.useEffect(() => {
    void load(search)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey])

  const reload = React.useCallback(() => load(search), [load, search])

  const markRead = async (id: string) => {
    await fetch(`/api/alerts/triggers/${id}`, { method: 'PATCH', credentials: 'include' })
    await reload()
  }

  /**
   * Marks the *loaded* matches read, which is what it always did.
   *
   * It was labelled "Mark all as read" while operating on the 100 triggers the browser held. That
   * was already inaccurate; it becomes a visible inaccuracy now that the unread badge shows the
   * organization's real total, so the label says what it does.
   */
  const markAllRead = async (ids?: string[]) => {
    const unreadIds = ids ?? triggersPage.rows.filter((t) => !t.readAt).map((t) => t.id)
    if (unreadIds.length === 0) return
    setMarkingAll(true)
    try {
      await Promise.all(
        unreadIds.map((id) =>
          fetch(`/api/alerts/triggers/${id}`, { method: 'PATCH', credentials: 'include' }),
        ),
      )
      await reload()
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
      await reload()
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
    await reload()
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
      await reload()
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
    await reload()
  }

  const sendTestAlert = async (id: string) => {
    setSendingTestId(id)
    try {
      const res = await fetch(`/api/alerts/${id}/test-send`, { method: 'POST', credentials: 'include' })
      const body = await res.json().catch(() => ({}))
      setConfirmingTestId(null)
      if (res.status === 429) {
        setTestResults((prev) => new Map(prev).set(id, { kind: 'rate_limited', message: 'Too many test sends — try again later.' }))
        return
      }
      if (!res.ok || body.degraded) {
        setTestResults((prev) => new Map(prev).set(id, { kind: 'degraded', message: body.message ?? body.error ?? 'Test delivery failed.' }))
        return
      }
      setTestResults((prev) => new Map(prev).set(id, {
        kind: 'delivered',
        message: body.channel === 'email' ? 'Test email sent.' : 'Dashboard delivery confirmed.',
      }))
    } catch {
      setTestResults((prev) => new Map(prev).set(id, { kind: 'degraded', message: 'Network error sending test.' }))
    } finally {
      setSendingTestId(null)
    }
  }

  const onMatchTracked = React.useCallback((match: AlertMatchPayload, organizationBuilderId: string) => {
    setTrackedRowIds((prev) => new Map(prev).set(`${match.source}:${match.sourceId}`, organizationBuilderId))
  }, [])

  const hasAlerts = userAlerts.length > 0
  const activeRadars = userAlerts.filter((a) => a.enabled).length
  const alertNames = React.useMemo(
    () => new Map(userAlerts.map((alert) => [alert.id, alert.name])),
    [userAlerts],
  )
  /** A match whose radar was deleted keeps its row; the row carries the label. */
  const radarLabel = React.useCallback(
    (alertId: string) => alertNames.get(alertId)
      ?? triggersPage.rows.find((row) => row.alertId === alertId)?.alertName
      ?? 'Deleted radar',
    [alertNames, triggersPage.rows],
  )
  const loadedUnread = triggersPage.rows.filter((t) => !t.readAt).length

  /**
   * One wide column carrying the person card, plus the two the grouping and the chips need.
   *
   * Deliberately not a cell-per-field table. A match is a *person*, and `PersonResultCard` — the
   * same component Search and Explore use — is what makes it actionable rather than a username in a
   * cell. The shell does not require a row to be thin; it requires the server to have decided which
   * rows and in what order, which it now has.
   */
  const matchColumns = React.useMemo<ColumnDef<TriggerRow>[]>(() => [
    {
      id: 'match',
      header: 'Match',
      priority: 'primary',
      // The row *is* this column. At an equal share of the width beside the two thin ones, the
      // person card collapsed to an avatar and a truncated username.
      weight: 6,
      value: (trigger) => trigger.id,
      cell: (trigger) => (
        <MatchRow
          trigger={trigger}
          trackedRowIds={trackedRowIds}
          onTracked={onMatchTracked}
          onMarkRead={markRead}
        />
      ),
    },
    {
      id: 'alertId',
      header: 'Radar',
      groupable: true,
      priority: 'secondary',
      // The grouped value must be what the server counted — the id — or `GroupRow` has no honest
      // total. `groupLabel` turns it into the name for display.
      value: (trigger) => trigger.alertId,
      cell: (trigger) => (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-bh-text-dim">
          <Radar className="w-3 h-3 shrink-0 text-bh-accent" aria-hidden="true" />
          <span className="truncate">{radarLabel(trigger.alertId)}</span>
        </span>
      ),
    },
    {
      id: 'matchedAt',
      header: 'Matched',
      sortable: true,
      align: 'end',
      priority: 'secondary',
      value: (trigger) => trigger.matchedAt,
      cell: (trigger) => formatDistanceToNow(new Date(trigger.matchedAt)),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [radarLabel, trackedRowIds, onMatchTracked])

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
              <label htmlFor="alert-event-type" className="block text-sm font-medium mb-1">File matches as…</label>
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
              {/* The caveat belongs next to the control, not only in the spec — see
                  the comment on EVENT_TYPE_OPTIONS. */}
              <p className="mt-1 text-xs text-bh-text-dim" data-testid="alert-event-type-caveat">
                A label for your inbox, not a watched event. A radar runs your keywords and reports
                profiles it has not shown you before.
              </p>
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
              {/* The whole filtered set, from `PageResult.total` — not the loaded page's length,
                  which is what this stat used to show. */}
              <SummaryStat label="Matches found" value={triggersPage.total} icon={Inbox} />
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
                  // The server's count for this radar over the whole filtered set — the facet the
                  // group headers use. `null` when the radar has no matches at all.
                  const matchCount = triggersPage.facets.alertId?.find((facet) => facet.value === a.id)?.count ?? 0
                  const testResult = testResults.get(a.id)
                  return (
                    // Wraps on narrow viewports: the frequency Select (128px)
                    // plus two icon buttons leave ~50px for the name at 375px,
                    // which truncated every radar to "P…". Below `sm` the
                    // controls drop to their own full-width row instead.
                    <React.Fragment key={a.id}>
                    <div
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
                          onClick={() => { setConfirmingTestId(a.id); setTestResults((prev) => { const next = new Map(prev); next.delete(a.id); return next }) }}
                          disabled={!a.enabled || sendingTestId === a.id}
                          variant="ghost"
                          size="sm"
                          className="shrink-0"
                          aria-label="Send test"
                          title={a.enabled ? 'Send test' : 'Resume this radar to test it'}
                          data-testid={`alert-test-send-${a.id}`}
                        >
                          <Send className="w-3.5 h-3.5" />
                        </Button>
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
                    {confirmingTestId === a.id && (
                      <div className="card p-3 -mt-1 space-y-2 border-bh-accent/30" data-testid={`alert-test-confirm-${a.id}`}>
                        <p className="text-sm text-bh-text">
                          Send a test to confirm delivery — {a.deliveryChannel === 'email' ? 'email + dashboard' : 'dashboard only'},{' '}
                          {(a.frequency ?? 'daily')} cadence. No real match is required and none is recorded.
                        </p>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            onClick={() => sendTestAlert(a.id)}
                            disabled={sendingTestId === a.id}
                            variant="secondary"
                            size="sm"
                            data-testid={`alert-test-confirm-button-${a.id}`}
                          >
                            {sendingTestId === a.id ? 'Sending…' : 'Send test'}
                          </Button>
                          <Button
                            type="button"
                            onClick={() => setConfirmingTestId(null)}
                            disabled={sendingTestId === a.id}
                            variant="ghost"
                            size="sm"
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                    {testResult && (
                      <p
                        className={`text-xs px-1 -mt-1 ${
                          testResult.kind === 'delivered' ? 'text-bh-success'
                            : testResult.kind === 'rate_limited' ? 'text-bh-warning' : 'text-bh-danger'
                        }`}
                        role={testResult.kind === 'delivered' ? 'status' : 'alert'}
                        data-testid={`alert-test-result-${a.id}`}
                        data-result={testResult.kind}
                      >
                        {testResult.message}
                      </p>
                    )}
                    </React.Fragment>
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
              {loadedUnread > 0 && (
                <Button
                  type="button"
                  onClick={() => markAllRead()}
                  disabled={markingAll}
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  data-testid="alerts-mark-all-read"
                >
                  {/* It marks the loaded matches, which is all it ever did. The badge above now
                      shows the organization's real unread total, so "all" would be a visible lie. */}
                  {markingAll ? 'Marking…' : `Mark these ${loadedUnread} as read`}
                </Button>
              )}
            </div>

            <DataTable
              label="Alert matches"
              columns={matchColumns}
              page={triggersPage}
              query={search.query}
              onQueryChange={(query: TableQuery) => void navigate({
                search: serializeTableSearch({ ...search, query, page: { ...search.page, cursor: null } }),
                replace: true,
              })}
              renderer="grouped"
              // The stored values are alert ids, because that is what the server counted its facet
              // over and because two radars may share a name. This is where they become readable —
              // in the group header, the chips, the command sheet and the filtered-empty copy alike.
              valueLabel={(dimension, value) => dimension === 'alertId' ? radarLabel(value) : value}
              rowTestId={(trigger) => `alert-trigger-${trigger.id}`}
              rowId={(trigger) => trigger.id}
              filterLabels={ALERT_TRIGGER_LABELS}
              // Nothing on `alert_triggers` is searchable: the only text worth typing is inside the
              // `payload` jsonb. See the capability.
              searchable={false}
              status={loading && triggersPage.rows.length === 0 ? 'loading' : 'ready'}
              onLoadMore={() => {
                if (!triggersPage.nextCursor || loading) return
                void load({ ...search, page: { ...search.page, cursor: triggersPage.nextCursor } }, true)
              }}
              emptyState={(
                <div className="px-4 py-12 text-center" data-testid="alerts-empty">
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
              )}
            />
          </section>
        </>
      )}
    </div>
  )
}

function MatchRow({ trigger, trackedRowIds, onTracked, onMarkRead }: {
  trigger: Trigger
  trackedRowIds: Map<string, string>
  onTracked: (match: AlertMatchPayload, organizationBuilderId: string) => void
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
      <div className={`flex w-full items-start gap-3 ${isUnread ? 'font-medium' : ''}`}>
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
      </div>
    )
  }

  const trackKey = `${match.source}:${match.sourceId}`
  const trackedRowId = trackedRowIds.get(trackKey) ?? null

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
    <div
      className={`flatten-nested-card flex w-full flex-col gap-2 lg:flex-row lg:items-center lg:gap-3 ${
        isUnread ? 'border-l-2 border-bh-accent pl-2' : ''
      }`}
    >
      <>
        <div className="flex-1 min-w-0">
          <PersonResultCard builder={toCardData(trigger.id, match)} />
        </div>
        <div className="flex flex-row-reverse items-center justify-between gap-2 shrink-0 border-t border-bh-border/60 pt-2 lg:flex-col lg:items-end lg:justify-center lg:gap-1.5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-3 lg:self-stretch">
          <BuilderResultActions
            builder={{
              id: trigger.id,
              source: match.source,
              sourceId: match.sourceId,
              username: match.username,
              displayName: match.displayName ?? match.name,
              avatarUrl: match.avatarUrl ?? null,
              bio: match.bio ?? null,
              profileUrl: match.profileUrl,
              followersCount: match.followersCount ?? null,
              language: match.language ?? null,
              country: match.country ?? null,
              topics: match.topics ?? [],
              score: match.score,
              tracked: trackedRowId !== null,
              trackedRowId,
            }}
            from="/alerts"
            onTracked={(organizationBuilderId) => onTracked(match, organizationBuilderId)}
          />
          {meta}
        </div>
      </>
    </div>
  )
}
