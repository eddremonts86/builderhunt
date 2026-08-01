/**
 * Market rate evidence from job postings (plan 43 Phase 5, supporting "calculate estimate intervals").
 *
 * ## Why this exists, and why it is not part of retrieval
 *
 * The job feeds — Jobindex, Arbeitnow, Remote OK, Jobicy, Himalayas — contribute `human_role` components
 * with **no capability claims at all**, because a job ad states what an employer wants and says nothing
 * about what anyone can do. That is deliberate and stays.
 *
 * The consequence only became visible by running it: retrieval's capability filter is a hard array overlap,
 * so a component claiming nothing can never match, and forty ingested postings were structurally
 * unretrievable. The instinct is to derive capabilities from posting titles — and it is exactly the
 * inference the adapters refuse to make. "Someone in Munich advertised for a Rust developer" is not
 * evidence that a Rust developer exists, is available, or can do this brief's work.
 *
 * So these postings are not retrieval candidates. They answer a different question, and it is the one the
 * composer cannot otherwise answer honestly: **what does this kind of work cost?** A route's estimate has to
 * come from somewhere, and a band derived from real advertised salaries for comparable roles is evidence,
 * where a hardcoded rate card would be a guess with a confident face on it.
 *
 * ## What makes a band trustworthy
 *
 * - **Median, not mean.** One executive posting in a set of twenty junior ones moves a mean enough to
 *   mislead; it moves a median by one position.
 * - **A minimum sample.** Two postings do not describe a market. Below the floor this returns no estimate
 *   rather than a wide one, because "we don't know" is usable and a fabricated range is not.
 * - **One currency at a time.** Mixing 60,000 EUR with 120,000 USD produces a number that is not a salary
 *   in any currency. Postings are grouped by currency and the largest group wins, with the others counted
 *   so the caller can see the split was real.
 * - **Annual only.** A monthly figure and an annual figure differ by 12×, which is not a rounding error.
 *   Anything not annual is excluded rather than converted, because these feeds' period labels are not
 *   reliable enough to normalise on.
 */
import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { publicDb } from '~/shared/lib/db/client'
import { solutionComponentProjections, solutionComponentVersions } from '~/shared/lib/db/schema'
import { toAnyTermQuery } from './lanes'

/**
 * Fewest postings that can support a band.
 *
 * Five is a judgement, and a low one — it is enough that a single outlier cannot be the median, and low
 * enough to be reachable for a specific role in a small market. It is stated here rather than buried in a
 * query so that raising it is a visible decision.
 */
export const MIN_SAMPLE_SIZE = 5

/** Postings older than this describe a market that has moved. */
const MAX_AGE_DAYS = 365

export interface MarketRateBand {
  /** Currency the band is denominated in. Never a mix. */
  currency: string
  /** 25th, 50th and 75th percentile of the advertised annual figures. */
  p25: number
  median: number
  p75: number
  sampleSize: number
  /** Postings excluded because they were priced in a different currency. Non-zero means the market this
   * band describes is narrower than the query suggested. */
  otherCurrencySamples: number
  /** Sources the band drew on, so an estimate can cite where its numbers came from. */
  sourceKeys: string[]
}

export type MarketRateOutcome =
  | { status: 'ok'; band: MarketRateBand }
  /** Fewer than `MIN_SAMPLE_SIZE` comparable postings. Not an error — most roles have no local market data,
   * and the composer states an estimate is unavailable rather than inventing one. */
  | { status: 'insufficient_data'; sampleSize: number }

export interface MarketRateQuery {
  /** Free text describing the role. Matched against the same lexical index retrieval uses. */
  roleText: string
  /** Restrict to postings from these sources. Omitted means all of them. */
  sourceKeys?: readonly string[]
  now?: Date
}

/**
 * Finds an advertised-salary band for a kind of role.
 *
 * Matches through the projections' full-text index rather than a `LIKE` on the title, so "danish translator"
 * finds "Translator, Danish" and "Oversætter" alike — the same index and the same any-term query the
 * lexical retrieval lane uses, which means a role the composer can retrieve is a role it can also price.
 */
