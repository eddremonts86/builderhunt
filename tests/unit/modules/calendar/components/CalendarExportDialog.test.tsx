import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CalendarExportDialog } from '~/modules/calendar/components/CalendarExportDialog'

/**
 * `CalendarExportDialog` — the bounded ICS export UI (plans/UI Wave 3 "Expose bounded ICS
 * export"). The endpoint itself already enforces auth, a required range, and a 400-day span cap;
 * this dialog's own job is to never trigger a save on anything but a real success, and to refuse a
 * doomed request client-side before it ever reaches the network.
 */

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
})

function render(props: Partial<Parameters<typeof CalendarExportDialog>[0]> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <CalendarExportDialog
        open={props.open ?? true}
        onClose={props.onClose ?? vi.fn()}
        defaultFrom={props.defaultFrom ?? new Date('2027-07-01T00:00:00.000Z')}
        defaultTo={props.defaultTo ?? new Date('2027-07-31T00:00:00.000Z')}
        requestExport={props.requestExport}
        triggerDownload={props.triggerDownload}
      />,
    )
  })
}

// The Dialog is built on a Radix portal, so its content mounts under `document.body`, not inside
// `container` — every query here has to search the whole document, not just the render root.
function testId(id: string): HTMLElement {
  const node = document.body.querySelector(`[data-testid="${id}"]`)
  if (!node) throw new Error(`missing [data-testid="${id}"]`)
  return node as HTMLElement
}

function maybeTestId(id: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
}

function setInputValue(el: HTMLElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function submit() {
  await act(async () => {
    testId('calendar-export-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

describe('CalendarExportDialog', () => {
  it('defaults the range to the caller-provided window', () => {
    render()
    expect((testId('calendar-export-from') as HTMLInputElement).value).toBe('2027-07-01')
    expect((testId('calendar-export-to') as HTMLInputElement).value).toBe('2027-07-31')
  })

  it('triggers the download and closes only after a real success response', async () => {
    const blob = new Blob(['BEGIN:VCALENDAR'], { type: 'text/calendar' })
    const requestExport = vi.fn(async () => ({ ok: true as const, status: 200, blob }))
    const triggerDownload = vi.fn()
    const onClose = vi.fn()
    render({ requestExport, triggerDownload, onClose })

    await submit()

    expect(requestExport).toHaveBeenCalledWith({
      from: '2027-07-01T00:00:00.000Z',
      to: '2027-07-31T00:00:00.000Z',
    })
    expect(triggerDownload).toHaveBeenCalledTimes(1)
    expect(triggerDownload.mock.calls[0][0]).toBe(blob)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('never downloads or closes on a failure response', async () => {
    const requestExport = vi.fn(async () => ({ ok: false as const, status: 500 }))
    const triggerDownload = vi.fn()
    const onClose = vi.fn()
    render({ requestExport, triggerDownload, onClose })

    await submit()

    expect(triggerDownload).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(testId('calendar-export-error').textContent).toContain('could not export')
  })

  it('gives a signed-out response its own message, distinct from a generic failure', async () => {
    const requestExport = vi.fn(async () => ({ ok: false as const, status: 401 }))
    render({ requestExport })
    await submit()
    expect(testId('calendar-export-error').textContent).toContain('session expired')
  })

  it('refuses an inverted range client-side, without ever calling the network', async () => {
    const requestExport = vi.fn()
    render({ requestExport, defaultFrom: new Date('2027-07-10T00:00:00.000Z'), defaultTo: new Date('2027-07-01T00:00:00.000Z') })

    await submit()

    expect(requestExport).not.toHaveBeenCalled()
    expect(testId('calendar-export-error').textContent).toContain('after the start date')
  })

  it('refuses a range wider than the server-enforced 400-day cap, without calling the network', async () => {
    const requestExport = vi.fn()
    render({ requestExport })
    setInputValue(testId('calendar-export-from'), '2020-01-01')
    setInputValue(testId('calendar-export-to'), '2027-01-01')

    await submit()

    expect(requestExport).not.toHaveBeenCalled()
    expect(testId('calendar-export-error').textContent).toContain('400 days or fewer')
  })

  it('resets to the caller\'s current range every time it reopens', async () => {
    const onClose = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <CalendarExportDialog
          open={true}
          onClose={onClose}
          defaultFrom={new Date('2027-07-01T00:00:00.000Z')}
          defaultTo={new Date('2027-07-31T00:00:00.000Z')}
        />,
      )
    })
    setInputValue(testId('calendar-export-from'), '2020-01-01')

    await act(async () => {
      root!.render(
        <CalendarExportDialog
          open={false}
          onClose={onClose}
          defaultFrom={new Date('2027-07-01T00:00:00.000Z')}
          defaultTo={new Date('2027-07-31T00:00:00.000Z')}
        />,
      )
    })
    await act(async () => {
      root!.render(
        <CalendarExportDialog
          open={true}
          onClose={onClose}
          defaultFrom={new Date('2027-08-05T00:00:00.000Z')}
          defaultTo={new Date('2027-08-20T00:00:00.000Z')}
        />,
      )
    })

    expect((testId('calendar-export-from') as HTMLInputElement).value).toBe('2027-08-05')
    expect((testId('calendar-export-to') as HTMLInputElement).value).toBe('2027-08-20')
  })

  it('renders nothing interactive when closed', () => {
    render({ open: false })
    expect(maybeTestId('calendar-export-form')).toBeNull()
  })
})
