/**
 * Runs the gold set through the real pipeline and reports what it found (plan 43 Phase 0 / Phase 9).
 *
 * ```
 * pnpm solutions:evaluate                 # synthetic seed only
 * pnpm solutions:evaluate --include-human # seed plus human-authored records from the database
 * pnpm solutions:evaluate --json          # machine-readable, for a dated artifact
 * ```
 *
 * ## It prints two reports, never one number
 *
 * Synthetic and human populations are summarised separately and never blended. The 60 seeded briefs are
 * machine-authored: the generator and the grader share assumptions, so a score against them detects regressions
 * and proves nothing about quality. tasks.md forbids an unqualified quality number from a synthetic-only run,
 * and this script enforces that by refusing to print one — `citableAsQualityGate` is false until human-authored
 * records exist.
 *
 * ## Deterministic for fixed fixtures
 *
 * With interpretation and explanation disabled — the default here — the whole pipeline is SQL and arithmetic, so
 * two runs over the same database produce identical scores. Latency is reported but never asserted, because it
 * is the one number that legitimately moves.
 */
import { readFile } from 'node:fs/promises'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { composeRoutes } from '~/lib/solutions/composer/compose'
import { interpretBrief } from '~/lib/solutions/ai/interpret'
import { humanLane } from '~/lib/solutions/retrieval/lanes'
import { retrieveForBrief } from '~/lib/solutions/retrieval/retrieve'
import {
  goldSetFileSchema,
  isCitableAsQualityGate,
  scoreBrief,
  summarize,
  type GoldBrief,
  type GoldScore,
} from '~/shared/lib/solutions/gold-set'

const GOLD_SET_PATH = 'tests/fixtures/solutions/gold-set.json'

async function main() {
  const asJson = process.argv.includes('--json')
  const includeHuman = process.argv.includes('--include-human')

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const sql = postgres(databaseUrl, { max: 4, prepare: false })
  const db = drizzle(sql)

  try {
    const file = goldSetFileSchema.parse(JSON.parse(await readFile(GOLD_SET_PATH, 'utf8')))
    const briefs: GoldBrief[] = [...file.briefs]

    if (includeHuman) {
      // Human-authored records live in the database because they are edited during the beta, by people, through
      // the admin surface. A file would make every edit a deploy.
      const rows = await sql<{ id: string; brief_text: string; expected: unknown }[]>`
        select id, brief_text, expected from solution_gold_briefs where authorship = 'human' order by id
      `
      for (const row of rows) {
        briefs.push({ id: row.id, authorship: 'human', briefText: row.brief_text, expected: row.expected as never })
      }
    }

    const scores: GoldScore[] = []
    for (const brief of briefs) {
      scores.push(await evaluateOne(brief, db))
    }

    const summaries = [summarize(scores, 'synthetic'), summarize(scores, 'human')]
    const report = {
      goldSetVersion: file.version,
      evaluatedAt: new Date().toISOString(),
      totalBriefs: briefs.length,
      summaries: summaries.filter((summary) => summary !== null),
      /**
       * The whole point of the split, as a machine-readable flag. A dashboard that read only `summaries` could
       * quote a synthetic mean as "quality"; this field is what a reader has to get past to do that.
       */
      citableAsQualityGate: isCitableAsQualityGate(summaries),
      note: file.authorshipNote,
    }

    if (asJson) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    } else {
      printHuman(report)
    }

    // A single excluded component appearing in any route fails the run outright — see `scoreBrief`.
    const exclusionFailures = scores.filter((score) => !score.respectedExclusions)
    if (exclusionFailures.length > 0) {
      process.stderr.write(`\n${exclusionFailures.length} brief(s) surfaced an excluded component kind\n`)
      process.exitCode = 1
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function evaluateOne(brief: GoldBrief, db: ReturnType<typeof drizzle>): Promise<GoldScore> {
  const started = Date.now()
  const interpretation = await interpretBrief({ briefText: brief.briefText })

  if (!interpretation.brief) {
    // No capability could be established, so nothing downstream can run. Scored as a total miss rather than
    // skipped: a brief the pipeline cannot read is a failure of the pipeline, not an absent measurement.
    return scoreBrief(brief, {
      briefId: brief.id,
      interpretedCapabilityKeys: [],
      interpretedDomain: 'other',
      offeredLanes: [],
      keptConstraintTypes: [],
      componentKinds: [],
      latencyMs: Date.now() - started,
      providerCalls: interpretation.provenance === 'model' ? 1 : 0,
    })
  }

  const retrieval = await retrieveForBrief(interpretation.brief, { db })
  const people = await humanLane(interpretation.brief.deliverable.description, 20, db)
  const composed = await composeRoutes({ brief: interpretation.brief, retrieval, people, db })

  return scoreBrief(brief, {
    briefId: brief.id,
    interpretedCapabilityKeys: interpretation.brief.capabilities,
    interpretedDomain: interpretation.brief.deliverable.domain,
    offeredLanes: composed.routes.filter((route) => route.status !== 'unavailable').map((route) => route.routeType),
    keptConstraintTypes: interpretation.brief.hardConstraints.map((constraint) => constraint.type),
    componentKinds: composed.routes.flatMap((route) => route.components.map((component) => component.componentId)),
    latencyMs: Date.now() - started,
    providerCalls: interpretation.provenance === 'model' ? 1 : 0,
  })
}

function printHuman(report: {
  totalBriefs: number
  summaries: Array<ReturnType<typeof summarize>>
  citableAsQualityGate: boolean
  note: string
}) {
  process.stdout.write(`\nSolutions evaluation — ${report.totalBriefs} briefs\n`)
  for (const summary of report.summaries) {
    if (!summary) continue
    process.stdout.write(`\n  ${summary.authorship.toUpperCase()} (${summary.count} briefs)\n`)
    process.stdout.write(`    capability recall     ${pct(summary.capabilityRecall)}\n`)
    process.stdout.write(`    domain accuracy       ${pct(summary.domainAccuracy)}\n`)
    process.stdout.write(`    lane recall           ${pct(summary.laneRecall)}\n`)
    process.stdout.write(`    constraint retention  ${pct(summary.constraintRetention)}\n`)
    process.stdout.write(`    exclusion failures    ${summary.exclusionFailures}\n`)
    process.stdout.write(`    latency p50 / p95     ${summary.latencyP50Ms}ms / ${summary.latencyP95Ms}ms\n`)
    process.stdout.write(`    provider calls        ${summary.providerCallsTotal}\n`)
  }
  process.stdout.write(
    report.citableAsQualityGate
      ? '\n  This report includes human-authored judgments and may be cited as a quality gate.\n'
      : '\n  SYNTHETIC ONLY — not a quality measurement. ' + report.note + '\n',
  )
}

const pct = (interval: { mean: number; halfWidth: number }) =>
  `${(interval.mean * 100).toFixed(1)}% ±${(interval.halfWidth * 100).toFixed(1)}`

await main()
