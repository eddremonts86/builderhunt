/**
 * Wave 1 Task 2 — fixed-time clock for deterministic fixtures.
 *
 * Clock-sensitive states (trial windows, billing periods, grace periods,
 * invitation expiry, …) must never depend on the wall clock of whichever
 * machine happens to run the suite. `E2E_FIXED_TIME` (see
 * `e2e/harness/env.ts`) plus fixture-seeded timestamps define every
 * clock-sensitive state; fixtures derive all timestamps from this clock
 * so the same run always produces identical rows.
 *
 * The design spec allows the smallest injectable production clock seam
 * when a product path needs one — introduced test-first by the task that
 * needs it. This module deliberately owns only the harness side: parsing,
 * arithmetic, and (for browser tests) `page.clock.setFixedTime`.
 */
import type { Page } from 'playwright/test'

/** Stable default so a bare run is deterministic without any exports. */
export const DEFAULT_E2E_FIXED_TIME = '2026-07-24T09:00:00.000Z'

export interface ClockOffset {
  days?: number
  hours?: number
  minutes?: number
  seconds?: number
}

export interface FixedClock {
  /** Canonical ISO-8601 representation of the fixed instant. */
  readonly iso: string
  /** A fresh Date at the fixed instant — never advances between calls. */
  now(): Date
  plus(offset: ClockOffset): Date
  minus(offset: ClockOffset): Date
}

function offsetMs(offset: ClockOffset): number {
  return (
    (offset.days ?? 0) * 24 * 60 * 60 * 1000 +
    (offset.hours ?? 0) * 60 * 60 * 1000 +
    (offset.minutes ?? 0) * 60 * 1000 +
    (offset.seconds ?? 0) * 1000
  )
}

export function fixedClock(iso: string = DEFAULT_E2E_FIXED_TIME): FixedClock {
  const epochMs = Date.parse(iso)
  if (Number.isNaN(epochMs)) {
    throw new Error(`E2E fixed time ${JSON.stringify(iso)} is not a valid ISO-8601 timestamp`)
  }
  return {
    iso: new Date(epochMs).toISOString(),
    now(): Date {
      return new Date(epochMs)
    },
    plus(offset: ClockOffset): Date {
      return new Date(epochMs + offsetMs(offset))
    },
    minus(offset: ClockOffset): Date {
      return new Date(epochMs - offsetMs(offset))
    },
  }
}

/**
 * Guarantee `E2E_FIXED_TIME` is present (and valid) in this process BEFORE
 * any fixture or app-server spawn reads it. Idempotent — an explicitly
 * exported value always wins.
 */
export function ensureFixedTimeEnv(): string {
  const current = process.env.E2E_FIXED_TIME
  if (current) {
    fixedClock(current) // validate, throw early on garbage
    return current
  }
  process.env.E2E_FIXED_TIME = DEFAULT_E2E_FIXED_TIME
  return DEFAULT_E2E_FIXED_TIME
}

export function fixedClockFromEnv(): FixedClock {
  return fixedClock(process.env.E2E_FIXED_TIME ?? DEFAULT_E2E_FIXED_TIME)
}

/**
 * Pin the browser's clock to the fixture clock so client-rendered relative
 * dates ("expires in 14 days") agree with fixture-seeded timestamps.
 */
export async function installFixedBrowserClock(page: Page, clock: FixedClock = fixedClockFromEnv()): Promise<void> {
  await page.clock.setFixedTime(clock.now())
}
