/**
 * Runs one or more credentialed job adapters once, against whatever the register currently has enabled.
 *
 * ```
 * node --env-file=.env --import tsx scripts/solutions/run-credentialed-once.ts jobtech_dev_jobs themuse_jobs
 * node --env-file=.env --import tsx scripts/solutions/run-credentialed-once.ts        # every enabled one
 * ```
 *
 * Exists because four of the seven adapters parse a shape taken from published documentation rather than from
 * a response anyone has seen: **the first real run is their first test**, and it needs to be easy enough that
 * whoever provisions a key actually does it. Watch two numbers in the output — `emptyAfterFieldFilter` above
 * zero means the register's `allowed_fields` and the adapter's `metadataKeys` disagree and fields were dropped
 * silently, and a `failed` with `unexpected_response_shape` means the served payload is not the documented one.
 *
 * A disabled source reports `skipped: source_disabled` rather than being run — enabling is a deliberate act
 * through the admin surface, not something a script decides.
 */
import { CREDENTIALED_JOB_FEED_ADAPTERS } from '~/lib/solutions/sources/credentialed-job-feeds'
import { runSolutionSourceAdapter } from '~/lib/solutions/sources/runner'

const requested = new Set(process.argv.slice(2))
const adapters = requested.size > 0
  ? CREDENTIALED_JOB_FEED_ADAPTERS.filter((adapter) => requested.has(adapter.sourceKey))
  : CREDENTIALED_JOB_FEED_ADAPTERS

if (adapters.length === 0) {
  process.stderr.write(`No adapter matched. Known: ${CREDENTIALED_JOB_FEED_ADAPTERS.map((a) => a.sourceKey).join(', ')}\n`)
  process.exit(2)
}

for (const adapter of adapters) {
  const result = await runSolutionSourceAdapter(adapter, { limit: 25 })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
process.exit(0)
