/**
 * The single entry point that runs a catalog adapter (plan 43 Phase 4).
 *
 * Every gate lives here rather than in each adapter, because a gate an adapter has to remember is a
 * gate that eventually gets forgotten:
 *
 *   1. The source must exist in `solution_sources` — an adapter with no register row cannot run.
 *   2. The source must be `enabled`. This is the kill switch, and it is read per run, so switching a
 *      source off stops the next run without a deploy.
 *   3. The adapter's declared kind must match the register's. An adapter that says `official_api` while
 *      its register entry says `public_scrape` is a mismatch worth refusing, not reconciling.
 *   4. Hosts are the intersection of what the adapter needs and what the register permits, and the
 *      result is what `safeFetch` enforces. An adapter cannot widen its own allowlist.
 *   5. Metadata is filtered to the register's `allowed_fields` before anything is stored.
 *
 * Rule 5 is the one that makes the register meaningful rather than decorative: an adapter can return
 * whatever it likes and only the reviewed fields survive.
 */
import { findSolutionSource, ingestComponentVersion, recordEvidence, attachCapabilityClaim } from '~/shared/lib/repositories/solution-catalog'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { workerDb } from '~/shared/lib/db/worker-db'
import { publicDb } from '~/shared/lib/db/client'
import { log } from '~/shared/lib/log'
import type { AdapterComponent, SolutionSourceAdapter } from './types'

export interface RunAdapterOptions {
  limit?: number
  timeoutMs?: number
  /** Reads the register through the app role; writes go through the worker role. Split so a test can
   * point both at one disposable database. */
  readDb?: PostgresJsDatabase
  writeDb?: PostgresJsDatabase
}

export type RunAdapterResult =
  | {
      status: 'completed'
      sourceKey: string
      created: number
      versioned: number
      unchanged: number
      /** Components the adapter returned that the register's allowed_fields left with no usable
       * metadata at all. Counted rather than silently dropped — a non-zero value means the adapter and
       * its register entry disagree about what this source publishes. */
      emptyAfterFieldFilter: number
    }
  | { status: 'skipped'; sourceKey: string; reason: 'source_not_registered' | 'source_disabled' | 'mode_mismatch' }
  | { status: 'retry'; sourceKey: string; reason: 'rate_limited' | 'upstream_unavailable' }
  | { status: 'failed'; sourceKey: string; reason: string }

const DEFAULT_LIMIT = 50
const DEFAULT_TIMEOUT_MS = 30_000

