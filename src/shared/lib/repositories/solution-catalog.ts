/**
 * Solutions catalog repository (plan 43 — solutions-intelligence Phase 4).
 *
 * Three connections appear here deliberately, and which one a function uses is part of its contract:
 *
 * - `publicDb` (app role) — reads only. Migration 0125 grants the app role SELECT and nothing else on
 *   every catalog table, so a request cannot assert a capability the catalog then presents as
 *   evidenced.
 * - `workerDb` — ingestion. Creates components, versions, evidence and *proposed* edges. It has no
 *   UPDATE on `solution_sources`: a worker able to enable its own data source would make the kill
 *   switch decorative.
 * - `platformDb` — the operator surface. Owns the source register (including `enabled`), activating a
 *   proposed edge, and retention deletes.
 *
 * If a function here ends up needing a connection it was not given, that is the grant design working;
 * the fix is the caller, not a widened grant. That already happened once this phase — see the
 * `platformDb` note on `/api/admin/human-links`.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { createHash } from 'node:crypto'
import { canonicalJson } from '~/shared/lib/ai/cache'
import { platformDb, publicDb } from '../db/client'
import { workerDb } from '../db/worker-db'
import {
  solutionComponentCapabilities,
  solutionComponentVersions,
  solutionComponents,
  solutionCompatibilityEdges,
  solutionEvidence,
  solutionSources,
} from '../db/schema'
import type { CapabilityEvidenceLevel, ComponentKind, CompatibilityEdgeType } from '~/shared/lib/solutions/contracts'
import { randomId } from '~/lib/utils'

// ── Source register ────────────────────────────────────────────────────────────────────────────

export type SolutionSourceKind =
  | 'official_api' | 'feed' | 'licensed_dataset' | 'user_submission' | 'public_scrape' | 'external_link_only'

export interface SolutionSourceRow {
  key: string
  kind: SolutionSourceKind
  label: string
  homepageUrl: string
  enabled: boolean
  allowedFields: string[]
  geography: string | null
  ownerContact: string | null
  rateLimitPerHour: number | null
  refreshIntervalHours: number | null
  retentionDays: number | null
  termsReviewedAt: Date | null
  termsReviewedBy: string | null
  registerNotes: string | null
  /** Set when this source's terms make access conditional on crediting it. Whatever renders a result from
   * this source must show `attributionText` linked to `attributionUrl`. */
  attributionRequired: boolean
  attributionText: string | null
  attributionUrl: string | null
  maxRequestsPerDay: number | null
  updatedAt: Date
}

/** The full register, for the operator's source list. Ordered so scrapes — the ones that need a review
 * before they can run — sort together. */
export async function listSolutionSources(db: PostgresJsDatabase = publicDb): Promise<SolutionSourceRow[]> {
  const rows = await db.select().from(solutionSources).orderBy(asc(solutionSources.kind), asc(solutionSources.key))
  return rows.map(toSourceRow)
}

/**
 * The keys ingestion is allowed to run right now.
 *
 * Every ingestion entry point must consult this rather than trusting a config constant: the kill
 * switch is a database column precisely so flipping it takes effect without a deploy.
 */
export async function listEnabledSourceKeys(db: PostgresJsDatabase = publicDb): Promise<string[]> {
  const rows = await db
    .select({ key: solutionSources.key })
    .from(solutionSources)
    .where(eq(solutionSources.enabled, true))
    .orderBy(asc(solutionSources.key))
  return rows.map((row) => row.key)
}

export async function findSolutionSource(key: string, db: PostgresJsDatabase = publicDb): Promise<SolutionSourceRow | null> {
  const [row] = await db.select().from(solutionSources).where(eq(solutionSources.key, key)).limit(1)
  return row ? toSourceRow(row) : null
}

export type SourceToggleOutcome =
  | { status: 'updated'; enabled: boolean }
  | { status: 'unchanged'; enabled: boolean }
  | { status: 'not_found' }
  /** A `public_scrape` source with no recorded terms review. The database refuses it; this turns that
   * refusal into an answer the operator can act on instead of a 500. */
  | { status: 'review_required' }

