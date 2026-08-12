import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Plan 59, task 13 — the onboarding `q` prefill.
 *
 * Asserted against the route source rather than by rendering: `validateSearch` is TanStack route
 * configuration, and the properties worth pinning are structural — that the value is bounded, that it
 * is only ever an initial state, and that nothing persists it. A render test would prove the input
 * shows the string and prove none of that.
 */
const SOURCE = readFileSync(join(process.cwd(), 'src', 'routes', 'onboarding', 'search.tsx'), 'utf8')

describe('the onboarding search prefill', () => {
  it('validates the search parameter instead of reading it raw', () => {
    expect(SOURCE).toMatch(/validateSearch:/)
    expect(SOURCE).toMatch(/normalizePrefill/)
  })

  it('trims and caps the value', () => {
    // It lands in an input whose value ends up in a URL, so an unbounded string here is a way to make
    // that URL arbitrarily long.
    expect(SOURCE).toMatch(/MAX_PREFILL_LENGTH = 300/)
    expect(SOURCE).toMatch(/\.trim\(\)\.slice\(0, MAX_PREFILL_LENGTH\)/)
  })

  it('rejects a non-string without throwing', () => {
    // A hand-edited URL can produce `q=[]` or repeat the key. Returning '' is the answer; a route that
    // throws on a malformed search param is a route a stranger can 500 with a link.
    expect(SOURCE).toMatch(/if \(typeof value !== 'string'\) return ''/)
  })

  it('keeps q optional so other navigations into this route still compile', () => {
    // `onboarding/save.tsx` links here with no query to suggest. A required param made that a type
    // error, which is how this was caught.
    expect(SOURCE).toMatch(/\{ q\?: string \}/)
    expect(SOURCE).toMatch(/return q \? \{ q \} : \{\}/)
  })

  it('uses the value as initial state only, never as a controlled value', () => {
    // `useState`'s initializer runs once, so a later navigation that changes `q` does not overwrite what
    // the visitor has typed — the difference between a suggestion and a field that fights them.
    expect(SOURCE).toMatch(/React\.useState\(q \?\? ''\)/)
    // No effect syncing the param back into state, which is what would turn it into a controlled value.
    expect(SOURCE).not.toMatch(/useEffect\([^)]*setQuery\(q/)
  })

  it('persists nothing on arrival', () => {
    // The prefill is editable text, not authorization and not a saved preference. Nothing is written
    // until the visitor runs the search themselves, so a tampered value costs a stranger a prefilled box.
    const beforeFirstHandler = SOURCE.slice(0, SOURCE.indexOf('function SearchStep'))
    expect(beforeFirstHandler).not.toMatch(/fetch\(/)
  })
})