export async function runSolutionSourceAdapter(
  adapter: SolutionSourceAdapter,
  options: RunAdapterOptions = {},
): Promise<RunAdapterResult> {
  const readDb = options.readDb ?? publicDb
  const writeDb = options.writeDb ?? workerDb

  const source = await findSolutionSource(adapter.sourceKey, readDb)
  if (!source) {
    // An unregistered adapter is a programming error, not a transient condition: nothing recorded what
    // this source is, who reviewed it, or what it may store.
    log.warn('solutions_adapter_unregistered', { sourceKey: adapter.sourceKey })
    return { status: 'skipped', sourceKey: adapter.sourceKey, reason: 'source_not_registered' }
  }
  if (!source.enabled) {
    return { status: 'skipped', sourceKey: adapter.sourceKey, reason: 'source_disabled' }
  }
  if (source.kind !== adapter.acquisitionMode) {
    log.warn('solutions_adapter_mode_mismatch', {
      sourceKey: adapter.sourceKey, registerKind: source.kind, adapterMode: adapter.acquisitionMode,
    })
    return { status: 'skipped', sourceKey: adapter.sourceKey, reason: 'mode_mismatch' }
  }

  // The adapter declares what it needs; the register decides what is permitted. Only the overlap is
  // passed to safeFetch, so an adapter cannot reach a host nobody approved by asking for it.
  const registerHosts = registerAllowedHosts(source.homepageUrl, adapter.requiredHosts)
  const allowedHosts = adapter.requiredHosts.filter((host) => registerHosts.includes(host))
  if (allowedHosts.length === 0) {
    return { status: 'failed', sourceKey: adapter.sourceKey, reason: 'no_permitted_host' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let outcome
  try {
    outcome = await adapter.collect({
      allowedHosts,
      signal: controller.signal,
      limit: options.limit ?? DEFAULT_LIMIT,
    })
  } catch (error) {
    return { status: 'failed', sourceKey: adapter.sourceKey, reason: error instanceof Error ? error.message : 'unknown' }
  } finally {
    clearTimeout(timer)
  }

  if (outcome.kind === 'retry') return { status: 'retry', sourceKey: adapter.sourceKey, reason: outcome.reason }
  if (outcome.kind === 'failed') return { status: 'failed', sourceKey: adapter.sourceKey, reason: outcome.reason }

  let created = 0
  let versioned = 0
  let unchanged = 0
  let emptyAfterFieldFilter = 0

  for (const component of outcome.components) {
    const metadata = filterToAllowedFields(component.metadata, source.allowedFields)
    if (Object.keys(metadata).length === 0) {
      emptyAfterFieldFilter += 1
      continue
    }

    const ingested = await ingestComponentVersion({
      kind: component.kind,
      slug: component.slug,
      displayName: component.displayName,
      sourceKey: adapter.sourceKey,
      externalId: component.externalId ?? null,
      homepageUrl: component.homepageUrl ?? null,
      metadata,
      observedAt: component.observedAt,
    }, writeDb)

    if (ingested.status === 'source_disabled') {
      // The operator switched the source off mid-run. Stop rather than finish the batch — the whole
      // point of an immediate kill switch is that it does not wait for the current job to drain.
      log.warn('solutions_adapter_disabled_mid_run', { sourceKey: adapter.sourceKey })
      break
    }
    if (ingested.status === 'created') created += 1
    else if (ingested.status === 'versioned') versioned += 1
    else unchanged += 1

    // Only attach claims for content that actually changed. Re-attaching identical claims on every
    // unchanged refresh would rewrite `primary_evidence_id` for no reason.
    if (ingested.status !== 'unchanged' && component.capabilities.length > 0) {
      const evidence = await recordEvidence({
        sourceKey: adapter.sourceKey,
        componentId: ingested.componentId,
        kind: adapter.acquisitionMode === 'public_scrape' ? 'documentation' : 'official_metadata',
        sourceUrl: component.sourceUrl ?? null,
        payload: metadata,
        observedAt: component.observedAt,
      }, writeDb)

      for (const claim of component.capabilities) {
        await attachCapabilityClaim({
          componentId: ingested.componentId,
          componentVersion: ingested.version,
          capabilityKey: claim.capabilityKey,
          evidenceLevel: claim.evidenceLevel,
          primaryEvidenceId: evidence.evidenceId,
        }, writeDb)
      }
    }
  }

  log.info('solutions_adapter_run', {
    sourceKey: adapter.sourceKey, created, versioned, unchanged, emptyAfterFieldFilter,
  })
  return { status: 'completed', sourceKey: adapter.sourceKey, created, versioned, unchanged, emptyAfterFieldFilter }
}

/**
 * Hosts the register permits: the homepage's own host, plus any adapter-declared host that is the same
 * registrable site.
 *
 * Conservative on purpose — a register entry naming `huggingface.co` does not silently authorise
 * `cdn.some-other-domain.com` just because an adapter asked for it. A source needing an extra host is
 * a register change, which is a reviewed act.
 */
function registerAllowedHosts(homepageUrl: string, requested: readonly string[]): string[] {
  let homepageHost: string
  try {
    homepageHost = new URL(homepageUrl).hostname.toLowerCase()
  } catch {
    return []
  }
  const permitted = new Set<string>([homepageHost])
  for (const host of requested) {
    const candidate = host.toLowerCase()
    if (candidate === homepageHost || candidate.endsWith(`.${homepageHost}`) || homepageHost.endsWith(`.${candidate}`)) {
      permitted.add(candidate)
    }
  }
  return [...permitted]
}

/**
 * Keeps only the keys the register's `allowed_fields` lists.
 *
 * This is where the source register stops being paperwork. An adapter can return anything; if the
 * reviewed entry does not name a field, it does not reach the database — so widening what a source
 * contributes requires editing the register, not the adapter.
 */
export function filterToAllowedFields(
  metadata: Record<string, unknown>,
  allowedFields: readonly string[],
): Record<string, unknown> {
  if (allowedFields.length === 0) return {}
  const allowed = new Set(allowedFields)
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (allowed.has(key) && value !== null && value !== undefined) filtered[key] = value
  }
  return filtered
}

/** Every adapter the runner knows about. A source with no adapter simply never ingests. */
export const SOLUTION_ADAPTERS: readonly string[] = ['huggingface_models', 'npm_registry']