/**
 * Flips one source's kill switch. Platform role only.
 *
 * `review_required` is returned rather than thrown because the constraint it reflects
 * (`solution_sources_scrape_needs_review_check`) is a policy the operator can satisfy — record the
 * review, then retry — not a bug. Pre-checking here and letting the constraint be the backstop is
 * deliberate: the check could race, and the database is what must be authoritative.
 */
export async function setSolutionSourceEnabled(
  input: { key: string; enabled: boolean },
  db: PostgresJsDatabase = platformDb,
): Promise<SourceToggleOutcome> {
  const [existing] = await db
    .select({ kind: solutionSources.kind, enabled: solutionSources.enabled, termsReviewedAt: solutionSources.termsReviewedAt })
    .from(solutionSources)
    .where(eq(solutionSources.key, input.key))
    .limit(1)
  if (!existing) return { status: 'not_found' }
  if (existing.enabled === input.enabled) return { status: 'unchanged', enabled: existing.enabled }
  if (input.enabled && existing.kind === 'public_scrape' && existing.termsReviewedAt === null) {
    return { status: 'review_required' }
  }

  const updated = await db
    .update(solutionSources)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(eq(solutionSources.key, input.key))
    .returning({ enabled: solutionSources.enabled })
  return updated.length > 0 ? { status: 'updated', enabled: updated[0].enabled } : { status: 'not_found' }
}

/**
 * Records that a human reviewed this source's terms, robots policy and privacy posture.
 *
 * This is the outcome of the gate in `plans/phase-5/01-production-readiness-audit`, and writing it is
 * what makes a `public_scrape` source enableable at all. Kept separate from the toggle on purpose:
 * reviewing and enabling are two decisions, and collapsing them into one call would let a single
 * click do both.
 */
export async function recordSourceTermsReview(
  input: { key: string; reviewerUserId: string; notes?: string; at?: Date },
  db: PostgresJsDatabase = platformDb,
): Promise<boolean> {
  const at = input.at ?? new Date()
  const updated = await db
    .update(solutionSources)
    .set({
      termsReviewedAt: at,
      termsReviewedBy: input.reviewerUserId,
      ...(input.notes === undefined ? {} : { registerNotes: input.notes }),
      updatedAt: at,
    })
    .where(eq(solutionSources.key, input.key))
    .returning({ key: solutionSources.key })
  return updated.length > 0
}

function toSourceRow(row: typeof solutionSources.$inferSelect): SolutionSourceRow {
  return {
    key: row.key,
    kind: row.kind as SolutionSourceKind,
    label: row.label,
    homepageUrl: row.homepageUrl,
    enabled: row.enabled,
    allowedFields: (row.allowedFields ?? []) as string[],
    geography: row.geography,
    ownerContact: row.ownerContact,
    rateLimitPerHour: row.rateLimitPerHour,
    refreshIntervalHours: row.refreshIntervalHours,
    retentionDays: row.retentionDays,
    termsReviewedAt: row.termsReviewedAt,
    termsReviewedBy: row.termsReviewedBy,
    registerNotes: row.registerNotes,
    attributionRequired: row.attributionRequired,
    attributionText: row.attributionText,
    attributionUrl: row.attributionUrl,
    maxRequestsPerDay: row.maxRequestsPerDay,
    updatedAt: row.updatedAt,
  }
}

// ── Ingestion (worker) ─────────────────────────────────────────────────────────────────────────

/** Canonical hash over the metadata a version carries, so key order cannot fake a change. */
export function computeComponentContentHash(metadata: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(metadata)).digest('hex')
}

export interface IngestComponentInput {
  kind: ComponentKind
  slug: string
  displayName: string
  sourceKey: string
  externalId?: string | null
  homepageUrl?: string | null
  metadata: Record<string, unknown>
  observedAt?: Date
}

export type IngestComponentOutcome =
  | { status: 'created'; componentId: string; version: number }
  /** Metadata changed: the previous version was closed and a new one opened. */
  | { status: 'versioned'; componentId: string; version: number }
  /** Byte-identical metadata. No version minted, nothing to do. */
  | { status: 'unchanged'; componentId: string; version: number }
  /** The source is registered but switched off. Ingestion refuses rather than quietly proceeding. */
  | { status: 'source_disabled' }

