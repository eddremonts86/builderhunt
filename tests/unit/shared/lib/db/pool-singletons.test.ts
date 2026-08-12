import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { platformDb as platformFromClient } from '../../../../../src/shared/lib/db/client'
import { platformDb as platformFromPlatformDb } from '../../../../../src/shared/lib/db/platform-db'

/**
 * Plan 55 phase 2 — one pool per role, whichever import path you take.
 *
 * ## The duplication this exists to prevent
 *
 * `db/platform-db.ts` used to call `postgres()` at module scope while `db/client.ts` exported a lazy
 * `platformDb` built from the same URL. Two import paths, two pools, one database role. Nothing broke:
 * both were correct, both worked, and the process silently held twice the platform connections that
 * anybody counting from the source would expect.
 *
 * That is precisely the kind of discrepancy that surfaces during an incident, as a number in
 * `pg_stat_activity` nobody can account for — and it is invisible to type checking, to lint, and to
 * every functional test, because two working pools behave exactly like one.
 *
 * Object identity is the only assertion that catches it. A test that checked "both export a database"
 * would have passed the whole time the bug existed.
 */
describe('platform pool', () => {
  it('is the same object through both import paths', () => {
    expect(platformFromPlatformDb).toBe(platformFromClient)
  })

  it('constructs no client of its own, checked against the source', () => {
    /**
     * A source assertion, because the behavioural one would prove nothing.
     *
     * Two working pools behave exactly like one, so no runtime observation distinguishes them — object
     * identity above catches a *shared* pool, and this catches the thing that created the second one: a
     * `postgres()` call at module scope in a file whose job is to name a role.
     *
     * That call was also a client-bundle hazard. Constructing at module scope means importing the file
     * opens a connection, and this import chain reaches the browser through TanStack's generated route
     * tree — the `ReferenceError: Buffer is not defined` hydration failure `db/client.ts` documents at
     * length. The lazy proxy there exists to make the import safe; a second eager client alongside it
     * put the hazard straight back.
     *
     * An earlier version of this test asserted `typeof platformDb === 'object'` and that it was defined,
     * which is true of literally any export and would have passed throughout the bug's lifetime.
     */
    const source = readFileSync(
      join(process.cwd(), 'src/shared/lib/db/platform-db.ts'),
      'utf8',
    )
    // Comments in that file discuss the call it used to make, so the check is about code.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/postgres\s*\(/)
    expect(code).not.toMatch(/poolOptions\s*\(/)
    expect(code).toMatch(/export \{ platformDb \} from '\.\/client'/)
  })
})
