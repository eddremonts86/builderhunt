/**
 * Writes retrieval projections for catalog components (plan 43 Phase 5, "Build versioned search
 * projections").
 *
 * Three properties this has to hold, and each one is a decision rather than an implementation detail:
 *
 * - **An unchanged rebuild writes nothing.** The projection's own content hash decides, so re-running the
 *   projector over the entire catalog is cheap and can be a cron job rather than a migration.
 * - **A stale job cannot overwrite current work.** The upsert refuses to lower `projection_version`, so a
 *   run that started before a document-builder rollout leaves newer projections alone instead of
 *   reverting them to the old shape.
 * - **Only currently-valid versions are projected.** Retrieval must never surface a closed version:
 *   citing one would make a run irreproducible, since the evidence behind it has already been superseded.
 *
 * The vector lane is enqueued into `builder_embeddings` rather than owned here. That table's `entityKind`
 * column exists for this — one embedding dimension, one HNSW index, one re-embed script shared with
 * builder profiles. A second vector column would be a second dimension free to silently diverge from
 * `AI_EMBEDDING_DIM`.
 */
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { workerDb } from '~/shared/lib/db/worker-db'
import { publicDb } from '~/shared/lib/db/client'
import {
  builderEmbeddings,
  solutionComponentCapabilities,
  solutionComponentProjections,
  solutionComponentVersions,
  solutionComponents,
} from '~/shared/lib/db/schema'
import type { EmbeddedCatalogComponent } from '~/lib/semantic/embedding-doc'
import { log } from '~/shared/lib/log'
import type { CapabilityEvidenceLevel, ComponentKind } from '~/shared/lib/solutions/contracts'
import { PROJECTION_VERSION, buildProjection, type ProjectionRow } from './projection-doc'

export interface ProjectComponentsOptions {
  /** Project at most this many components. Bounded so one run cannot hold a connection indefinitely. */
  limit?: number
  /** Only these components. Used by the ingestion path to project what it just wrote. */
  componentIds?: readonly string[]
  /** Reads through the app role, writes through the worker role — split so a test can point both at one
   * disposable database. */
  readDb?: PostgresJsDatabase
  writeDb?: PostgresJsDatabase
}

export interface ProjectComponentsResult {
  scanned: number
  written: number
  unchanged: number
  /** Projections left alone because the stored one carries a newer `projection_version`. Counted rather
   * than silently skipped: a non-zero value in a normal run means two projectors are racing. */
  skippedStale: number
  embeddingsEnqueued: number
}

const DEFAULT_LIMIT = 500

export async function projectComponents(options: ProjectComponentsOptions = {}): Promise<ProjectComponentsResult> {
  const readDb = options.readDb ?? publicDb
  const writeDb = options.writeDb ?? workerDb

  const candidates = await loadProjectableComponents(readDb, options)
  const result: ProjectComponentsResult = {
    scanned: candidates.length, written: 0, unchanged: 0, skippedStale: 0, embeddingsEnqueued: 0,
  }
  if (candidates.length === 0) return result

  const existing = await readDb
    .select({
      componentId: solutionComponentProjections.componentId,
      version: solutionComponentProjections.version,
      contentHash: solutionComponentProjections.contentHash,
      projectionVersion: solutionComponentProjections.projectionVersion,
    })
    .from(solutionComponentProjections)
    .where(inArray(solutionComponentProjections.componentId, candidates.map((c) => c.componentId)))
    // `candidates` is already the run's own bounded slice — see `ProjectComponentsOptions.limit` — so
    // the ceiling is that slice, with headroom for a component's several projection versions.
    .limit(candidates.length * 4)
  const existingByKey = new Map(existing.map((row) => [`${row.componentId}:${row.version}`, row]))

  for (const candidate of candidates) {
    const projection = buildProjection(candidate)
    const stored = existingByKey.get(`${projection.componentId}:${projection.version}`)

    if (stored && stored.projectionVersion > projection.projectionVersion) {
      result.skippedStale += 1
      continue
    }
    if (stored && stored.contentHash === projection.contentHash) {
      result.unchanged += 1
      continue
    }

    await writeProjection(projection, writeDb)
    result.written += 1
    if (await enqueueEmbedding(projection, candidate.displayName, writeDb)) result.embeddingsEnqueued += 1
  }

  // A component whose current version changed leaves the *previous* version's projection behind. Retrieval
  // filters on the version it joins, so a leftover row is harmless to correctness — but it accumulates,
  // and a projection for a closed version is exactly the thing that must never be returned. Deleting it
  // here keeps "every row in this table describes a live version" true rather than merely enforced by
  // whoever writes the next query.
  const removed = await deleteProjectionsForClosedVersions(candidates.map((c) => c.componentId), writeDb)

  log.info('solutions_projection_run', { ...result, closedVersionProjectionsRemoved: removed })
  return result
}

