/**
 * Pins the shape of the error the retry loop has to recognise, using the exact fields Postgres
 * produced in a real failing run.
 *
 * Worth its own test because the previous detector matched on the phrase "tuple concurrently
 * updated" in `error.message` — and the thrown error's message is drizzle's `"Failed query: ALTER
 * ROLE …"`, with the phrase nowhere in it. The detector returned false every time, the retry never
 * ran, and the module header's "defense-in-depth backstop" had never fired once. Nothing failed
 * visibly until enough parallel test files existed to lose the race.
 */
import { describe, expect, it } from 'vitest'
import { isConcurrentDdlConflict } from '~/shared/lib/db/create-disposable-test-database'

/** Reproduces what postgres.js threw, verbatim from the failing gate run. */
function realWorldError() {
  const error = new Error('Failed query: \n\nALTER ROLE builderhunt_owner NOLOGIN NOSUPERUSER\n')
  return Object.assign(error, {
    severity_local: 'ERROR',
    severity: 'ERROR',
    code: 'XX000',
    file: 'heapam.c',
    routine: 'simple_heap_update',
  })
}

describe('isConcurrentDdlConflict', () => {
  it('recognises the error the retry loop exists for', () => {
    expect(isConcurrentDdlConflict(realWorldError())).toBe(true)
  })

  it('recognises it through a wrapper', () => {
    expect(isConcurrentDdlConflict(new Error('outer', { cause: realWorldError() }))).toBe(true)
  })

  it('still recognises the message form', () => {
    expect(isConcurrentDdlConflict(new Error('tuple concurrently updated'))).toBe(true)
  })

  it('does not swallow an unrelated failure', () => {
    // XX000 alone is `internal_error` and far too broad — retrying a real bug eight times turns a
    // clear failure into a slow one.
    expect(isConcurrentDdlConflict(Object.assign(new Error('boom'), { code: 'XX000', routine: 'other' }))).toBe(false)
    expect(isConcurrentDdlConflict(Object.assign(new Error('nope'), { code: '42P01' }))).toBe(false)
    expect(isConcurrentDdlConflict(new Error('syntax error'))).toBe(false)
    expect(isConcurrentDdlConflict(null)).toBe(false)
  })

  it('terminates on a self-referencing cause chain', () => {
    const looping = new Error('loop') as Error & { cause?: unknown }
    looping.cause = looping
    expect(isConcurrentDdlConflict(looping)).toBe(false)
  })
})
