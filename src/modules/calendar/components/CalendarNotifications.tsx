import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, Check, ExternalLink, Loader2, X } from 'lucide-react'
import { Button } from '~/components/ui'
import type { NotificationDeliveryKind, NotificationDeliveryState } from '~/shared/lib/calendar'

/**
 * Calendar notifications drawer (plans/UI Wave 3 "Build calendar notifications and unread
 * navigation").
 *
 * The feed (`GET /api/calendar/notifications`) is keyset-paginated on `(createdAt DESC, id DESC)`
 * with an opaque `<epochMillis>.<uuid>` cursor, so rows that share a timestamp still page without
 * skipping or repeating. Mark-read (`PATCH`) takes an explicit id list — there is no "mark
 * everything" server-side — and an id the caller does not own comes back simply unmarked, never as
 * an error; this drawer mirrors that by only flipping the ids the server confirms in `markedIds`.
 *
 * The payload carries no free text (only `kind`/`state`/`eventId` + timestamps), so there is
 * nothing candidate-unsafe to leak: the human-readable line is derived from `kind` here, and the
 * only event affordance is a navigate-by-id button. `unreadCount` from every response is treated as
 * authoritative rather than recomputed from the loaded window, which may not hold every unread row.
 *
 * Every control is a native element and the focus contract (initial focus, Tab/Shift+Tab trap,
 * Escape to close, focus restore) is hand-rolled — mirroring `TosModal` — so the drawer is fully
 * reachable in a plain jsdom harness and by keyboard on mobile.
 */

const KIND_LABELS: Record<NotificationDeliveryKind, string> = {
  reminder: 'Event reminder',
  invitation: 'New invitation',
  reschedule: 'Event rescheduled',
  cancellation: 'Event cancelled',
}

const STATE_NOTES: Record<NotificationDeliveryState, string | null> = {
  pending: 'Sending…',
  sent: null,
  failed: 'Delivery failed',
}

export interface CalendarNotification {
  id: string
  eventId: string | null
  reminderId: string | null
  kind: NotificationDeliveryKind
  state: NotificationDeliveryState
  attemptedAt: string | null
  deliveredAt: string | null
  readAt: string | null
  errorCode: string | null
  createdAt: string
}

export interface NotificationsPage {
  deliveries: CalendarNotification[]
  nextCursor: string | null
  unreadCount: number
}

export interface MarkReadResult {
  markedIds: string[]
  unreadCount: number
}

export interface CalendarNotificationsProps {
  /** Injected in tests; default implementations hit the real endpoints. */
  loadNotifications?: (cursor: string | null) => Promise<NotificationsPage>
  markRead?: (deliveryIds: string[]) => Promise<MarkReadResult>
  onClose: () => void
  onNavigateEvent?: (eventId: string) => void
  /** Lets a parent (e.g. a nav bell badge) mirror the authoritative unread count. */
  onUnreadChange?: (count: number) => void
}

function label(kind: NotificationDeliveryKind): string {
  return KIND_LABELS[kind]
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ── Default endpoint handlers (overridden in tests) ──────────────────────────────────────────────

async function defaultLoadNotifications(cursor: string | null): Promise<NotificationsPage> {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  const query = params.toString()
  const response = await fetch(`/api/calendar/notifications${query ? `?${query}` : ''}`)
  if (!response.ok) throw new Error('load_failed')
  return (await response.json()) as NotificationsPage
}

async function defaultMarkRead(deliveryIds: string[]): Promise<MarkReadResult> {
  const response = await fetch('/api/calendar/notifications', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveryIds }),
  })
  if (!response.ok) throw new Error('mark_failed')
  return (await response.json()) as MarkReadResult
}

export { defaultLoadNotifications, defaultMarkRead }

