import { describe, expect, it } from 'vitest'
import { DEFAULT_LOAD_CONFIG, SMOKE_LOAD_CONFIG } from '../../../../scripts/load/config'
import { configFromFlags } from '../../../../scripts/load/runner'

/**
 * The certification's own flag, and what it used to quietly do.
 *
 * `--seconds` is the only way to ask for anything other than 600 steady seconds, so the two-hour soak
 * has to pass it. Until 2026-08-14 it also collapsed `rampSeconds` to `min(ramp, 2)` and widened
 * `offeredRatePerSecond` to `{0, ∞}` — the same treatment `--users` gets. So `--seconds=7200` would
 * have produced a two-second ramp instead of the spec's two minutes, and a report that never evaluated
 * the 400–500 req/s success criterion while still printing `pass`.
 *
 * The widening is correct for `--users` and wrong for `--seconds`, because the offered rate is derived
 * as `users / (thinkTime + averageJitter)`: changing the user count invalidates the declared window,
 * changing the duration does not.
 */
describe('configFromFlags', () => {
  const window = DEFAULT_LOAD_CONFIG.thresholds.offeredRatePerSecond

  it('--seconds sets only the steady duration', () => {
    const config = configFromFlags(DEFAULT_LOAD_CONFIG, ['--seconds=7200'])

    expect(config.stages.steadySeconds).toBe(7200)
    // The regression this file exists for: both of these were collateral damage.
    expect(config.stages.rampSeconds).toBe(DEFAULT_LOAD_CONFIG.stages.rampSeconds)
    expect(config.stages.rampSeconds).toBe(120)
    expect(config.thresholds.offeredRatePerSecond).toEqual(window)
    expect(config.thresholds.offeredRatePerSecond.max).toBeLessThan(Number.POSITIVE_INFINITY)
  })

  it('--users still widens the offered-rate window, because it invalidates it', () => {
    const config = configFromFlags(DEFAULT_LOAD_CONFIG, ['--users=25'])

    expect(config.users).toBe(25)
    expect(config.thresholds.offeredRatePerSecond).toEqual({ min: 0, max: Number.POSITIVE_INFINITY })
  })

  it('--users and --seconds together widen it once and keep the configured ramp', () => {
    const config = configFromFlags(DEFAULT_LOAD_CONFIG, ['--users=25', '--seconds=30'])

    expect(config.users).toBe(25)
    expect(config.stages).toEqual({ rampSeconds: 120, steadySeconds: 30 })
    expect(config.thresholds.offeredRatePerSecond).toEqual({ min: 0, max: Number.POSITIVE_INFINITY })
  })

  it('--ramp is how a short run skips the ramp, deliberately and on its own', () => {
    const config = configFromFlags(DEFAULT_LOAD_CONFIG, ['--seconds=30', '--ramp=2'])

    expect(config.stages).toEqual({ rampSeconds: 2, steadySeconds: 30 })
    // Still not a licence to drop the threshold: only `--users` does that.
    expect(config.thresholds.offeredRatePerSecond).toEqual(window)
  })

  it('no flags changes nothing', () => {
    expect(configFromFlags(DEFAULT_LOAD_CONFIG, [])).toEqual(DEFAULT_LOAD_CONFIG)
  })

  it('the smoke profile is untouched by this path', () => {
    expect(configFromFlags(SMOKE_LOAD_CONFIG, [])).toEqual(SMOKE_LOAD_CONFIG)
    expect(SMOKE_LOAD_CONFIG.stages).toEqual({ rampSeconds: 5, steadySeconds: 30 })
  })
})
