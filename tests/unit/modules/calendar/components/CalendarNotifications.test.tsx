import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CalendarNotifications,
  type CalendarNotification,
  type CalendarNotificationsProps,
  type NotificationsPage,
} from '~/modules/calendar/components/CalendarNotifications'

/**
 * `CalendarNotifications` — the calendar notifications drawer (plans/UI Wave 3 "Build calendar
 * notifications and unread navigation").
 *
 * The behaviour worth pinning is the contract, not the chrome: keyset pages append without
 * duplicating a row that shares a timestamp with the previous page's tail, mark-read flips only the
 * ids the server confirms in `markedIds` (so a foreign id stays unread), the unread badge tracks the
 * authoritative `unreadCount` from every response, and Escape closes. Uses the codebase's raw
 * `react-dom/client` + `act` harness; every control is native.
 */

type LoadFn = NonNullable<CalendarNotificationsProps['loadNotifications']>
type MarkFn = NonNullable<CalendarNotificationsProps['markRead']>

function delivery(over: Partial<CalendarNotification> = {}): CalendarNotification {
  return {
    id: 'd1',
    eventId: 'e1',
    reminderId: null,
    kind: 'reminder',
    state: 'sent',
    attemptedAt: null,
    deliveredAt: null,
    readAt: null,
    errorCode: null,
    createdAt: '2027-07-15T10:00:00.000Z',
    ...over,
  }
}

function page(over: Partial<NotificationsPage> = {}): NotificationsPage {
  return { deliveries: [delivery()], nextCursor: null, unreadCount: 1, ...over }
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
  vi.restoreAllMocks()
})

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function testId(id: string): HTMLElement {
  const node = container!.querySelector(`[data-testid="${id}"]`)
  if (!node) throw new Error(`missing [data-testid="${id}"]`)
  return node as HTMLElement
}

function maybeTestId(id: string): HTMLElement | null {
  return container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
}

function countTestId(id: string): number {
  return container!.querySelectorAll(`[data-testid="${id}"]`).length
}

async function click(id: string) {
  await act(async () => {
    testId(id).click()
  })
  await flush()
}

async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await flush()
}

async function renderDrawer(props: Partial<CalendarNotificationsProps> = {}) {
  const loadNotifications = props.loadNotifications ?? vi.fn<LoadFn>(async () => page())
  const markRead = props.markRead ?? vi.fn<MarkFn>(async () => ({ markedIds: ['d1'], unreadCount: 0 }))
  const onClose = props.onClose ?? vi.fn()
  const onNavigateEvent = props.onNavigateEvent
  const onUnreadChange = props.onUnreadChange
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <CalendarNotifications
        loadNotifications={loadNotifications}
        markRead={markRead}
        onClose={onClose}
        onNavigateEvent={onNavigateEvent}
        onUnreadChange={onUnreadChange}
      />,
    )
  })
  await flush()
  return { loadNotifications, markRead, onClose, onNavigateEvent, onUnreadChange }
}

describe('CalendarNotifications', () => {
  it('renders the loaded deliveries and the unread badge', async () => {
    await renderDrawer({ loadNotifications: vi.fn<LoadFn>(async () => page({ unreadCount: 3 })) })
    testId('calendar-notifications')
    testId('calendar-notification-d1')
    expect(testId('calendar-notifications-unread-count').textContent).toBe('3')
  })

  it('shows the empty state and no badge when there are no notifications', async () => {
    await renderDrawer({ loadNotifications: vi.fn<LoadFn>(async () => page({ deliveries: [], unreadCount: 0 })) })
    testId('calendar-notifications-empty')
    expect(maybeTestId('calendar-notifications-unread-count')).toBeNull()
  })

  it('pages by keyset cursor and never renders a shared-timestamp row twice', async () => {
    const loadNotifications = vi.fn<LoadFn>(async (cursor) => {
      if (cursor === null) {
        return page({ deliveries: [delivery({ id: 'd1', createdAt: '2027-07-15T10:00:00.000Z' })], nextCursor: 'CURSOR', unreadCount: 2 })
      }
      // The next page's first row shares d1's timestamp; a naive concat would duplicate it.
      return page({
        deliveries: [
          delivery({ id: 'd1', createdAt: '2027-07-15T10:00:00.000Z' }),
          delivery({ id: 'd2', createdAt: '2027-07-15T10:00:00.000Z' }),
        ],
        nextCursor: null,
        unreadCount: 2,
      })
    })
    await renderDrawer({ loadNotifications })

    await click('calendar-notifications-load-more')
    expect(loadNotifications).toHaveBeenNthCalledWith(2, 'CURSOR')
    expect(countTestId('calendar-notification-d1')).toBe(1)
    testId('calendar-notification-d2')
  })

  it('marks one read, flipping only that row and syncing the badge', async () => {
    const markRead = vi.fn<MarkFn>(async () => ({ markedIds: ['d1'], unreadCount: 0 }))
    const onUnreadChange = vi.fn()
    await renderDrawer({ loadNotifications: vi.fn<LoadFn>(async () => page({ unreadCount: 1 })), markRead, onUnreadChange })

    await click('calendar-notification-mark-d1')
    expect(markRead).toHaveBeenCalledWith(['d1'])
    expect(maybeTestId('calendar-notification-mark-d1')).toBeNull()
    expect(maybeTestId('calendar-notification-unread-d1')).toBeNull()
    expect(maybeTestId('calendar-notifications-unread-count')).toBeNull()
    expect(onUnreadChange).toHaveBeenLastCalledWith(0)
  })

  it('mark-all sends every loaded unread id but flips only the ids the server confirms', async () => {
    const loadNotifications = vi.fn<LoadFn>(async () => page({
      deliveries: [delivery({ id: 'd1' }), delivery({ id: 'd2' })],
      unreadCount: 2,
    }))
    // Server marks only d1 (d2 is, say, not the caller's) and reports one still unread.
    const markRead = vi.fn<MarkFn>(async () => ({ markedIds: ['d1'], unreadCount: 1 }))
    await renderDrawer({ loadNotifications, markRead })

    await click('calendar-notifications-mark-all')
    expect(markRead).toHaveBeenCalledWith(['d1', 'd2'])
    expect(maybeTestId('calendar-notification-mark-d1')).toBeNull()
    testId('calendar-notification-mark-d2')
    expect(testId('calendar-notifications-unread-count').textContent).toBe('1')
  })

  it('navigates to an event by id from a notification', async () => {
    const onNavigateEvent = vi.fn()
    await renderDrawer({ loadNotifications: vi.fn<LoadFn>(async () => page({ deliveries: [delivery({ id: 'd1', eventId: 'evt-9' })] })), onNavigateEvent })
    await click('calendar-notification-view-d1')
    expect(onNavigateEvent).toHaveBeenCalledWith('evt-9')
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    await renderDrawer({ onClose })
    await pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('surfaces an error when the initial load fails', async () => {
    await renderDrawer({
      loadNotifications: vi.fn<LoadFn>(async () => {
        throw new Error('load_failed')
      }),
    })
    testId('calendar-notifications-error')
  })
})
