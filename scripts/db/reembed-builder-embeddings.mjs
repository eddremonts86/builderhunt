/**
 * Re-embedding / backfill procedure for `builder_embeddings`
 * (plans/implemented/43-solutions-intelligence Phase 2, "Unify embedding dimension and entity
 * contracts": "build a safe re-embedding/backfill procedure").
 *
 * Needed whenever the vector meaning changes underneath the stored rows: the embedding model is
 * swapped, `AI_EMBEDDING_DIM` moves, or a dimension mismatch is found by
 * `assertEmbeddingDimensionMatchesDatabase`. Vectors from two different models are not comparable,
 * so a half-migrated table silently returns nonsense rankings rather than failing.
 *
 * Design: this script never calls the embedding provider. It only sets `embedding = NULL`, which is
 * exactly the "pending" state `findPendingBuilderEmbeddings` already scans for, so the existing
 * embed worker does the actual re-embedding at its own rate, with its own budget and batching. That
 * matters for three reasons:
 *
 *   - Resume is free and needs no cursor file. The WHERE clause skips rows already reset, so an
 *     interrupted run is continued by simply running it again, and running it twice is harmless.
 *   - There is never a partially-written vector. A row is either the old complete vector or NULL.
 *   - Provider spend stays under the worker's existing controls instead of a script's own loop.
 *
 * A resize of the column itself (`vector(N)` → `vector(M)`) must run BEFORE this, in a migration,
 * because Postgres cannot hold both widths at once. `--stale-only` exists for the model-swap case
 * where the width is unchanged.
 *
 * Usage:
 *   node scripts/db/reembed-builder-embeddings.mjs --dry-run
 *   node scripts/db/reembed-builder-embeddings.mjs --entity-kind human_profile --batch 500
 *   node scripts/db/reembed-builder-embeddings.mjs --stale-only 2026-08-01T00:00:00Z
 */
import postgres from 'postgres'

const ENTITY_KINDS = ['human_profile', 'human_role', 'agent', 'model', 'model_endpoint', 'mcp_server', 'tool', 'service']

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}
const dryRun = process.argv.includes('--dry-run')
const entityKind = arg('entity-kind')
const staleBefore = arg('stale-only')
const batchSize = Number(arg('batch') ?? 1000)

if (entityKind && !ENTITY_KINDS.includes(entityKind)) {
  console.error(`--entity-kind must be one of: ${ENTITY_KINDS.join(', ')}`)
  process.exit(1)
}
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20_000) {
  console.error('--batch must be an integer between 1 and 20000')
  process.exit(1)
}
if (staleBefore && Number.isNaN(Date.parse(staleBefore))) {
  console.error('--stale-only must be an ISO 8601 timestamp')
  process.exit(1)
}

// The migration role, not the app role: this rewrites a global projection, which is maintenance
// rather than anything a request should ever be able to do.
const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_MIGRATION_URL (or DATABASE_URL) is required')
  process.exit(1)
}

const sql = postgres(databaseUrl, { max: 1 })

try {
  const [{ dimension }] = await sql`
    select atttypmod as dimension from pg_attribute
    where attrelid = 'builder_embeddings'::regclass and attname = 'embedding'
  `
  const configured = Number(process.env.AI_EMBEDDING_DIM ?? 768)
  if (dimension !== configured) {
    // Resetting rows while these disagree would queue work the worker cannot complete: it would
    // embed at `configured` and fail to store at `dimension`, on every row, forever.
    console.error(
      `Refusing to run: column is vector(${dimension}) but AI_EMBEDDING_DIM=${configured}. `
      + 'Align them first — resize the column in a migration, or fix the environment variable.',
    )
    process.exit(1)
  }

  const filters = [sql`embedding is not null`]
  if (entityKind) filters.push(sql`entity_kind = ${entityKind}`)
  if (staleBefore) filters.push(sql`embedded_at < ${staleBefore}`)
  const where = filters.reduce((acc, clause, i) => (i === 0 ? clause : sql`${acc} and ${clause}`))

  const [{ count: remaining }] = await sql`select count(*)::int as count from builder_embeddings where ${where}`
  const [{ count: alreadyPending }] = await sql`select count(*)::int as count from builder_embeddings where embedding is null`

  console.log(JSON.stringify({
    columnDimension: dimension,
    entityKind: entityKind ?? 'all',
    staleBefore: staleBefore ?? null,
    toReset: remaining,
    alreadyPending,
    batchSize,
    dryRun,
  }))

  if (dryRun || remaining === 0) {
    console.log(dryRun ? 'Dry run — nothing written.' : 'Nothing to reset.')
    process.exit(0)
  }

  // Batched so a large projection does not hold one long transaction open, and so an interruption
  // leaves a consistent table. Each batch commits on its own; the WHERE clause means the next run
  // resumes exactly where this one stopped.
  let reset = 0
  for (;;) {
    const rows = await sql`
      update builder_embeddings
      set embedding = null, embedded_at = null, updated_at = now()
      where id in (
        select id from builder_embeddings where ${where} order by id limit ${batchSize}
      )
      returning id
    `
    if (rows.length === 0) break
    reset += rows.length
    console.log(`reset ${reset}/${remaining}`)
  }

  console.log(JSON.stringify({ reset, note: 'The embed worker will re-embed these on its next runs.' }))
} finally {
  await sql.end({ timeout: 5 })
}