/**
 * Upserts a component and appends a version when its metadata actually changed.
 *
 * Refuses outright when the source is disabled. That check is here, in the only write path, rather
 * than left to each adapter — an adapter that forgot it would silently keep ingesting from a source
 * the operator had just switched off, which is the precise failure the kill switch exists to prevent.
 *
 * Version bookkeeping closes the previous window before opening the next, because
 * `solution_component_versions_no_overlap` makes two simultaneously-current versions impossible. That
 * ordering is not incidental — inserting first would fail.
 */
export async function ingestComponentVersion(
  input: IngestComponentInput,
  db: PostgresJsDatabase = workerDb,
): Promise<IngestComponentOutcome> {
  const observedAt = input.observedAt ?? new Date()
  const contentHash = computeComponentContentHash(input.metadata)

  return db.transaction(async (tx) => {
    const [source] = await tx
      .select({ enabled: solutionSources.enabled, kind: solutionSources.kind })
      .from(solutionSources)
      .where(eq(solutionSources.key, input.sourceKey))
      .limit(1)
    if (!source?.enabled) return { status: 'source_disabled' } as const

    /**
     * Whether a newly ingested component is immediately visible to retrieval, decided by who asserted
     * it exists.
     *
     * `lifecycle_state` defaults to `draft` and `findCandidateComponents` reads only `active`. Nothing
     * promoted anything, so the eighteen components ingested from real sources were invisible to
     * retrieval and always would have been — the catalog worked and answered nothing.
     *
     * The line is authorship. When Hugging Face's own API says a model exists, that is a publisher
     * describing its own thing, and requiring a human to confirm each of thousands means the catalog
     * stays empty forever. When we inferred a component from a crawled page, *we* asserted it, and that
     * deserves review before it becomes advice.
     *
     * This weakens no claim gate. Being listed is not a claim about what a component can do: capability
     * claims still enter at `claimed` and only a human raises them, and a similarity-derived
     * compatibility edge still cannot activate itself. Those are the gates that decide advice.
     */
    const lifecycleState = source.kind === 'official_api' || source.kind === 'feed' || source.kind === 'licensed_dataset'
      ? 'active'
      : 'draft'

    const [existing] = await tx
      .select({ id: solutionComponents.id })
      .from(solutionComponents)
      .where(and(eq(solutionComponents.kind, input.kind), eq(solutionComponents.slug, input.slug)))
      .limit(1)

    const componentId = existing?.id ?? randomId()
    if (existing) {
      await tx
        .update(solutionComponents)
        .set({ displayName: input.displayName, homepageUrl: input.homepageUrl ?? null, updatedAt: observedAt })
        .where(eq(solutionComponents.id, componentId))
    } else {
      await tx.insert(solutionComponents).values({
        id: componentId,
        kind: input.kind,
        slug: input.slug,
        displayName: input.displayName,
        sourceKey: input.sourceKey,
        externalId: input.externalId ?? null,
        homepageUrl: input.homepageUrl ?? null,
        lifecycleState,
        createdAt: observedAt,
        updatedAt: observedAt,
      })
    }

    const [sameContent] = await tx
      .select({ version: solutionComponentVersions.version })
      .from(solutionComponentVersions)
      .where(and(
        eq(solutionComponentVersions.componentId, componentId),
        eq(solutionComponentVersions.contentHash, contentHash),
      ))
      .limit(1)
    if (sameContent) return { status: 'unchanged', componentId, version: sameContent.version } as const

    const [current] = await tx
      .select({ version: solutionComponentVersions.version })
      .from(solutionComponentVersions)
      .where(and(eq(solutionComponentVersions.componentId, componentId), isNull(solutionComponentVersions.validUntil)))
      .orderBy(desc(solutionComponentVersions.version))
      .limit(1)

    if (current) {
      await tx
        .update(solutionComponentVersions)
        .set({ validUntil: observedAt })
        .where(and(
          eq(solutionComponentVersions.componentId, componentId),
          eq(solutionComponentVersions.version, current.version),
        ))
    }

    const [{ next }] = await tx.execute<{ next: number }>(sql`
      select coalesce(max(version), 0) + 1 as next
      from solution_component_versions where component_id = ${componentId}
    `)
    await tx.insert(solutionComponentVersions).values({
      componentId,
      version: next,
      metadata: input.metadata,
      contentHash,
      observedAt,
      validFrom: observedAt,
    })

    return { status: existing ? 'versioned' : 'created', componentId, version: next } as const
  })
}

