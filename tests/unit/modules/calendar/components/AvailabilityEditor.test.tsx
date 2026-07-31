import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  AvailabilityEditor,
  type AvailabilityEditorProps,
  type AvailabilityPolicyValue,
} from '~/modules/calendar/components/AvailabilityEditor'

/**
 * `AvailabilityEditor` — the availability + default-reminder settings surface (plans/UI Wave 3
 * "Build availability and default-reminder settings").
 *
 * What matters is not that fields render but that the editor speaks the optimistic-versioned
 * `/api/calendar/availability` contract exactly: it saves under the version it loaded, adopts the
 * bumped version the server returns (so a compatible-overlap MERGE is reflected without a reload),
 * routes a stale write (`state_changed`) and a conflicting overlap (`invalid_input` + message) to
 * distinct, actionable copy, and drives blocked/custom overrides through the dedicated single-
 * override endpoints. Uses the codebase's raw `react-dom/client` + `act` harness — every control is
 * a native element, so no portal-aware testing library is needed.
 */

type LoadFn = NonNullable<AvailabilityEditorProps['loadPolicy']>
type SaveFn = NonNullable<AvailabilityEditorProps['savePolicy']>
type CreateOverrideFn = NonNullable<AvailabilityEditorProps['createOverride']>
type DeleteOverrideFn = NonNullable<AvailabilityEditorProps['deleteOverride']>