export async function findMarketRateBand(
  query: MarketRateQuery,
  db: PostgresJsDatabase = publicDb,
): Promise<MarketRateOutcome> {
  const anyTerm = toAnyTermQuery(query.roleText)
  if (anyTerm.length === 0) return { status: 'insufficient_data', sampleSize: 0 }

  const now = query.now ?? new Date()
  const cutoff = new Date(now.getTime() - MAX_AGE_DAYS * 86_400_000)
  const tsQuery = sql`websearch_to_tsquery('english', ${anyTerm})`

  const conditions = [
    eq(solutionComponentProjections.kind, 'human_role'),
    sql`${solutionComponentProjections.searchVector} @@ ${tsQuery}`,
    // `gte` on the typed column, not a raw sql comparison: a bare Date inside a template is bound with no
    // type and postgres.js refuses it outright ("The \"string\" argument must be of type string ... Received
    // an instance of Date"). Drizzle knows the column is a timestamp and serialises accordingly.
    gte(solutionComponentProjections.observedAt, cutoff),
    // Salary lives in the version's metadata, not in the projection: a projection is what a component is
    // *findable* by, and a number nobody searches for has no business in a text index.
    isNotNull(sql`${solutionComponentVersions.metadata} -> 'salaryMin'`),
  ]
  if (query.sourceKeys?.length) {
    conditions.push(inArray(solutionComponentProjections.sourceKey, [...query.sourceKeys]))
  }

  const rows = await db
    .select({
      sourceKey: solutionComponentProjections.sourceKey,
      salaryMin: sql<number | null>`(${solutionComponentVersions.metadata} ->> 'salaryMin')::numeric`,
      salaryMax: sql<number | null>`(${solutionComponentVersions.metadata} ->> 'salaryMax')::numeric`,
      currency: sql<string | null>`${solutionComponentVersions.metadata} ->> 'salaryCurrency'`,
      period: sql<string | null>`${solutionComponentVersions.metadata} ->> 'salaryPeriod'`,
    })
    .from(solutionComponentProjections)
    .innerJoin(solutionComponentVersions, and(
      eq(solutionComponentVersions.componentId, solutionComponentProjections.componentId),
      eq(solutionComponentVersions.version, solutionComponentProjections.version),
    ))
    .where(and(...conditions))
    .limit(2000)

  return summarizeBand(rows)
}

interface RateRow {
  sourceKey: string
  salaryMin: number | null
  salaryMax: number | null
  currency: string | null
  period: string | null
}

/**
 * Reduces raw postings to one band.
 *
 * Exported so the percentile and currency-grouping rules can be tested without a database — they are the
 * part that decides what number a user is shown.
 */
export function summarizeBand(rows: readonly RateRow[]): MarketRateOutcome {
  const byCurrency = new Map<string, { values: number[]; sources: Set<string> }>()

  for (const row of rows) {
    // A currency-less figure cannot join a band: it would be counted as whatever the majority happened to
    // be. Remote OK publishes salary without currency, which is exactly this case.
    if (!row.currency || row.currency.length !== 3) continue
    // Anything not annual is excluded, not converted. A monthly and an annual figure differ by 12×.
    if (row.period && !/^ann/i.test(row.period)) continue

    const min = toPositiveNumber(row.salaryMin)
    const max = toPositiveNumber(row.salaryMax)
    if (min === null && max === null) continue
    // The midpoint of an advertised band is the closest thing to "what this role pays"; a lone bound is
    // used as-is rather than doubled or halved into a fabricated range.
    const value = min !== null && max !== null ? (min + max) / 2 : (min ?? max)!

    const currency = row.currency.toUpperCase()
    const bucket = byCurrency.get(currency) ?? { values: [], sources: new Set<string>() }
    bucket.values.push(value)
    bucket.sources.add(row.sourceKey)
    byCurrency.set(currency, bucket)
  }

  let best: { currency: string; values: number[]; sources: Set<string> } | null = null
  let total = 0
  for (const [currency, bucket] of byCurrency) {
    total += bucket.values.length
    // Ties broken by currency code so the same input always produces the same band — an estimate that
    // changed currency between two runs of one brief would be indefensible.
    if (!best || bucket.values.length > best.values.length
      || (bucket.values.length === best.values.length && currency < best.currency)) {
      best = { currency, values: bucket.values, sources: bucket.sources }
    }
  }

  if (!best || best.values.length < MIN_SAMPLE_SIZE) {
    return { status: 'insufficient_data', sampleSize: best?.values.length ?? 0 }
  }

  const sorted = [...best.values].sort((a, b) => a - b)
  return {
    status: 'ok',
    band: {
      currency: best.currency,
      p25: percentile(sorted, 0.25),
      median: percentile(sorted, 0.5),
      p75: percentile(sorted, 0.75),
      sampleSize: sorted.length,
      otherCurrencySamples: total - sorted.length,
      sourceKeys: [...best.sources].sort(),
    },
  }
}

function toPositiveNumber(value: number | string | null): number | null {
  if (value === null) return null
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * Nearest-rank percentile on a pre-sorted array.
 *
 * Nearest-rank rather than interpolated: an interpolated percentile invents a value that no posting
 * advertised, and every number in a band shown to a user should be one a real employer offered.
 */
function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return Math.round(sorted[index])
}

/**
 * What the job feeds are for, stated where a reader will find it.
 *
 * Retrieval deliberately cannot return these components. Anything that wants to use them goes through
 * `findMarketRateBand`, and this constant is the list of sources it draws on.
 */
export const MARKET_RATE_SOURCE_KEYS: readonly string[] = [
  'jobindex_roles', 'arbeitnow_jobs', 'remoteok_jobs', 'jobicy_jobs', 'himalayas_jobs',
]
