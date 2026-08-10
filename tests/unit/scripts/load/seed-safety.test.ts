import { describe, expect, it } from 'vitest'
import {
  assertDisposableLoadTarget,
  DISPOSABLE_DATABASE_PREFIX,
  LoadSafetyError,
  loadRunId,
  PRODUCTION_MARKERS,
  remoteAllowedFromEnv,
} from '../../../../scripts/load/safety'

/**
 * Plan 55 phase 0 — the refusals.
 *
 * `seed.ts` writes a thousand users and `cleanup.ts` deletes rows. Both take a connection string from the
 * environment and both get run by hand on a laptop whose `.env` holds production credentials for other
 * reasons. These tests are the reason to believe that cannot end badly, and they are string tests on
 * purpose: proving the guard by pointing it at a real production database is not an option.
 */
const DISPOSABLE = `postgresql://postgres:pw@127.0.0.1:5432/${DISPOSABLE_DATABASE_PREFIX}_run1`

describe('assertDisposableLoadTarget', () => {
  it('accepts a loopback disposable database', () => {
    const target = assertDisposableLoadTarget(DISPOSABLE)
    expect(target.databaseName).toBe(`${DISPOSABLE_DATABASE_PREFIX}_run1`)
    expect(target.host).toBe('127.0.0.1')
  })

  it('accepts every loopback spelling', () => {
    // `localhost` resolves to `::1` on macOS and `127.0.0.1` elsewhere, and both appear in real configs.
    // Accepting only one of the three is how this refuses a legitimate run on somebody's machine.
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const url = `postgresql://postgres:pw@${host}:5432/${DISPOSABLE_DATABASE_PREFIX}_x`
      expect(() => assertDisposableLoadTarget(url)).not.toThrow()
    }
  })

  describe('the name-prefix check', () => {
    it('refuses the right host with the wrong database', () => {
      // The likeliest mistake by a wide margin: `DATABASE_URL` on a developer machine is the dev database,
      // and running the seeder with it would put a thousand fixture users in the app somebody is using.
      expect(() => assertDisposableLoadTarget('postgresql://postgres:pw@127.0.0.1:5432/builderhunt'))
        .toThrow(LoadSafetyError)
      expect(() => assertDisposableLoadTarget('postgresql://postgres:pw@127.0.0.1:5432/builderhunt'))
        .toThrow(/is not disposable/)
    })

    it('refuses a URL that names no database at all', () => {
      expect(() => assertDisposableLoadTarget('postgresql://postgres:pw@127.0.0.1:5432/'))
        .toThrow(/names no database/)
    })

    it('applies even with the remote flag set', () => {
      // The flag is for the certification host, not for production.
      expect(() => assertDisposableLoadTarget(
        'postgresql://postgres:pw@10.0.0.4:5432/builderhunt',
        { allowRemote: true },
      )).toThrow(/is not disposable/)
    })
  })

  describe('the loopback rule', () => {
    it('refuses a remote host by default', () => {
      // How a staging cluster acquires a thousand fixture users: the right database name on the wrong host.
      expect(() => assertDisposableLoadTarget(`postgresql://postgres:pw@10.0.0.4:5432/${DISPOSABLE_DATABASE_PREFIX}_x`))
        .toThrow(/is not loopback/)
    })

    it('allows a remote host only with the explicit flag', () => {
      // The certification host is remote by definition, so there has to be a way — and it has to be
      // deliberate rather than inherited.
      expect(() => assertDisposableLoadTarget(
        `postgresql://postgres:pw@10.0.0.4:5432/${DISPOSABLE_DATABASE_PREFIX}_x`,
        { allowRemote: true },
      )).not.toThrow()
    })
  })

  describe('the production-marker scan', () => {
    it('refuses a marker anywhere in the URL, not just the host', () => {
      // The case a host-only check misses entirely: the marker is in the *user*.
      expect(() => assertDisposableLoadTarget(
        `postgresql://builderhunt_prod:pw@127.0.0.1:5432/${DISPOSABLE_DATABASE_PREFIX}_x`,
      )).toThrow(/reads as a production target/)
    })

    it('refuses every marker in the list', () => {
      for (const marker of PRODUCTION_MARKERS) {
        const url = `postgresql://postgres:pw@${marker}.internal:5432/${DISPOSABLE_DATABASE_PREFIX}_x`
        expect(() => assertDisposableLoadTarget(url, { allowRemote: true }), marker).toThrow(/production target/)
      }
    })

    it('is case-insensitive', () => {
      expect(() => assertDisposableLoadTarget(
        `postgresql://postgres:pw@DB-PROD.internal:5432/${DISPOSABLE_DATABASE_PREFIX}_x`,
        { allowRemote: true },
      )).toThrow(/production target/)
    })

    it('fires even with the remote flag set', () => {
      // A guard that one environment variable fully disables is not a guard.
      expect(() => assertDisposableLoadTarget(
        `postgresql://postgres:pw@prod-db.internal:5432/${DISPOSABLE_DATABASE_PREFIX}_x`,
        { allowRemote: true },
      )).toThrow(/production target/)
    })
  })

  it('never echoes the URL in an error, because it carries a password', () => {
    const withSecret = 'postgresql://postgres:sup3r-s3cret@127.0.0.1:5432/builderhunt'
    try {
      assertDisposableLoadTarget(withSecret)
      throw new Error('should have refused')
    } catch (error) {
      expect((error as Error).message).not.toContain('sup3r-s3cret')
    }
  })

  it('refuses an unparseable URL without echoing it', () => {
    try {
      assertDisposableLoadTarget('not a url at all :sup3r-s3cret')
      throw new Error('should have refused')
    } catch (error) {
      expect((error as Error).message).toContain('could not be parsed')
      expect((error as Error).message).not.toContain('sup3r-s3cret')
    }
  })

  it('refuses a missing URL rather than defaulting to anything', () => {
    expect(() => assertDisposableLoadTarget(undefined)).toThrow(/no database URL/)
  })
})