export async function recordEvidence(
  input: {
    sourceKey: string
    componentId?: string | null
    kind: 'official_metadata' | 'benchmark' | 'documentation' | 'production_report' | 'manual_review'
    sourceUrl?: string | null
    payload: Record<string, unknown>
    observedAt?: Date
    expiresAt?: Date | null
  },
  db: PostgresJsDatabase = workerDb,
): Promise<{ evidenceId: string; created: boolean }> {
  const observedAt = input.observedAt ?? new Date()
  const contentHash = createHash('sha256')
    .update(canonicalJson({ sourceKey: input.sourceKey, componentId: input.componentId ?? null, payload: input.payload }))
    .digest('hex')

  const id = randomId()
  const inserted = await db
    .insert(solutionEvidence)
    .values({
      id,
      sourceKey: input.sourceKey,
      componentId: input.componentId ?? null,
      kind: input.kind,
      sourceUrl: input.sourceUrl ?? null,
      contentHash,
      payload: input.payload,
      observedAt,
      expiresAt: input.expiresAt ?? null,
    })
    // Re-observing the same evidence is a no-op, so a refresh cycle does not duplicate it.
    .onConflictDoNothing({ target: [solutionEvidence.sourceKey, solutionEvidence.contentHash] })
    .returning({ id: solutionEvidence.id })
  if (inserted.length > 0) return { evidenceId: inserted[0].id, created: true }

  const [existing] = await db
    .select({ id: solutionEvidence.id })
    .from(solutionEvidence)
    .where(and(eq(solutionEvidence.sourceKey, input.sourceKey), eq(solutionEvidence.contentHash, contentHash)))
    .limit(1)
  return { evidenceId: existing.id, created: false }
}

/**
 * Attaches a capability claim to one version of a component.
 *
 * `onConflictDoNothing`, not `DoUpdate`, and the reason is both a privilege and a policy:
 *
 * - **Privilege.** Postgres decides which grants a statement needs statically, from the statement, not
 *   from whether a conflict actually occurs. `INSERT ... ON CONFLICT DO UPDATE` therefore requires
 *   UPDATE on the table, and migration 0125 deliberately gives the worker only INSERT and SELECT here.
 *   Every ingestion run failed with `42501: permission denied for table
 *   solution_component_capabilities` on its first claim — including runs where no row conflicted.
 *
 * - **Policy, which is why the fix is here and not a new grant.** A claim keyed by
 *   `(component, version, capability)` is immutable content: if anything a source says about a component
 *   changed, its content hash changed, so it is a *new version* and a new key. Nothing legitimate
 *   overwrites a claim in place. Meanwhile a claim's `evidence_level` is exactly what a human raises to
 *   `verified` after checking, so a worker with UPDATE here could silently push a verified claim back
 *   down to `claimed`. Promotion belongs to the platform role, which does hold UPDATE.
 *
 * The consequence is that `claimId` is only returned when a row was actually written. A conflict means
 * the claim is already recorded with the evidence that established it, which is the correct outcome and
 * not something a caller needs to react to.
 */
export async function attachCapabilityClaim(
  input: {
    componentId: string
    componentVersion: number
    capabilityKey: string
    evidenceLevel: CapabilityEvidenceLevel
    primaryEvidenceId: string
  },
  db: PostgresJsDatabase = workerDb,
): Promise<{ claimId: string | null }> {
  const id = randomId()
  const [row] = await db
    .insert(solutionComponentCapabilities)
    .values({ id, ...input })
    .onConflictDoNothing({
      target: [
        solutionComponentCapabilities.componentId,
        solutionComponentCapabilities.componentVersion,
        solutionComponentCapabilities.capabilityKey,
      ],
    })
    .returning({ id: solutionComponentCapabilities.id })
  return { claimId: row?.id ?? null }
}

// ── Compatibility edges ────────────────────────────────────────────────────────────────────────

