import { describe, expect, it } from 'vitest'
import { canonicalRedirect } from '~/shared/lib/http/canonical-host'

/**
 * `builderhunt.dev` became the canonical host on 2026-08-09 and the old one still resolves and still
 * serves the identical app. These cover the decision itself rather than the env plumbing around it:
 * unit tests run in happy-dom, where `env.ts` returns its browser stub, so a test that read through
 * `env` would only ever exercise the unconfigured path.
 */
const DEV = 'https://builderhunt.dev'
const OLD = 'builderhunt.eduardoinerarte.dk'

describe('canonicalRedirect', () => {
  it('sends a retired host to the canonical one', () => {
    expect(canonicalRedirect(`https://${OLD}/`, { from: OLD, to: DEV })).toBe('https://builderhunt.dev/')
  })

  it('keeps the path, the query and the fragment', () => {
    expect(
      canonicalRedirect(`https://${OLD}/explore?q=rust&page=2#results`, { from: OLD, to: DEV }),
    ).toBe('https://builderhunt.dev/explore?q=rust&page=2#results')
  })

  it('leaves the canonical host alone', () => {
    expect(canonicalRedirect(`${DEV}/explore`, { from: OLD, to: DEV })).toBeNull()
  })

  it('does nothing when nothing is configured', () => {
    // Every developer machine and every CI job. The middleware has to be invisible there.
    expect(canonicalRedirect(`https://${OLD}/`, { from: undefined, to: DEV })).toBeNull()
    expect(canonicalRedirect(`https://${OLD}/`, { from: '   ', to: DEV })).toBeNull()
  })

  it('never redirects a host to itself, however it is written', () => {
    // The loop this design exists to make impossible. Configuring the canonical host as one to leave
    // is a mistake, not an instruction — and the comparison is case-insensitive so a capitalised
    // entry cannot slip past it.
    expect(canonicalRedirect(`${DEV}/`, { from: 'builderhunt.dev', to: DEV })).toBeNull()
    expect(canonicalRedirect(`${DEV}/`, { from: 'BuilderHunt.DEV', to: DEV })).toBeNull()
    expect(canonicalRedirect(`${DEV}/`, { from: `builderhunt.dev,${OLD}`, to: DEV })).toBeNull()
  })

  it('matches the incoming host case-insensitively', () => {
    expect(canonicalRedirect(`https://BuilderHunt.EduardoInerarte.dk/x`, { from: OLD, to: DEV }))
      .toBe('https://builderhunt.dev/x')
  })

  it('accepts a list, and tolerates the spacing a human would type', () => {
    const from = ` ${OLD} , www.${OLD} ,, `
    expect(canonicalRedirect(`https://www.${OLD}/pricing`, { from, to: DEV }))
      .toBe('https://builderhunt.dev/pricing')
    expect(canonicalRedirect('https://unrelated.example.com/pricing', { from, to: DEV })).toBeNull()
  })

  it('does not treat a port on the canonical origin as a different host', () => {
    // The E2E harness gives every spec an ephemeral port and sets APP_URL to match. Nothing there
    // configures a host to leave, but if anything ever did, the destination must keep the port.
    expect(canonicalRedirect('http://127.0.0.1:51983/x', { from: OLD, to: 'http://127.0.0.1:51983' }))
      .toBeNull()
    expect(canonicalRedirect(`https://${OLD}/x`, { from: OLD, to: 'http://127.0.0.1:51983' }))
      .toBe('http://127.0.0.1:51983/x')
  })
})
