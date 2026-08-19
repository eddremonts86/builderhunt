/**
 * Duration is not profile (plan: phase-1/55, phase 1).
 *
 * `config.ts` states the contract as "the two-hour soak overrides `steadySeconds`; nothing else about the
 * contract changes between stages". Until 2026-08-16 the only mechanism that overrode it changed two other
 * things, and the consequence was not a slower report but a **wrong** one: `--seconds=7200` reported a
 * two-second ramp and dropped the offered-rate check entirely, so a certification could read `pass` without
 * having evaluated one of the spec's own success criteria.
 *
 * These assertions exist because the logic used to live inside the CLI guard, where nothing could reach it.
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_LOAD_CONFIG, SMOKE_LOAD_CONFIG } from '../../../../scripts/load/config'
import { resolveRunConfig } from '../../../../scripts/load/runner'

describe('resolveRunConfig', () => {
  it('changes only the steady window when asked only for a duration', () => {
    const config = resolveRunConfig(['--seconds=7200'])

    expect(config.stages.steadySeconds).toBe(7200)
    // The ramp is how a run avoids measuring a thundering herd. It used to collapse to 2.
    expect(config.stages.rampSeconds).toBe(DEFAULT_LOAD_CONFIG.stages.rampSeconds)
    expect(config.stages.rampSeconds).toBe(120)
    // 400–500 req/s is a success criterion. It used to be widened to {0, ∞} and silently pass.
    expect(config.thresholds.offeredRatePerSecond).toEqual(DEFAULT_LOAD_CONFIG.thresholds.offeredRatePerSecond)
    expect(config.users).toBe(DEFAULT_LOAD_CONFIG.users)
  })

  /**
   * The offered rate is derived as `users / (thinkTime + averageJitter)`, so a different user count really
   * does invalidate the window — 25 users cannot offer 400 req/s, and asserting they do is arithmetic, not
   * capacity.
   */
  it('still widens the offered-rate window when the user count changes', () => {
    const config = resolveRunConfig(['--users=25'])

    expect(config.users).toBe(25)
    expect(config.thresholds.offeredRatePerSecond).toEqual({ min: 0, max: Number.POSITIVE_INFINITY })
    // ...and nothing about the duration moves with it.
    expect(config.stages).toEqual(DEFAULT_LOAD_CONFIG.stages)
  })

  it('widens for the user count even when a duration is given too', () => {
    const config = resolveRunConfig(['--users=25', '--seconds=60'])

    expect(config.users).toBe(25)
    expect(config.stages.steadySeconds).toBe(60)
    expect(config.stages.rampSeconds).toBe(DEFAULT_LOAD_CONFIG.stages.rampSeconds)
    expect(config.thresholds.offeredRatePerSecond).toEqual({ min: 0, max: Number.POSITIVE_INFINITY })
  })

  /** Shortening the ramp is legitimate; doing it as an undocumented side effect of `--seconds` was not. */
  it('shortens the ramp only when asked', () => {
    expect(resolveRunConfig(['--ramp=2']).stages.rampSeconds).toBe(2)
    expect(resolveRunConfig(['--ramp=2', '--seconds=7200']).stages).toEqual({ rampSeconds: 2, steadySeconds: 7200 })
  })

  it('leaves the smoke profile exactly as config.ts defines it', () => {
    expect(resolveRunConfig(['--smoke'])).toEqual(SMOKE_LOAD_CONFIG)
  })

  /** `--baseline` and the default are the same configuration on purpose — see `configFromArgv`. */
  it('treats no flags and --baseline as the default profile', () => {
    expect(resolveRunConfig([])).toEqual(DEFAULT_LOAD_CONFIG)
    expect(resolveRunConfig(['--baseline'])).toEqual(DEFAULT_LOAD_CONFIG)
  })

  /** `--pooled` is a topology choice the runner reads separately; it must not touch the contract. */
  it('is unmoved by flags that are not about the contract', () => {
    expect(resolveRunConfig(['--pooled', '--manifest=/tmp/x.json'])).toEqual(DEFAULT_LOAD_CONFIG)
  })
})