/**
 * Records a compatibility edge.
 *
 * `semantic_similarity_reviewed` always lands `proposed`, never `active` — the same rule
 * `link-policy.ts` applies to identity, and the database enforces it too
 * (`solution_edges_similarity_needs_review_check`). Officially-documented and manually-reviewed edges
 * may go straight to active, because neither is a guess.
 */
export async function recordCompatibilityEdge(
  input: {
    edgeType: CompatibilityEdgeType
    fromComponentId: string
    toComponentId: string
    discoveryMethod: 'manual_review' | 'official_metadata' | 'semantic_similarity_reviewed'
    primaryEvidenceId: string
    confidenceBps?: number
    constraints?: Record<string, unknown>
  },
  db: PostgresJsDatabase = workerDb,
): Promise<{ edgeId: string; status: 'proposed' | 'active' }> {
  const status = input.discoveryMethod === 'semantic_similarity_reviewed' ? 'proposed' : 'active'
  const id = randomId()
  await db.insert(solutionCompatibilityEdges).values({
    id,
    edgeType: input.edgeType,
    fromComponentId: input.fromComponentId,
    toComponentId: input.toComponentId,
    discoveryMethod: input.discoveryMethod,
    status,
    primaryEvidenceId: input.primaryEvidenceId,
    confidenceBps: input.confidenceBps ?? 0,
    constraints: input.constraints ?? {},
  })
  return { edgeId: id, status }
}

/**
 * A reviewer activates a proposed edge. Platform role only, and the only route by which a
 * similarity-derived edge ever becomes traversable.
 *
 * Returns false when the edge is no longer proposed — another reviewer decided first. Surfaced rather
 * than retried, for the same reason as the identity review queue: silently overwriting someone's
 * decision is what a review queue must not do.
 */
export async function activateCompatibilityEdge(
  input: { edgeId: string; reviewerUserId: string; at?: Date },
  db: PostgresJsDatabase = platformDb,
): Promise<boolean> {
  const at = input.at ?? new Date()
  const updated = await db
    .update(solutionCompatibilityEdges)
    .set({ status: 'active', reviewedByUserId: input.reviewerUserId, reviewedAt: at, lastVerifiedAt: at, updatedAt: at })
    .where(and(eq(solutionCompatibilityEdges.id, input.edgeId), eq(solutionCompatibilityEdges.status, 'proposed')))
    .returning({ id: solutionCompatibilityEdges.id })
  return updated.length > 0
}

export interface TraversableEdge {
  edgeId: string
  edgeType: string
  toComponentId: string
  confidenceBps: number
  constraints: Record<string, unknown>
  primaryEvidenceId: string
}

/**
 * The composer's traversal read: live edges out of one component.
 *
 * Filters on `status = 'active' and valid_until is null` in SQL, not in JS. A withdrawn or merely
 * proposed edge reaching the composer would put an unreviewed combination into a recommendation, so
 * the narrowing belongs where it cannot be forgotten by a caller.
 */
export async function listTraversableEdges(
  fromComponentId: string,
  edgeTypes: readonly CompatibilityEdgeType[] | undefined,
  db: PostgresJsDatabase = publicDb,
): Promise<TraversableEdge[]> {
  const conditions = [
    eq(solutionCompatibilityEdges.fromComponentId, fromComponentId),
    eq(solutionCompatibilityEdges.status, 'active'),
    isNull(solutionCompatibilityEdges.validUntil),
  ]
  if (edgeTypes?.length) conditions.push(inArray(solutionCompatibilityEdges.edgeType, [...edgeTypes]))

  const rows = await db
    .select({
      edgeId: solutionCompatibilityEdges.id,
      edgeType: solutionCompatibilityEdges.edgeType,
      toComponentId: solutionCompatibilityEdges.toComponentId,
      confidenceBps: solutionCompatibilityEdges.confidenceBps,
      constraints: solutionCompatibilityEdges.constraints,
      primaryEvidenceId: solutionCompatibilityEdges.primaryEvidenceId,
    })
    .from(solutionCompatibilityEdges)
    .where(and(...conditions))
    .orderBy(desc(solutionCompatibilityEdges.confidenceBps))
  return rows.map((row) => ({ ...row, constraints: (row.constraints ?? {}) as Record<string, unknown> }))
}

