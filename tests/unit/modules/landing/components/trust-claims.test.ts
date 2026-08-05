import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXPORT_FORMATS, EXPORT_SCOPE_DEFINITIONS } from '~/shared/lib/exports/capability-registry'
import { IMPLEMENTED_SEARCH_CONNECTORS } from '~/shared/lib/repositories/search-sources'
import { SOURCE_PRESENTATION } from '~/shared/lib/source-presentation'

/**
 * Regression guard for plans/phase-1/52-audit-trust: every one of these was a
 * real, live claim on the landing page that didn't match runtime behavior
 * (a fabricated JSON-LD rating, an invented user quote, unverifiable scale
 * numbers, a submit-less email form, and copy describing a user-suppliable
 * GitHub token that no UI anywhere lets a user supply). Source-level checks
 * so a future edit can't silently reintroduce any of them without a reviewer
 * noticing the failing test.
 */
const HOME_PAGE = readFileSync(
  join(process.cwd(), 'src/modules/landing/components/HomePage.tsx'),
  'utf8',
)
const FAQ_SECTION = readFileSync(
  join(process.cwd(), 'src/modules/landing/components/FAQSection.tsx'),
  'utf8',
)
const ROOT_ROUTE = readFileSync(join(process.cwd(), 'src/routes/__root.tsx'), 'utf8')

describe('landing page never republishes unsupported trust claims', () => {
  it('root JSON-LD has no aggregateRating (no review corpus exists to back one)', () => {
    expect(ROOT_ROUTE).not.toContain('aggregateRating')
  })

  it('HomePage has no fabricated testimonial or star rating', () => {
    expect(HOME_PAGE).not.toMatch(/paid for itself/i)
    expect(HOME_PAGE).not.toMatch(/beta user/i)
    expect(HOME_PAGE).not.toMatch(/5 out of 5 stars/i)
  })

  it('HomePage has no dead email-capture form', () => {
    expect(HOME_PAGE).not.toMatch(/join alerts/i)
    expect(HOME_PAGE).not.toMatch(/newsletter email input/i)
  })

  it('HomePage has no unverifiable scale numbers for source platforms', () => {
    expect(HOME_PAGE).not.toMatch(/\d+M\+/)
    expect(HOME_PAGE).not.toMatch(/\d+K\+ dev/i)
    expect(HOME_PAGE).not.toMatch(/\+128 stars/)
  })

  it('HomePage and FAQSection never describe a user-suppliable GitHub token', () => {
    for (const source of [HOME_PAGE, FAQ_SECTION]) {
      expect(source).not.toMatch(/personal access token/i)
      expect(source).not.toMatch(/add a github token/i)
    }
  })
})

/**
 * plans/UI/tasks.md Wave 6 "Build a scoped Export Center and reconcile public claims" — every
 * export capability claimed in public copy (Home, FAQ, the `SoftwareApplication` JSON-LD below)
 * must name only a scope/format pair `~/shared/lib/exports/capability-registry.ts` actually
 * implements. Reads the real source files rather than a hand-copied snapshot of their strings, so
 * it fails the moment a future edit adds a promise the Export Center doesn't back, or removes a
 * capability the copy still advertises.
 */
const KNOWN_SCOPE_NOUNS = Object.values(EXPORT_SCOPE_DEFINITIONS).map((d) => d.label.toLowerCase())
const KNOWN_FORMAT_NOUNS = EXPORT_FORMATS.map((f) => f.toUpperCase())

// Superset of `KNOWN_SCOPE_NOUNS`, deliberately including scopes the product does NOT implement
// (e.g. "team-wide export") so the checker can flag them if copy ever claims one. Matching this
// pattern and NOT being in `KNOWN_SCOPE_NOUNS` is what "exceeds the capability registry" means.
const SCOPE_CLAIM_PATTERN = /\b(all tracked builders|shortlists?|saved searches?|note collections?|team-wide exports?|organization exports?|account-wide exports?)\b/gi
const FORMAT_CLAIM_PATTERN = /\b(CSV|JSON|XML|XLSX|PDF)\b/g

function singularize(noun: string): string {
  return noun.endsWith('s') && !noun.endsWith('ss') ? noun.slice(0, -1) : noun
}

/** Returns every scope/format noun `copy` claims that isn't backed by the registry — empty when
 * every claim is honest. */