export function CalendarNotifications({
  loadNotifications = defaultLoadNotifications,
  markRead = defaultMarkRead,
  onClose,
  onNavigateEvent,
  onUnreadChange,
}: CalendarNotificationsProps) {
  const [deliveries, setDeliveries] = useState<CalendarNotification[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  const setUnread = useCallback((count: number) => {
    setUnreadCount(count)
    onUnreadChange?.(count)
  }, [onUnreadChange])

  useEffect(() => {
    let cancelled = false
    loadNotifications(null)
      .then((page) => {
        if (cancelled) return
        setDeliveries(page.deliveries)
        setNextCursor(page.nextCursor)
        setUnread(page.unreadCount)
      })
      .catch(() => {
        if (!cancelled) setError('We could not load your notifications. Try again.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // Load once on mount; injected handlers are stable for a given render tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Focus contract: initial focus, Escape-to-close, Tab/Shift+Tab trapped in the panel, and focus
  // restored to whatever was focused before the drawer opened.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    closeRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus?.()
    }
  }, [onClose])

  const applyMarked = useCallback((markedIds: string[], nextUnread: number) => {
    const marked = new Set(markedIds)
    setDeliveries((current) => current.map((delivery) => (marked.has(delivery.id) ? { ...delivery, readAt: delivery.readAt ?? new Date().toISOString() } : delivery)))
    setUnread(nextUnread)
  }, [setUnread])

  async function handleLoadMore() {
    if (!nextCursor) return
    setLoadingMore(true)
    setError(null)
    try {
      const page = await loadNotifications(nextCursor)
      setDeliveries((current) => {
        // Dedup by id: the keyset cursor should not overlap, but a defensive merge keeps a repeated
        // row from ever rendering twice.
        const seen = new Set(current.map((delivery) => delivery.id))
        return [...current, ...page.deliveries.filter((delivery) => !seen.has(delivery.id))]
      })
      setNextCursor(page.nextCursor)
      setUnread(page.unreadCount)
    } catch {
      setError('We could not load more notifications. Try again.')
    } finally {
      setLoadingMore(false)
    }
  }

  async function handleMarkOne(id: string) {
    setBusy(true)
    setError(null)
    try {
      const result = await markRead([id])
      applyMarked(result.markedIds, result.unreadCount)
    } catch {
      setError('We could not mark that as read. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function handleMarkAllVisible() {
    // Only the loaded, still-unread rows, capped at the server's 100-id limit.
    const ids = deliveries.filter((delivery) => delivery.readAt === null).map((delivery) => delivery.id).slice(0, 100)
    if (ids.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const result = await markRead(ids)
      applyMarked(result.markedIds, result.unreadCount)
    } catch {
      setError('We could not mark those as read. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const hasVisibleUnread = deliveries.some((delivery) => delivery.readAt === null)

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" role="presentation" onClick={onClose}>
      <div
        ref={panelRef}
        className="flex h-full w-full max-w-md flex-col border-l border-bh-border bg-bh-surface shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-notifications-title"
        data-testid="calendar-notifications"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-bh-border p-4">
          <h2 id="calendar-notifications-title" className="flex items-center gap-2 text-lg font-semibold">
            <Bell className="size-5" aria-hidden />
            Notifications
            {unreadCount > 0 && (
              <span className="rounded-full bg-bh-accent px-2 py-0.5 text-xs font-medium text-bh-accent-contrast" data-testid="calendar-notifications-unread-count">
                {unreadCount}
              </span>
            )}
          </h2>
          <button ref={closeRef} type="button" aria-label="Close notifications" onClick={onClose} data-testid="calendar-notifications-close">
            <X className="size-5 text-bh-text-muted" aria-hidden />
          </button>
        </div>

        <div className="flex items-center justify-end border-b border-bh-border px-4 py-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy || !hasVisibleUnread} onClick={handleMarkAllVisible} data-testid="calendar-notifications-mark-all">
            Mark all read
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-bh-text-muted" data-testid="calendar-notifications-loading">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Loading…
            </div>
          ) : deliveries.length === 0 ? (
            <p className="p-4 text-sm text-bh-text-muted" data-testid="calendar-notifications-empty">You have no calendar notifications.</p>
          ) : (
            <ul>
              {deliveries.map((delivery) => {
                const unread = delivery.readAt === null
                const note = STATE_NOTES[delivery.state]
                return (
                  <li key={delivery.id} className={`flex items-start gap-3 border-b border-bh-border p-4 ${unread ? 'bg-bh-accent-soft' : ''}`} data-testid={`calendar-notification-${delivery.id}`}>
                    {unread && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-bh-accent" aria-label="Unread" data-testid={`calendar-notification-unread-${delivery.id}`} />}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{label(delivery.kind)}</p>
                      <p className="text-xs text-bh-text-muted">{formatWhen(delivery.createdAt)}{note ? ` · ${note}` : ''}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {delivery.eventId && onNavigateEvent && (
                          <button type="button" className="inline-flex items-center gap-1 text-xs text-bh-accent" onClick={() => onNavigateEvent(delivery.eventId!)} data-testid={`calendar-notification-view-${delivery.id}`}>
                            <ExternalLink className="size-3" aria-hidden />
                            View event
                          </button>
                        )}
                        {unread && (
                          <button type="button" className="inline-flex items-center gap-1 text-xs text-bh-text-muted" disabled={busy} onClick={() => handleMarkOne(delivery.id)} data-testid={`calendar-notification-mark-${delivery.id}`}>
                            <Check className="size-3" aria-hidden />
                            Mark read
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {error && <p className="p-4 text-sm text-bh-danger" data-testid="calendar-notifications-error">{error}</p>}

          {nextCursor && !loading && (
            <div className="p-4">
              <Button type="button" variant="secondary" size="sm" disabled={loadingMore} onClick={handleLoadMore} data-testid="calendar-notifications-load-more">
                {loadingMore && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
                Load more
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