export interface CatalogComponentSummary {
  componentId: string
  kind: ComponentKind
  slug: string
  displayName: string
  homepageUrl: string | null
  version: number
  metadata: Record<string, unknown>
  capabilities: Array<{ capabilityKey: string; evidenceLevel: CapabilityEvidenceLevel }>
}

/**
 * Retrieval's candidate read: currently-valid components of the given kinds that claim at least one
 * of the given capabilities, with the evidence level of each claim.
 *
 * Only `lifecycle_state = 'active'` components and only their currently-valid version — a draft or
 * withdrawn component must never appear in advice, and citing a closed version would make the run
 * irreproducible.
 */
export async function findCandidateComponents(
  input: { kinds: readonly ComponentKind[]; capabilityKeys: readonly string[]; limit?: number },
  db: PostgresJsDatabase = publicDb,
): Promise<CatalogComponentSummary[]> {
  if (input.kinds.length === 0 || input.capabilityKeys.length === 0) return []

  const rows = await db
    .select({
      componentId: solutionComponents.id,
      kind: solutionComponents.kind,
      slug: solutionComponents.slug,
      displayName: solutionComponents.displayName,
      homepageUrl: solutionComponents.homepageUrl,
      version: solutionComponentVersions.version,
      metadata: solutionComponentVersions.metadata,
      capabilityKey: solutionComponentCapabilities.capabilityKey,
      evidenceLevel: solutionComponentCapabilities.evidenceLevel,
    })
    .from(solutionComponents)
    .innerJoin(solutionComponentVersions, and(
      eq(solutionComponentVersions.componentId, solutionComponents.id),
      isNull(solutionComponentVersions.validUntil),
    ))
    .innerJoin(solutionComponentCapabilities, and(
      eq(solutionComponentCapabilities.componentId, solutionComponentVersions.componentId),
      eq(solutionComponentCapabilities.componentVersion, solutionComponentVersions.version),
    ))
    .where(and(
      eq(solutionComponents.lifecycleState, 'active'),
      inArray(solutionComponents.kind, [...input.kinds]),
      inArray(solutionComponentCapabilities.capabilityKey, [...input.capabilityKeys]),
    ))
    .orderBy(asc(solutionComponents.id))
    .limit(input.limit ?? 500)

  // One row per (component, capability); fold into one entry per component.
  const byComponent = new Map<string, CatalogComponentSummary>()
  for (const row of rows) {
    const existing = byComponent.get(row.componentId)
    const claim = { capabilityKey: row.capabilityKey, evidenceLevel: row.evidenceLevel as CapabilityEvidenceLevel }
    if (existing) {
      existing.capabilities.push(claim)
    } else {
      byComponent.set(row.componentId, {
        componentId: row.componentId,
        kind: row.kind as ComponentKind,
        slug: row.slug,
        displayName: row.displayName,
        homepageUrl: row.homepageUrl,
        version: row.version,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        capabilities: [claim],
      })
    }
  }
  return [...byComponent.values()]
}

/**
 * The catalog's own claims for a set of `componentId@version` evidence ids (plan 43 Phase 8).
 *
 * These are what a route explanation is allowed to cite, and nothing else — `explainRoute` is handed the
 * snippets for its own components so there is no adjacent claim it could reach for.
 *
 * The id shape is the composer's: `${componentId}@${version}`. It is not a `solution_evidence.id`, and the
 * difference matters. A route cites the *component version* it recommends, which is stable and resolvable; a
 * single evidence row is one observation behind one claim, and citing it would make an explanation's citations
 * narrower than the recommendation they support.
 */
export interface ComponentClaimSnippet {
  evidenceId: string
  displayName: string
  claim: string
  evidenceLevel: CapabilityEvidenceLevel
}

