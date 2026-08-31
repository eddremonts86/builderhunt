/**
 * `requestNow` is a production clock seam, so what these tests pin is mostly what it *refuses* to do.
 *
 * The reason it exists (a visual baseline that decayed by the wall clock) is in the module itself,
 * along with why `NODE_ENV` is deliberately not one of its conditions — Vite folds that variable into
 * the bundle at build time, and a first version that read it was silently inert in CI. The test
 * below pins that: `E2E_MODE` is the whole gate, and no other variable may quietly turn it off.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requestNow } from '~/shared/lib/clock'

const FIXED = '2026-07-24T09:00:00.000Z'

describe('requestNow', () => {
  let saved: { e2e?: string; fixed?: string; nodeEnv?: string }

  beforeEach(() => {
    saved = {
      e2e: process.env.E2E_MODE,
      fixed: process.env.E2E_FIXED_TIME,
      nodeEnv: process.env.NODE_ENV,
    }
  })

  afterEach(() => {
    restore('E2E_MODE', saved.e2e)
    restore('E2E_FIXED_TIME', saved.fixed)
    restore('NODE_ENV', saved.nodeEnv)
  })

  function restore(key: string, value: string | undefined) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  it('returns the fixed instant when the harness asks for it', () => {
    process.env.NODE_ENV = 'test'
    process.env.E2E_MODE = 'true'
    process.env.E2E_FIXED_TIME = FIXED
    expect(requestNow().toISOString()).toBe(FIXED)
  })

  it('returns the real clock when E2E_MODE is not set', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.E2E_MODE
    process.env.E2E_FIXED_TIME = FIXED
    expect(requestNow().toISOString()).not.toBe(FIXED)
    expect(Math.abs(requestNow().getTime() - Date.now())).toBeLessThan(5_000)
  })

  /**
   * The inverse of what this test used to assert, and the change is the finding.
   *
   * `NODE_ENV` was a second condition until the CI build proved it could not be one: Vite
   * constant-folds `process.env.NODE_ENV`, so the term read the build rather than the process and
   * short-circuited the seam wherever the bundle was built as production. `E2E_MODE` is now the
   * whole gate, exactly as it is for every other seam in this repository.
   */
  it('is gated on E2E_MODE alone — NODE_ENV cannot turn it off, because a bundler folds it', () => {
    process.env.NODE_ENV = 'production'
    process.env.E2E_MODE = 'true'
    process.env.E2E_FIXED_TIME = FIXED
    expect(requestNow().toISOString()).toBe(FIXED)
  })

  it('needs E2E_MODE exactly, not merely set', () => {
    process.env.NODE_ENV = 'test'
    process.env.E2E_MODE = '1'
    process.env.E2E_FIXED_TIME = FIXED
    expect(Math.abs(requestNow().getTime() - Date.now())).toBeLessThan(5_000)
  })

  it('falls back to the real clock on an unparseable fixed time rather than throwing', () => {
    process.env.NODE_ENV = 'test'
    process.env.E2E_MODE = 'true'
    process.env.E2E_FIXED_TIME = 'yesterday afternoon'
    expect(() => requestNow()).not.toThrow()
    expect(Math.abs(requestNow().getTime() - Date.now())).toBeLessThan(5_000)
  })

  it('falls back to the real clock when the harness set E2E_MODE but no fixed time', () => {
    process.env.NODE_ENV = 'test'
    process.env.E2E_MODE = 'true'
    delete process.env.E2E_FIXED_TIME
    expect(Math.abs(requestNow().getTime() - Date.now())).toBeLessThan(5_000)
  })
})
