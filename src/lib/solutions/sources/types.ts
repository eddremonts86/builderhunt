/**
 * Contract every Solutions catalog adapter implements (plan 43 — solutions-intelligence Phase 4,
 * "Create official metadata adapters" and "Extend compliant public crawl/scrape ingestion").
 *
 * One shape for all acquisition modes on purpose. An official API and a compliant crawl differ in how
 * they fetch, not in what the catalog is allowed to store or in which safety envelope applies — so the
 * ingestion runner can treat them identically and no adapter gets to opt out of the register, the
 * allowlist, or the kill switch.
 */
import type { CapabilityEvidenceLevel, ComponentKind } from '~/shared/lib/solutions/contracts'

/** One component an adapter found, already minimized to what its source register entry permits. */
export interface AdapterComponent {
  kind: ComponentKind
  /** Stable within the source. Becomes `solution_components.slug`. */
  slug: string
  displayName: string
  /** The component's id at the source, when it has one. */
  externalId?: string | null
  homepageUrl?: string | null
  /** Metadata to version. Only keys the source's `allowed_fields` permits survive the runner. */
  metadata: Record<string, unknown>
  /** Capabilities this component *claims*. Never promoted above `claimed` by an adapter — raising a
   * claim to `verified` requires evidence a human or a benchmark produced, not a vendor's own blurb. */
  capabilities: Array<{ capabilityKey: string; evidenceLevel: Extract<CapabilityEvidenceLevel, 'claimed' | 'observed'> }>
  /** Where a reviewer can go and check this. */
  sourceUrl?: string | null
  observedAt?: Date
}

export type AdapterOutcome =
  | { kind: 'components'; components: AdapterComponent[] }
  /** Upstream said "slow down" or was unavailable. The runner retries later; not a failure. */
  | { kind: 'retry'; reason: 'rate_limited' | 'upstream_unavailable'; detail?: string }
  /** The adapter cannot proceed and retrying will not help — a schema change, a revoked key. */
  | { kind: 'failed'; reason: string }

export interface AdapterContext {
  /** Exact hosts this adapter may contact. Passed to `safeFetch`, which enforces it. */
  allowedHosts: readonly string[]
  /** Bound by the runner, not the adapter. */
  signal: AbortSignal
  /** Bounded page/query size, so one adapter run cannot fetch unboundedly. */
  limit: number
}

export interface SolutionSourceAdapter {
  /** Must equal a `solution_sources.key`. The runner refuses to run an adapter with no register row. */
  readonly sourceKey: string
  /** How this adapter acquires data. Drives which extra gates the runner applies. */
  readonly acquisitionMode: 'official_api' | 'feed' | 'public_scrape'
  /** Hosts the adapter needs. The runner intersects these with the register's own entry. */
  readonly requiredHosts: readonly string[]
  collect(context: AdapterContext): Promise<AdapterOutcome>
}