function basePolicy(patch: Partial<AvailabilityPolicyValue> = {}): AvailabilityPolicyValue {
  return {
    version: 1,
    rules: [
      {
        timeZone: 'UTC',
        weekdays: [1, 2, 3, 4, 5],
        localStart: '09:00',
        localEnd: '17:00',
        slotMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minNoticeMinutes: 60,
        horizonDays: 30,
        enabled: true,
      },
    ],
    overrides: [],
    defaultReminderOffsets: [30],
    defaultReminderChannels: ['in_app'],
    ...patch,
  }
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

async function setValue(id: string, value: string) {
  const el = testId(id) as HTMLInputElement | HTMLSelectElement
  const proto = el instanceof HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  await act(async () => {
    setter?.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

async function click(id: string) {
  await act(async () => {
    testId(id).click()
  })
  await flush()
}

async function submit() {
  const form = testId('availability-editor') as HTMLFormElement
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await flush()
}

async function renderEditor(props: Partial<AvailabilityEditorProps> = {}) {
  const loadPolicy = props.loadPolicy ?? vi.fn<LoadFn>(async () => basePolicy())
  const savePolicy = props.savePolicy ?? vi.fn<SaveFn>(async () => ({ ok: true, policy: basePolicy({ version: 2 }) }))
  const createOverride = props.createOverride ?? vi.fn<CreateOverrideFn>(async () => ({ ok: true, policy: basePolicy({ version: 2 }) }))
  const deleteOverride = props.deleteOverride ?? vi.fn<DeleteOverrideFn>(async () => ({ ok: true, policy: basePolicy({ version: 2 }) }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <AvailabilityEditor
        defaultTimezone={props.defaultTimezone ?? 'UTC'}
        timezoneOptions={props.timezoneOptions ?? ['UTC', 'America/New_York']}
        loadPolicy={loadPolicy}
        savePolicy={savePolicy}
        createOverride={createOverride}
        deleteOverride={deleteOverride}
        onClose={props.onClose}
      />,
    )
  })
  await flush()
  return { loadPolicy, savePolicy, createOverride, deleteOverride }
}

describe('AvailabilityEditor', () => {
  it('renders the loaded policy into its rule, reminder, and save controls', async () => {
    await renderEditor()
    testId('availability-editor')
    testId('availability-timezone')
    testId('availability-rule-0')
    testId('availability-reminder-channel-in_app')
    testId('availability-reminder-offset-30')
    testId('availability-save')
  })

  it('saves under the loaded version and adopts the version the server returns', async () => {
    const savePolicy = vi.fn<SaveFn>(async () => ({ ok: true, policy: basePolicy({ version: 2 }) }))
    await renderEditor({ savePolicy })
    await submit()

    expect(savePolicy).toHaveBeenCalledTimes(1)
    const [body] = savePolicy.mock.calls[0]
    expect(body.version).toBe(1)
    expect(body.rules).toHaveLength(1)
    expect(body.defaultReminderChannels).toEqual(['in_app'])
    expect(body.defaultReminderOffsets).toEqual([30])
    testId('availability-saved')

    // A second save must not replay the stale version 1.
    await submit()
    expect(savePolicy.mock.calls[1][0].version).toBe(2)
  })

  it('surfaces a distinct reload message when the save is stale (state_changed)', async () => {
    const savePolicy = vi.fn<SaveFn>(async () => ({ ok: false, error: 'state_changed' }))
    await renderEditor({ savePolicy })
    await submit()
    expect(testId('availability-error').textContent).toMatch(/changed since you opened/i)
    expect(maybeTestId('availability-saved')).toBeNull()
  })

  it('explains a conflicting overlap with the server-authored message', async () => {
    const message = 'Two availability rules overlap on the same day with different slot settings'
    const savePolicy = vi.fn<SaveFn>(async () => ({ ok: false, error: 'invalid_input', message }))
    await renderEditor({ savePolicy })
    await submit()
    expect(testId('availability-error').textContent).toContain(message)
  })

  it('reflects a compatible-overlap merge by re-rendering from the normalized response', async () => {
    const twoRules = basePolicy({
      rules: [
        { ...basePolicy().rules[0], weekdays: [1] },
        { ...basePolicy().rules[0], weekdays: [2] },
      ],
    })
    const merged = basePolicy({ version: 2, rules: [{ ...basePolicy().rules[0], weekdays: [1, 2] }] })
    const savePolicy = vi.fn<SaveFn>(async () => ({ ok: true, policy: merged }))
    await renderEditor({ loadPolicy: vi.fn<LoadFn>(async () => twoRules), savePolicy })

    testId('availability-rule-0')
    testId('availability-rule-1')
    await submit()
    expect(maybeTestId('availability-rule-1')).toBeNull()
  })

  it('adds a blocked override with null times under the current version', async () => {
    const createOverride = vi.fn<CreateOverrideFn>(async (_version, override) => ({
      ok: true,
      policy: basePolicy({ version: 2, overrides: [override] }),
    }))
    await renderEditor({ createOverride })

    await setValue('availability-override-date', '2027-08-01')
    // Blocked is the default kind, so no time inputs are shown.
    expect(maybeTestId('availability-override-start')).toBeNull()
    await click('availability-override-add')

    expect(createOverride).toHaveBeenCalledTimes(1)
    expect(createOverride.mock.calls[0][0]).toBe(1)
    expect(createOverride.mock.calls[0][1]).toEqual({
      localDate: '2027-08-01',
      localStart: null,
      localEnd: null,
      kind: 'blocked',
      timeZone: 'UTC',
    })
    testId('availability-override-0')
  })

  it('adds a custom-hours override carrying its start and end times', async () => {
    const createOverride = vi.fn<CreateOverrideFn>(async (_version, override) => ({
      ok: true,
      policy: basePolicy({ version: 2, overrides: [override] }),
    }))
    await renderEditor({ createOverride })

    await setValue('availability-override-kind', 'available')
    await setValue('availability-override-date', '2027-08-02')
    await setValue('availability-override-start', '10:00')
    await setValue('availability-override-end', '14:00')
    await click('availability-override-add')

    expect(createOverride.mock.calls[0][1]).toEqual({
      localDate: '2027-08-02',
      localStart: '10:00',
      localEnd: '14:00',
      kind: 'available',
      timeZone: 'UTC',
    })
  })

  it('removes an override by its local date', async () => {
    const withOverride = basePolicy({
      overrides: [{ localDate: '2027-08-01', localStart: null, localEnd: null, kind: 'blocked', timeZone: 'UTC' }],
    })
    const deleteOverride = vi.fn<DeleteOverrideFn>(async () => ({ ok: true, policy: basePolicy({ version: 2 }) }))
    await renderEditor({ loadPolicy: vi.fn<LoadFn>(async () => withOverride), deleteOverride })

    testId('availability-override-0')
    await click('availability-override-remove-0')

    expect(deleteOverride).toHaveBeenCalledWith(1, '2027-08-01')
    testId('availability-overrides-empty')
  })

  it('carries weekday, channel, and offset toggles into the saved body', async () => {
    const savePolicy = vi.fn<SaveFn>(async () => ({ ok: true, policy: basePolicy({ version: 2 }) }))
    await renderEditor({ savePolicy })

    await click('availability-rule-weekday-0-6') // add Saturday
    await click('availability-reminder-channel-email') // add email
    await click('availability-reminder-offset-60') // add 1h-before
    await submit()

    const [body] = savePolicy.mock.calls[0]
    expect(body.rules[0].weekdays).toContain(6)
    expect(body.defaultReminderChannels).toEqual(expect.arrayContaining(['in_app', 'email']))
    expect(body.defaultReminderOffsets).toEqual(expect.arrayContaining([30, 60]))
  })

  it('offers a reload when the initial policy load fails', async () => {
    const loadPolicy = vi.fn<LoadFn>(async () => {
      throw new Error('load_failed')
    })
    await renderEditor({ loadPolicy })
    testId('availability-error')
    testId('availability-reload')
  })
})