describe('remoteAllowedFromEnv', () => {
  it('accepts only the exact string', () => {
    // `1`, `yes` and `TRUE` are somebody guessing at a flag, not somebody authorizing a remote write.
    expect(remoteAllowedFromEnv({ LOAD_DISPOSABLE_DATABASE: 'true' })).toBe(true)
    for (const value of ['1', 'yes', 'TRUE', 'True', '', undefined]) {
      expect(remoteAllowedFromEnv({ LOAD_DISPOSABLE_DATABASE: value })).toBe(false)
    }
  })
})

describe('loadRunId', () => {
  it('is deterministic for a given instant and suffix', () => {
    const at = new Date('2026-08-11T09:30:00.000Z')
    expect(loadRunId(at, 'baseline')).toBe('load-20260811093000-baseline')
  })

  it('refuses a suffix that could break a LIKE or a filename', () => {
    for (const bad of ['', 'Has Caps', 'with space', 'semi;colon', 'a'.repeat(17), '%wild']) {
      expect(() => loadRunId(new Date('2026-08-11T09:30:00.000Z'), bad), bad).toThrow(LoadSafetyError)
    }
  })

  it('is what cleanup scopes on, rather than emptying the table', () => {
    /**
     * Two operators, one disposable host.
     *
     * A cleanup that deleted every fixture row would remove the other run's data while it was still under
     * load — and the report would blame the resulting errors on capacity. Scoping by run id is what makes
     * a shared disposable database safe to share.
     */
    const a = loadRunId(new Date('2026-08-11T09:30:00.000Z'), 'baseline')
    const b = loadRunId(new Date('2026-08-11T09:31:00.000Z'), 'calibration')
    expect(a).not.toBe(b)
  })
})
