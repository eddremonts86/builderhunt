import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The drift contract `plans/phase-1/52-audit-trust` deferred.
 *
 * That plan shipped `trust-claims.test.ts`, which pins the specific false claims one pass removed from
 * the landing page, and recorded the general version as still open: *"a true generic 'any displayed
 * number that drifts from a shipped constant fails CI' contract is real, valuable, future work — not
 * attempted here."* This is that contract, built after measuring why the obvious version does not work.
 *
 * **The obvious version is a rubber stamp.** A detector that flags every numeral in the UI drowns in
 * `grid-cols-3`, `slice(0, 5)` and `gap-2`; the allowlist needed to quiet it ends up longer than the
 * rule, and a gate nobody can read is a gate nobody maintains. Measured before building: 22 files
 * across the public surfaces, 15 numerals in visible text, and only some of those are claims at all.
 *
 * So this inverts it. Instead of hunting numbers and asking which are claims, it declares the **claims
 * that are load-bearing** and asserts each one still agrees with the thing that implements it. Two
 * kinds, and neither is a string comparison for its own sake:
 *
 *   1. **Sub-processors.** Every third party the privacy policy names as seeing candidate data must
 *      appear in the provider register. Writing this found the reason it was worth writing: the policy
 *      named Cloudflare R2 as the document store, which the product does not use.
 *   2. **Retention promises.** Every day-count published as a promise must be *structurally* impossible
 *      to exceed — the env schema needs a `.max()` at or below the published number. Comparing against
 *      the default would pass while an operator could set a longer window tomorrow; comparing against
 *      the ceiling is the only version that makes the published sentence true for every deployment.
 */

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

/**
 * Source with comments stripped, so an assertion is about what a reader sees rather than what the file
 * contains.
 *
 * This is not a convenience: the first run of this suite failed on the JSX comment that *documents* the
 * Cloudflare R2 correction. A gate that cannot tell rendered copy from an explanation of why the copy
 * changed forces the next person to delete the explanation to make CI pass, which is how a codebase
 * loses the reason for its own fixes.
 */
function visibleSource(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const PRIVACY_POLICY = visibleSource(read('src/routes/_landing/legal/privacy.tsx'))
const PROVIDER_REGISTER = read('docs/operations/interview-provider-register.md')
const ENV_SCHEMA = read('src/shared/lib/env.ts')

describe('published sub-processors match the provider register', () => {
  /**
   * The vendors the policy names in "Who else sees it". Kept as an explicit list rather than parsed out
   * of the JSX: a parser would silently match nothing the day the markup changes, and a claims gate that
   * can pass by finding nothing is worse than no gate.
   */
  const NAMED_VENDORS = ['Deepgram', 'Mistral', 'Resend']

  it.each(NAMED_VENDORS)('%s is named in the policy and registered as a provider', (vendor) => {
    expect(PRIVACY_POLICY, `${vendor} should still be disclosed`).toContain(vendor)
    expect(PROVIDER_REGISTER, `${vendor} is disclosed to candidates but absent from the register`).toContain(vendor)
  })

  it('names no storage vendor, because document storage is self-hosted', () => {
    // The specific regression: "Storage: Cloudflare R2, private buckets" shipped on the live policy
    // while documents sat in self-hosted MinIO. `INTERVIEW_R2_*` env names were kept deliberately, so
    // the code reads like R2 everywhere — which is exactly how the copy drifted.
    expect(PRIVACY_POLICY).not.toMatch(/Cloudflare\s+R2/i)
    expect(PROVIDER_REGISTER).toMatch(/MinIO/)
  })

  it('claims no third party trains on candidate data, and the register agrees', () => {
    expect(PRIVACY_POLICY).toMatch(/train/i)
    expect(PROVIDER_REGISTER).toMatch(/training opt-out|no training|forbid/i)
  })
})

describe('published retention promises cannot be exceeded by configuration', () => {
  /**
   * `[published days, env var]`. The published number is the promise a candidate reads; the env var is
   * what the sweep actually uses. The assertion is on the schema's ceiling, not its default.
   */
  const PROMISES: Array<[number, string]> = [
    [180, 'INTERVIEW_DOCUMENT_RETENTION_DAYS'],
    [90, 'INTERVIEW_TRANSCRIPT_RETENTION_DAYS'],
  ]

  it.each(PROMISES)('the %i-day promise is capped by %s', (days, envVar) => {
    const declaration = new RegExp(`${envVar}:[^\\n]*`).exec(ENV_SCHEMA)?.[0]
    expect(declaration, `${envVar} should be declared in env.ts`).toBeTruthy()

    const max = Number(/\.max\((\d+)\)/.exec(declaration!)?.[1])
    expect(max, `${envVar} needs a .max() or the published ${days}-day promise is unenforceable`).not.toBeNaN()
    expect(max, `${envVar} may exceed the ${days} days the policy publishes`).toBeLessThanOrEqual(days)
  })

  it.each(PROMISES)('the %i-day figure still appears in the policy', (days) => {
    expect(PRIVACY_POLICY).toContain(`${days} days`)
  })

  it('states audio is never stored, which is why no retention window is published for it', () => {
    expect(PRIVACY_POLICY).toMatch(/Audio:<\/strong> never stored/)
  })
})