function unbackedExportClaims(copy: string): { scopes: string[]; formats: string[] } {
  const claimedScopes = [...copy.matchAll(SCOPE_CLAIM_PATTERN)].map((m) => m[0].toLowerCase())
  const unbackedScopes = claimedScopes.filter((claim) => {
    const singular = singularize(claim)
    return !KNOWN_SCOPE_NOUNS.some((known) => known === claim || known === singular || singularize(known) === singular)
  })

  const claimedFormats = [...copy.matchAll(FORMAT_CLAIM_PATTERN)].map((m) => m[0].toUpperCase())
  const unbackedFormats = claimedFormats.filter((claim) => !KNOWN_FORMAT_NOUNS.includes(claim))

  return { scopes: [...new Set(unbackedScopes)], formats: [...new Set(unbackedFormats)] }
}

describe('export capability claims — copy vs. the capability registry', () => {
  it('the checker itself fails on a fabricated claim naming an unimplemented scope (proves it has teeth)', () => {
    const fabricated = 'Export any team-wide export or organization export to CSV, JSON, or XLSX.'
    const result = unbackedExportClaims(fabricated)
    expect(result.scopes).toEqual(expect.arrayContaining(['team-wide export', 'organization export']))
    expect(result.formats).toEqual(expect.arrayContaining(['XLSX']))
  })

  it('the checker passes for copy that only names implemented scopes and formats', () => {
    const honest = 'Export your shortlist or a saved search to CSV or JSON.'
    const result = unbackedExportClaims(honest)
    expect(result.scopes).toEqual([])
    expect(result.formats).toEqual([])
  })

  it("FAQSection's export answer never claims a scope or format beyond the registry", () => {
    const match = FAQ_SECTION.match(/a:\s*'([^']*export[^']*)'/i)
    expect(match, 'expected to find the export FAQ answer').not.toBeNull()
    const result = unbackedExportClaims(match![1])
    expect(result.scopes, `unbacked scopes in FAQ copy: ${result.scopes.join(', ')}`).toEqual([])
    expect(result.formats, `unbacked formats in FAQ copy: ${result.formats.join(', ')}`).toEqual([])
  })

  it('HomePage never claims an export scope or format beyond the registry', () => {
    const result = unbackedExportClaims(HOME_PAGE)
    expect(result.scopes, `unbacked scopes in HomePage copy: ${result.scopes.join(', ')}`).toEqual([])
    expect(result.formats, `unbacked formats in HomePage copy: ${result.formats.join(', ')}`).toEqual([])
  })

  it("__root.tsx's SoftwareApplication JSON-LD featureList never claims a scope or format beyond the registry", () => {
    const featureListMatch = ROOT_ROUTE.match(/featureList:\s*\[([\s\S]*?)\]/)
    expect(featureListMatch, 'expected to find the featureList array').not.toBeNull()
    const result = unbackedExportClaims(featureListMatch![1])
    expect(result.scopes, `unbacked scopes in JSON-LD: ${result.scopes.join(', ')}`).toEqual([])
    expect(result.formats, `unbacked formats in JSON-LD: ${result.formats.join(', ')}`).toEqual([])
  })

  /**
   * The same JSON-LD names the sources by hand, and that list went stale without
   * anything failing: it advertised SourceHut and Hashnode until 2026-08-05,
   * after both connectors had been retired (`drizzle/0143`, `drizzle/0144`) and
   * removed from `IMPLEMENTED_SEARCH_CONNECTORS`. Structured data is read by
   * search engines and AI crawlers, so a retired source stays a live public
   * claim there long after the product stops honouring it.
   *
   * The check runs in both directions on purpose. Missing a source is a small
   * marketing loss; claiming one that does not exist is the failure that
   * matters, and only the "extra" direction catches a retirement.
   */
  it("the JSON-LD's source list is exactly the implemented connectors — both directions", () => {
    const featureListMatch = ROOT_ROUTE.match(/featureList:\s*\[([\s\S]*?)\]/)
    expect(featureListMatch, 'expected to find the featureList array').not.toBeNull()

    const discovery = featureListMatch![1].match(/Multi-source builder discovery \(([^)]*)\)/)
    expect(discovery, "expected the 'Multi-source builder discovery (...)' entry").not.toBeNull()
    const claimed = new Set(discovery![1].split(',').map((s) => s.trim()).filter(Boolean))

    const expected = new Set(
      IMPLEMENTED_SEARCH_CONNECTORS.map((key) => SOURCE_PRESENTATION[key].label),
    )

    const extra = [...claimed].filter((label) => !expected.has(label))
    const missing = [...expected].filter((label) => !claimed.has(label))

    expect(
      extra,
      `the JSON-LD advertises source(s) with no implemented connector: ${extra.join(', ')}. `
      + 'A retired source must be removed from this list in the same change that retires it.',
    ).toEqual([])
    expect(
      missing,
      `implemented connector(s) missing from the JSON-LD source list: ${missing.join(', ')}`,
    ).toEqual([])
  })
})