interface ProjectableComponent {
  componentId: string
  version: number
  kind: ComponentKind
  sourceKey: string
  displayName: string
  metadata: Record<string, unknown>
  capabilities: Array<{ capabilityKey: string; evidenceLevel: CapabilityEvidenceLevel }>
  observedAt: Date
}

/**
 * Loads active components at their currently-valid version, with their claims.
 *
 * `lifecycle_state = 'active'` and `valid_until is null` are both in SQL rather than filtered afterwards:
 * a draft or withdrawn component must never reach a projection, and pulling every version to discard most
 * of them in JS would read the whole version history on every run.
 *
 * Claims are joined in a second query rather than in the same one. A component with fifteen claims would
 * otherwise multiply its metadata JSON fifteen times over the wire, and that metadata is the largest
 * column here.
 */
async function loadProjectableComponents(
  db: PostgresJsDatabase,
  options: ProjectComponentsOptions,
): Promise<ProjectableComponent[]> {
  const conditions = [
    eq(solutionComponents.lifecycleState, 'active'),
    isNull(solutionComponentVersions.validUntil),
  ]
  if (options.componentIds?.length) {
    conditions.push(inArray(solutionComponents.id, [...options.componentIds]))
  }

  const rows = await db
    .select({
      componentId: solutionComponents.id,
      kind: solutionComponents.kind,
      sourceKey: solutionComponents.sourceKey,
      displayName: solutionComponents.displayName,
      version: solutionComponentVersions.version,
      metadata: solutionComponentVersions.metadata,
      observedAt: solutionComponentVersions.observedAt,
    })
    .from(solutionComponents)
    .innerJoin(solutionComponentVersions, eq(solutionComponentVersions.componentId, solutionComponents.id))
    .where(and(...conditions))
    .orderBy(solutionComponents.id)
    .limit(options.limit ?? DEFAULT_LIMIT)
  if (rows.length === 0) return []

  const claims = await db
    .select({
      componentId: solutionComponentCapabilities.componentId,
      componentVersion: solutionComponentCapabilities.componentVersion,
      capabilityKey: solutionComponentCapabilities.capabilityKey,
      evidenceLevel: solutionComponentCapabilities.evidenceLevel,
    })
    .from(solutionComponentCapabilities)
    .where(inArray(solutionComponentCapabilities.componentId, rows.map((row) => row.componentId)))

  const claimsByKey = new Map<string, Array<{ capabilityKey: string; evidenceLevel: CapabilityEvidenceLevel }>>()
  for (const claim of claims) {
    const key = `${claim.componentId}:${claim.componentVersion}`
    const list = claimsByKey.get(key) ?? []
    list.push({ capabilityKey: claim.capabilityKey, evidenceLevel: claim.evidenceLevel as CapabilityEvidenceLevel })
    claimsByKey.set(key, list)
  }

  return rows.map((row) => ({
    componentId: row.componentId,
    version: row.version,
    kind: row.kind as ComponentKind,
    sourceKey: row.sourceKey,
    displayName: row.displayName,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    capabilities: claimsByKey.get(`${row.componentId}:${row.version}`) ?? [],
    observedAt: row.observedAt,
  }))
}

/**
 * Upserts one projection.
 *
 * The `where` on the conflict clause is the stale-job guard, and it is on the *update* rather than
 * pre-checked in JS because the check would otherwise race: two projectors reading, both deciding they may
 * write, and the slower one winning. Postgres evaluates it while holding the row.
 */
