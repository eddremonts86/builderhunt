/**
 * Wave 1 Task 4 — E2E email outbox unit tests (RED first, per the corrected
 * brief docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md §Step 1).
 *
 * The outbox is the in-process capture target every sender in
 * `src/shared/lib/email.ts` routes through when `E2E_MODE === 'true'`. It
 * must never touch `fetch`, and its dispatcher must be unreachable outside
 * E2E mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installOutbox,
  readOutbox,
  recordOutbox,
  resetOutbox,
  type OutboxEntry,
} from './outbox'
import { dispatchEmail } from '../email'

type OutboxGlobal = typeof globalThis & { __emailOutbox?: OutboxEntry[] }

beforeEach(() => {
  vi.stubEnv('E2E_MODE', 'true')
  resetOutbox()
})

afterEach(() => {
  resetOutbox()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('installOutbox', () => {
  it('returns the same singleton array on a second call', () => {
    const first = installOutbox()
    const second = installOutbox()
    expect(second).toBe(first)
  })

  it('exposes the singleton on globalThis.__emailOutbox', () => {
    const outbox = installOutbox()
    expect((globalThis as OutboxGlobal).__emailOutbox).toBe(outbox)
  })
})

describe('recordOutbox', () => {
  it('increments the counter and stores the entry on globalThis.__emailOutbox', () => {
    const first = recordOutbox({ to: 'a@example.com', subject: 'One', html: '<p>1</p>' })
    const second = recordOutbox({ to: 'b@example.com', subject: 'Two', html: '<p>2</p>' })

    expect(first).toBe(1)
    expect(second).toBe(2)

    const entries = (globalThis as OutboxGlobal).__emailOutbox
    expect(entries).toHaveLength(2)
    expect(entries?.[0]).toMatchObject({ to: 'a@example.com', subject: 'One', html: '<p>1</p>' })
    expect(entries?.[1]).toMatchObject({ to: 'b@example.com', subject: 'Two', html: '<p>2</p>' })
    expect(typeof entries?.[0].sentAt).toBe('string')
    expect(Number.isNaN(Date.parse(entries![0].sentAt))).toBe(false)
  })

  it('stores the optional scenario field verbatim', () => {
    recordOutbox({ to: 'a@example.com', subject: 'S', html: '<p></p>', scenario: 'sca_required' })
    expect(readOutbox()[0].scenario).toBe('sca_required')
  })
})

describe('resetOutbox', () => {
  it('empties the array and restarts the counter', () => {
    recordOutbox({ to: 'a@example.com', subject: 'One', html: '<p>1</p>' })
    resetOutbox()
    expect(readOutbox()).toHaveLength(0)
    expect(recordOutbox({ to: 'b@example.com', subject: 'Two', html: '<p>2</p>' })).toBe(1)
  })

  it('keeps the same globalThis array instance so held references stay valid', () => {
    const outbox = installOutbox()
    recordOutbox({ to: 'a@example.com', subject: 'One', html: '<p>1</p>' })
    resetOutbox()
    expect((globalThis as OutboxGlobal).__emailOutbox).toBe(outbox)
    expect(outbox).toHaveLength(0)
  })
})

describe('dispatchEmail', () => {
  it('returns { ok: true, id: "outbox:<n>" } and never calls fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const result = await dispatchEmail({ to: 'a@example.com', subject: 'Hi', html: '<p>hi</p>' })

    expect(result).toMatchObject({ ok: true, id: 'outbox:1' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(readOutbox()).toHaveLength(1)
  })

  it('passes devLink through so E2E UI flows keep working', async () => {
    const result = await dispatchEmail({
      to: 'a@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
      devLink: 'http://localhost:3000/claim/tok',
    })
    expect(result.devLink).toBe('http://localhost:3000/claim/tok')
  })

  it('is unreachable when E2E_MODE !== "true"', async () => {
    vi.stubEnv('E2E_MODE', 'false')
    await expect(dispatchEmail({ to: 'a@example.com', subject: 'Hi', html: '<p>hi</p>' })).rejects.toThrow(/E2E/)
    expect(readOutbox()).toHaveLength(0)
  })

  it('is unreachable when E2E_MODE is unset', async () => {
    vi.stubEnv('E2E_MODE', '')
    await expect(dispatchEmail({ to: 'a@example.com', subject: 'Hi', html: '<p>hi</p>' })).rejects.toThrow(/E2E/)
  })
})