export async function listComponentClaimSnippets(
  evidenceIds: readonly string[],
  db: PostgresJsDatabase = publicDb,
): Promise<ComponentClaimSnippet[]> {
  const parsed = evidenceIds
    .map((id) => {
      const at = id.lastIndexOf('@')
      if (at <= 0) return null
      const version = Number(id.slice(at + 1))
      return Number.isInteger(version) ? { componentId: id.slice(0, at), version } : null
    })
    .filter((entry): entry is { componentId: string; version: number } => entry !== null)
  if (parsed.length === 0) return []

  const rows = await db
    .select({
      componentId: solutionComponentCapabilities.componentId,
      version: solutionComponentCapabilities.componentVersion,
      capabilityKey: solutionComponentCapabilities.capabilityKey,
      evidenceLevel: solutionComponentCapabilities.evidenceLevel,
      displayName: solutionComponents.displayName,
    })
    .from(solutionComponentCapabilities)
    .innerJoin(solutionComponents, eq(solutionComponents.id, solutionComponentCapabilities.componentId))
    .where(inArray(solutionComponentCapabilities.componentId, parsed.map((entry) => entry.componentId)))
    .orderBy(asc(solutionComponentCapabilities.componentId), asc(solutionComponentCapabilities.capabilityKey))

  const wanted = new Set(parsed.map((entry) => `${entry.componentId}@${entry.version}`))
  const byEvidenceId = new Map<string, ComponentClaimSnippet>()
  for (const row of rows) {
    const evidenceId = `${row.componentId}@${row.version}`
    if (!wanted.has(evidenceId)) continue
    const existing = byEvidenceId.get(evidenceId)
    const claim = `${row.capabilityKey.replace(/_/g, ' ')} (${row.evidenceLevel})`
    if (existing) {
      existing.claim = `${existing.claim}; ${claim}`
      // The weakest level any of the folded claims carries. A component with one verified and one merely claimed
      // capability must not be presented as verified — the explanation quotes this level directly.
      if (evidenceRankFor(row.evidenceLevel) < evidenceRankFor(existing.evidenceLevel)) {
        existing.evidenceLevel = row.evidenceLevel as CapabilityEvidenceLevel
      }
    } else {
      byEvidenceId.set(evidenceId, {
        evidenceId,
        displayName: row.displayName,
        claim,
        evidenceLevel: row.evidenceLevel as CapabilityEvidenceLevel,
      })
    }
  }
  return [...byEvidenceId.values()]
}

const EVIDENCE_ORDER: readonly string[] = ['claimed', 'observed', 'verified', 'production_evidence']
function evidenceRankFor(level: string): number {
  const index = EVIDENCE_ORDER.indexOf(level)
  return index < 0 ? 0 : index
}

/**
 * The attribution obligations a set of cited components carries (plan 43 Phase 8).
 *
 * **A release blocker, not a nicety.** `remoteok_jobs` and `jobicy_jobs` grant access on the condition that
 * their attribution is displayed, recorded verbatim in `solution_sources.attribution_text` when those sources
 * were registered (migration 0132). A surface that shows their data without the notice loses the access — so
 * this is derived from the same rows the composer drew on, rather than hard-coded into a component where it
 * could drift out of step with which sources a run actually used.
 *
 * Returns one entry per source, not per component: three postings from one feed are one obligation.
 */
export interface SourceAttribution {
  sourceKey: string
  text: string
  url: string
}

export async function listAttributionsForEvidence(
  evidenceIds: readonly string[],
  db: PostgresJsDatabase = publicDb,
): Promise<SourceAttribution[]> {
  const componentIds = [...new Set(evidenceIds
    .map((id) => (id.lastIndexOf('@') > 0 ? id.slice(0, id.lastIndexOf('@')) : null))
    .filter((id): id is string => id !== null))]
  if (componentIds.length === 0) return []

  const rows = await db
    .select({
      sourceKey: solutionSources.key,
      attributionRequired: solutionSources.attributionRequired,
      attributionText: solutionSources.attributionText,
      attributionUrl: solutionSources.attributionUrl,
    })
    .from(solutionComponents)
    .innerJoin(solutionSources, eq(solutionSources.key, solutionComponents.sourceKey))
    .where(inArray(solutionComponents.id, componentIds))
    .groupBy(solutionSources.key, solutionSources.attributionRequired, solutionSources.attributionText, solutionSources.attributionUrl)

  return rows
    .filter((row) => row.attributionRequired && row.attributionText && row.attributionUrl)
    .map((row) => ({ sourceKey: row.sourceKey, text: row.attributionText!, url: row.attributionUrl! }))
    .sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : 1))
}