async function writeProjection(projection: ProjectionRow, db: PostgresJsDatabase): Promise<void> {
  await db
    .insert(solutionComponentProjections)
    .values({ ...projection, projectedAt: new Date() })
    .onConflictDoUpdate({
      target: [solutionComponentProjections.componentId, solutionComponentProjections.version],
      set: {
        kind: projection.kind,
        sourceKey: projection.sourceKey,
        searchDocument: projection.searchDocument,
        capabilityKeys: projection.capabilityKeys,
        maxEvidenceLevel: projection.maxEvidenceLevel,
        contentHash: projection.contentHash,
        projectionVersion: projection.projectionVersion,
        observedAt: projection.observedAt,
        projectedAt: new Date(),
      },
      where: lte(solutionComponentProjections.projectionVersion, projection.projectionVersion),
    })
}

/**
 * Enqueues the component for embedding by writing a pending row into `builder_embeddings`.
 *
 * Writes the document and hash but leaves `embedding` and `embedded_at` null — the embed worker claims
 * pending rows, so this never calls a provider. Keeping the provider out of the projector is what makes
 * projecting the whole catalog free: a rebuild after a wording change costs no tokens unless the document
 * itself changed, and the hash decides that.
 *
 * `onConflictDoUpdate` on `(entity_kind, source, source_id)` with a hash guard: an unchanged document keeps
 * its existing vector rather than being reset to pending, so a rebuild does not silently blank the index.
 */
async function enqueueEmbedding(projection: ProjectionRow, displayName: string, db: PostgresJsDatabase): Promise<boolean> {
  const [row] = await db
    .insert(builderEmbeddings)
    .values({
      id: `${projection.kind}:${projection.componentId}`,
      entityKind: projection.kind,
      source: projection.sourceKey,
      sourceId: projection.componentId,
      contentHash: projection.contentHash,
      document: projection.searchDocument,
      // The payload semantic search returns without a second read. Tagged `catalog_component` so a
      // reader cannot hand it to a person result card — `asEmbeddedProfile` returns null for it. Only
      // what a card needs; never the full metadata, which would duplicate the version row into a second
      // store nothing keeps in step with it.
      profile: componentPayload(projection, displayName),
    })
    .onConflictDoUpdate({
      target: [builderEmbeddings.entityKind, builderEmbeddings.source, builderEmbeddings.sourceId],
      set: {
        contentHash: projection.contentHash,
        document: projection.searchDocument,
        profile: componentPayload(projection, displayName),
        // Back to pending: the document changed, so the stored vector describes text that no longer
        // exists and must not keep answering queries.
        embedding: null,
        embeddedAt: null,
        updatedAt: new Date(),
      },
      // Only when the document actually changed. Without this, every rebuild would blank every vector in
      // the catalog and the semantic lane would go dark until the embed worker caught up.
      where: sql`${builderEmbeddings.contentHash} <> ${projection.contentHash}`,
    })
    .returning({ id: builderEmbeddings.id })
  return row !== undefined
}

function componentPayload(projection: ProjectionRow, displayName: string): EmbeddedCatalogComponent {
  return {
    payloadKind: 'catalog_component',
    displayName,
    componentKind: projection.kind,
    capabilityKeys: projection.capabilityKeys,
  }
}

/**
 * Removes projections whose version is no longer the current one.
 *
 * Scoped to the components this run touched rather than sweeping the table, so the cost stays proportional
 * to the work done. A full sweep belongs in a retention job, not in the hot path of ingestion.
 */
async function deleteProjectionsForClosedVersions(
  componentIds: readonly string[],
  db: PostgresJsDatabase,
): Promise<number> {
  if (componentIds.length === 0) return 0
  const removed = await db
    .delete(solutionComponentProjections)
    .where(and(
      inArray(solutionComponentProjections.componentId, [...componentIds]),
      sql`not exists (
        select 1 from ${solutionComponentVersions} v
        where v.component_id = ${solutionComponentProjections.componentId}
          and v.version = ${solutionComponentProjections.version}
          and v.valid_until is null
      )`,
    ))
    .returning({ componentId: solutionComponentProjections.componentId })
  return removed.length
}

/** Components whose projection predates the current document builder, so a rollout can target them. */
export async function countStaleProjections(db: PostgresJsDatabase = publicDb): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(solutionComponentProjections)
    .where(sql`${solutionComponentProjections.projectionVersion} < ${PROJECTION_VERSION}`)
  return row?.count ?? 0
}
