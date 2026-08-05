import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listActiveSubscriptionCatalog } from '~/shared/lib/billing/catalog'
import { EXPORT_FORMATS, EXPORT_SCOPE_DEFINITIONS } from '~/shared/lib/exports/capability-registry'
import { IMPLEMENTED_SEARCH_CONNECTORS, SEARCH_SOURCE_COUNT } from '~/shared/lib/search-connectors'
import { SOURCE_PRESENTATION } from '~/shared/lib/source-presentation'

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

/**
 * Regression guard for plans/phase-1/52-audit-trust: every one of these was a
 * real, live claim on the landing page that didn't match runtime behavior
 * (a fabricated JSON-LD rating, an invented user quote, unverifiable scale
 * numbers, a submit-less email form, and copy describing a user-suppliable
 * GitHub token that no UI anywhere lets a user supply). Source-level checks
 * so a future edit can't silently reintroduce any of them without a reviewer
 * noticing the failing test.
 */
const HOME_PAGE = read('src/modules/landing/components/HomePage.tsx')
const FAQ_SECTION = read('src/modules/landing/components/FAQSection.tsx')
const ROOT_ROUTE = read('src/routes/__root.tsx')

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

  /**
   * `ROOT_ROUTE` joined this list on 2026-08-05. The original guard covered only the two rendered
   * components, and the claim it was written to kill ("you can optionally add a GitHub token to
   * lift rate limits") was still sitting in the `FAQPage` JSON-LD the whole time — read by search
   * engines and AI crawlers, i.e. the one surface where a stale claim outlives the page.
   */
  it('no public surface describes a user-suppliable GitHub token', () => {
    for (const source of [HOME_PAGE, FAQ_SECTION, ROOT_ROUTE]) {
      expect(source).not.toMatch(/personal access token/i)
      expect(source).not.toMatch(/add a github token/i)
    }
  })

  /**
   * `ACCESS_ALLOWLIST_ENABLED` puts sign-up behind an `access_requests` approval queue, which is a
   * waiting list by every name a visitor would use. The flag defaults to `false` so local and e2e
   * fixtures can create users, and production opts in explicitly — so copy must not promise the
   * flag is off.
   */
  it('HomePage never promises there is no waiting list', () => {
    expect(HOME_PAGE).not.toMatch(/no waiting list/i)
    expect(HOME_PAGE).not.toMatch(/no waitlist/i)
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

/**
 * "Free during (public) beta" was true when it was written and false from the moment the Stripe
 * catalog went live: `/pricing` sells Pro, Pro Max and Team today, with live Stripe Price IDs, and
 * one of those tiers (Pro) is explicitly sold to individuals. The claim had spread to seven
 * surfaces by 2026-08-05 — hero badge, final CTA, footer badge, sign-up header, the landing FAQ,
 * the `FAQPage` JSON-LD and `/explore`'s meta description — each written independently, so nothing
 * connected them to the catalog going live.
 *
 * The guard is gated on the catalog rather than unconditional: if every paid entry were ever
 * retired, "free during beta" becomes honest again and this test correctly stops applying.
 */
const PUBLIC_PRICING_SURFACES: Array<{ label: string; source: string }> = [
  { label: 'HomePage.tsx', source: HOME_PAGE },
  { label: 'FAQSection.tsx', source: FAQ_SECTION },
  { label: '__root.tsx (JSON-LD)', source: ROOT_ROUTE },
  { label: 'Footer.tsx', source: read('src/shared/components/Footer.tsx') },
  { label: 'SignUpPage.tsx', source: read('src/modules/auth/components/SignUpPage.tsx') },
  { label: 'explore/index.tsx (meta)', source: read('src/routes/_landing/explore/index.tsx') },
]

describe('"free during beta" claims vs. the live Stripe catalog', () => {
  it('the catalog has active paid entries, which is what makes the claim false', () => {
    expect(listActiveSubscriptionCatalog().length).toBeGreaterThan(0)
  })

  it.each(PUBLIC_PRICING_SURFACES)(
    '$label never says the product is free during the beta',
    ({ source }) => {
      if (listActiveSubscriptionCatalog().length === 0) return
      expect(source).not.toMatch(/free (to use )?during (the )?(public )?beta/i)
      expect(source).not.toMatch(/free during beta/i)
    },
  )
})

/**
 * Nine surfaces claimed BuilderHunt searches "12 sources", and all nine went stale on 2026-08-04
 * when `sourcehut` and `hashnode` were retired (`drizzle/0143`, `drizzle/0144`) — the real number
 * is `IMPLEMENTED_SEARCH_CONNECTORS.length`. The JSON-LD's source *list* was already guarded in
 * both directions; the prose *count* was not, on any surface.
 *
 * The guard bans the literal rather than checking the digits, because a correct literal today is
 * a wrong literal after the next retirement. `SEARCH_SOURCE_COUNT` is client-safe precisely so
 * that these surfaces can interpolate it.
 */
const SOURCE_COUNT_SURFACES = [
  'src/modules/landing/components/FAQSection.tsx',
  'src/modules/landing/components/HomePage.tsx',
  'src/routes/r/$slug.tsx',
  'src/routes/api/og/explore.tsx',
  'src/routes/_landing/blog/$slug.tsx',
  'src/routes/onboarding/welcome.tsx',
  'src/routes/onboarding/search.tsx',
  'src/routes/onboarding/success.tsx',
]

describe('public copy never hardcodes the source count', () => {
  it('the count is derived from the connector registry', () => {
    expect(SEARCH_SOURCE_COUNT).toBe(IMPLEMENTED_SEARCH_CONNECTORS.length)
  })

  it.each(SOURCE_COUNT_SURFACES)('%s interpolates the count instead of writing it', (file) => {
    const source = read(file)
    const hardcoded = [...source.matchAll(/\b(\d+) sources\b/g)].map((m) => m[0])
    expect(
      hardcoded,
      `write \`\${SEARCH_SOURCE_COUNT} sources\` instead of: ${hardcoded.join(', ')}`,
    ).toEqual([])
  })
})

/**
 * `resolveLegacyPlanTier` maps Pro Max onto `team`, so an AI task whose allowances are
 * `{ free: 0, pro: 0, team: N }` is entitled for BOTH Pro Max and Team. Two locked-state panels
 * said "is a Team-plan feature / Upgrade to Team", which sends an entitled Pro Max subscriber to
 * buy a plan they do not need — while `/pricing`'s own comparison table already ticks both
 * columns. Derived from `tasks.ts` source rather than a copied tier list, so re-gating a task
 * fails the test instead of silently un-syncing the copy.
 */
const AI_TASKS = read('src/shared/lib/ai/tasks.ts')

function allowancesFor(taskId: string): { free: number; pro: number; team: number } | null {
  const at = AI_TASKS.indexOf(`id: '${taskId}'`)
  if (at < 0) return null
  const match = AI_TASKS.slice(at).match(
    /allowances:\s*\{\s*free:\s*(\d+),\s*pro:\s*(\d+),\s*team:\s*(\d+)\s*\}/,
  )
  return match
    ? { free: Number(match[1]), pro: Number(match[2]), team: Number(match[3]) }
    : null
}

const TIER_GATED_PANELS = [
  { taskId: 'work-sample-analyze', file: 'src/modules/builder-profile/components/WorkSamplePanel.tsx' },
  { taskId: 'synergy-analysis', file: 'src/modules/builder-profile/components/TeamFitCard.tsx' },
]

describe('locked-state upsell copy names every entitled tier', () => {
  it.each(TIER_GATED_PANELS)('$file matches $taskId\'s allowances', ({ taskId, file }) => {
    const allowances = allowancesFor(taskId)
    expect(allowances, `expected to find allowances for '${taskId}'`).not.toBeNull()

    const proMaxEntitled = allowances!.pro === 0 && allowances!.team > 0
    if (!proMaxEntitled) return

    const source = read(file)
    expect(source, `${taskId} is entitled for Pro Max, so the copy must name it`).toMatch(/Pro Max/)
    expect(source, 'copy must not present a Pro Max feature as Team-only').not.toMatch(
      /is a Team-plan feature/i,
    )
    expect(source, 'copy must not send an entitled Pro Max subscriber to Team').not.toMatch(
      /Upgrade to Team\b/,
    )
  })
})
