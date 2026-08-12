import { describe, expect, it } from 'vitest'
import { parseEnvironment } from '../../../../src/shared/lib/env'

/**
 * Plan 55 phase 2 — the pool-cap overrides, validated where they can actually stop a process.
 *
 * ## Why this tests `parseEnvironment` and not `env`
 *
 * Unit tests run in happy-dom, so `window` exists and `env.ts` resolves its *browser stub* — a handful
 * of placeholder values that have nothing to do with `process.env`. Asserting on the `env` export here
 * would be asserting on that stub, which is how a test can watch a validation rule it never reached.
 * `parseEnvironment` is the seam: same schema, explicit input.
 */

/** The minimum a production parse needs before it can fail for the reason under test. */
function productionEnv(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://app:secret@db.internal:5432/builderhunt',
    APP_URL: 'https://example.test',
    VITE_APP_URL: 'https://example.test',
    BETTER_AUTH_SECRET: 'a-secret-with-more-than-thirty-two-characters',
    ...over,
  }
}

describe('pool-cap overrides', () => {
  it('accepts an integer inside the range', () => {
    const parsed = parseEnvironment(productionEnv({ LOAD_POOL_MAX_RUNTIME: '24' }))
    expect(parsed.LOAD_POOL_MAX_RUNTIME).toBe('24')
  })

  it('refuses an unusable value in production, per role', () => {
    /**
     * The failure mode this closes.
     *
     * `postgres.js` reads a `NaN` max as *unbounded*, so the dangerous outcome of a typo is not an
     * error — it is an accepted value that removes the cap while the process looks configured. The
     * consequence lands hours later as `too many clients already` in an unrelated request, with nothing
     * in the logs pointing back at the environment. In production that has to stop startup.
     */
    for (const key of [
      'LOAD_POOL_MAX_RUNTIME',
      'LOAD_POOL_MAX_AUTH',
      'LOAD_POOL_MAX_WORKER',
      'LOAD_POOL_MAX_PLATFORM',
      'LOAD_POOL_MAX_CAPABILITY',
    ]) {
      for (const bad of ['abc', '0', '-4', '101', '2.5', 'Infinity', 'NaN']) {
        expect(() => parseEnvironment(productionEnv({ [key]: bad })), `${key}=${bad}`).toThrow()
      }
    }
  })

  it('names the offending variable in the message, not just "invalid env"', () => {
    // An operator reading a startup crash at 02:00 needs the variable, and the reason it was refused.
    let message = ''
    try {
      parseEnvironment(productionEnv({ LOAD_POOL_MAX_WORKER: 'twelve' }))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('LOAD_POOL_MAX_WORKER')
    expect(message).toContain('unbounded pool')
  })

  it('lets the same typo through outside production, where poolOptions warns instead', () => {
    /**
     * Deliberately asymmetric.
     *
     * A developer's typo should not stop them working, and `poolOptions` prints a warning and uses the
     * default — visible, not fatal. The production check above is what makes that local leniency safe:
     * without it, the lenient path would be the only path.
     */
    expect(() => parseEnvironment({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://app:secret@localhost:5432/builderhunt',
      APP_URL: 'http://localhost:3000',
      VITE_APP_URL: 'http://localhost:3000',
      BETTER_AUTH_SECRET: 'a-secret-with-more-than-thirty-two-characters',
      LOAD_POOL_MAX_RUNTIME: 'abc',
    })).not.toThrow()
  })

  it('treats an absent or empty override as absent', () => {
    expect(() => parseEnvironment(productionEnv({ LOAD_POOL_MAX_AUTH: '' }))).not.toThrow()
    expect(() => parseEnvironment(productionEnv())).not.toThrow()
  })
})
