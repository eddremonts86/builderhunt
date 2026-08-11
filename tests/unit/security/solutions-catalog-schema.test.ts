/**
 * plans/implemented/43-solutions-intelligence Phase 4, "Add catalog, graph, evidence, and source-policy
 * schema". Verify line: "constraints reject active unsupported edges, dangling evidence, overlapping
 * invalid versions, tenant fields in public records, and workerless writes."
 *
 * All five, asserted against a real migrated database rather than through a repository, because the
 * property that matters is that *no* code path can violate them — including one written next year
 * that inserts directly. The composer turns active edges into advice a human acts on, so "an
 * unreviewed guess cannot become active" has to be a constraint, not a convention.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('solutions_catalog')
  db = disposable.db
  drop = disposable.drop
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.execute(sql`
    truncate solution_component_capabilities, solution_compatibility_edges, solution_evidence,
             solution_component_versions, solution_components, solution_capabilities, solution_sources cascade
  `)
  await db.execute(sql`
    insert into solution_sources (key, kind, label, homepage_url, allowed_fields)
    values ('api', 'official_api', 'API', 'https://api.test', '["name"]');
    insert into solution_capabilities (key, label) values ('translation', 'Translation');
    insert into solution_components (id, kind, slug, display_name, source_key)
    values ('c-model', 'model', 'm', 'M', 'api'), ('c-tool', 'tool', 't', 'T', 'api');
    insert into solution_component_versions (component_id, version, metadata, content_hash, observed_at)
    values ('c-model', 1, '{}', 'h1', now());
    insert into solution_evidence (id, source_key, component_id, kind, content_hash, payload, observed_at)
    values ('ev-1', 'api', 'c-model', 'official_metadata', 'eh1', '{}', now());
  `)
})

/** Asserts the write was refused by a named constraint, walking drizzle's wrapped cause chain. */
async function expectRefusedBy(write: Promise<unknown>, constraint: string): Promise<void> {
  let thrown: unknown
  try { await write } catch (error) { thrown = error }
  expect(thrown, `expected ${constraint} to refuse this write`).toBeDefined()
  const seen: string[] = []
  for (let e = thrown; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    const name = (e as { constraint_name?: unknown }).constraint_name
    if (typeof name === 'string') seen.push(name)
    seen.push(e.message)
  }
  expect(seen.join('\n')).toContain(constraint)
}

describe('an unreviewed guess cannot become active advice', () => {
  it('refuses a similarity-derived edge that goes active with no reviewer', async () => {
    // spec.md: "Semantic similarity can propose an edge for review but cannot activate it." The
    // composer only traverses active edges, so this is the difference between suggesting a
    // combination someone checked and one a cosine distance invented.
    await expectRefusedBy(db.execute(sql`
      insert into solution_compatibility_edges (id, edge_type, from_component_id, to_component_id, discovery_method, status, primary_evidence_id)
      values ('e1', 'integrates_with', 'c-model', 'c-tool', 'semantic_similarity_reviewed', 'active', 'ev-1')
    `), 'solution_edges_similarity_needs_review_check')
  })

  it('accepts the same edge as a proposal', async () => {
    await db.execute(sql`
      insert into solution_compatibility_edges (id, edge_type, from_component_id, to_component_id, discovery_method, status, primary_evidence_id)
      values ('e1', 'integrates_with', 'c-model', 'c-tool', 'semantic_similarity_reviewed', 'proposed', 'ev-1')
    `)
    const rows = await db.execute<{ status: string }>(sql`select status from solution_compatibility_edges`)
    expect(rows[0].status).toBe('proposed')
  })

  it('accepts it as active once a reviewer is named', async () => {
    await db.execute(sql`
      insert into auth_users (id, name, email, email_verified, created_at, updated_at)
      values ('rev', 'R', 'rev@test.invalid', true, now(), now())
    `)
    await db.execute(sql`
      insert into solution_compatibility_edges (id, edge_type, from_component_id, to_component_id, discovery_method, status, primary_evidence_id, reviewed_by_user_id, reviewed_at)
      values ('e1', 'integrates_with', 'c-model', 'c-tool', 'semantic_similarity_reviewed', 'active', 'ev-1', 'rev', now())
    `)
    const rows = await db.execute<{ status: string }>(sql`select status from solution_compatibility_edges`)
    expect(rows[0].status).toBe('active')
  })

  it('lets an officially-documented edge go active without review', async () => {
    // Evidence from the vendor's own metadata is not a guess, so it needs no second opinion.
    await db.execute(sql`
      insert into solution_compatibility_edges (id, edge_type, from_component_id, to_component_id, discovery_method, status, primary_evidence_id)
      values ('e1', 'hosted_by', 'c-model', 'c-tool', 'official_metadata', 'active', 'ev-1')
    `)
    const rows = await db.execute<{ count: number }>(sql`select count(*)::int as count from solution_compatibility_edges where status='active'`)
    expect(rows[0].count).toBe(1)
  })

  it('refuses a self-loop, which no relationship type can mean', async () => {
    await expectRefusedBy(db.execute(sql`
      insert into solution_compatibility_edges (id, edge_type, from_component_id, to_component_id, discovery_method, primary_evidence_id)
      values ('e1', 'requires', 'c-model', 'c-model', 'manual_review', 'ev-1')
    `), 'solution_edges_no_self_loop_check')
  })

  it('allows only one live edge per (from, to, type) but does not let history block a retry', async () => {
    await db.execute(sql`
      insert into solution_compatibility_edges (id, edge_type, from_component_id, to_component_id, discovery_method, status, primary_evidence_id)
      values ('e1', 'requires', 'c-model', 'c-tool', 'manual_review', 'active', 'ev-1')
    `)
    await expectRefusedBy(db.execute(sql`
      insert into solution_compatibility_edges (id, edge_type, from_component_id, to_component_id, discovery_method, status, primary_evidence_id)
      values ('e2', 'requires', 'c-model', 'c-tool', 'manual_review', 'active', 'ev-1')
    `), 'solution_edges_active_unique')

    // Withdraw the first, and a corrected edge is accepted — the index is partial for this reason.
    await db.execute(sql`update solution_compatibility_edges set valid_until = now() where id = 'e1'`)
    await db.execute(sql`
      insert into solution_compatibility_edges (id, edge_type, from_component_id, to_component_id, discovery_method, status, primary_evidence_id)
      values ('e2', 'requires', 'c-model', 'c-tool', 'manual_review', 'active', 'ev-1')
    `)
    const rows = await db.execute<{ count: number }>(sql`select count(*)::int as count from solution_compatibility_edges`)
    expect(rows[0].count).toBe(2)
  })
})

describe('evidence cannot dangle', () => {
  it('refuses a capability claim citing evidence that does not exist', async () => {
    await expectRefusedBy(db.execute(sql`
      insert into solution_component_capabilities (id, component_id, component_version, capability_key, evidence_level, primary_evidence_id)
      values ('cc1', 'c-model', 1, 'translation', 'verified', 'nope')
    `), 'solution_component_capabilities_primary_evidence_id_fkey')
  })

  it('refuses to purge evidence a live claim still cites', async () => {
    await db.execute(sql`
      insert into solution_component_capabilities (id, component_id, component_version, capability_key, evidence_level, primary_evidence_id)
      values ('cc1', 'c-model', 1, 'translation', 'verified', 'ev-1')
    `)
    // ON DELETE RESTRICT. A claim whose evidence was purged is indistinguishable from an
    // unsupported assertion, and the UI would still render it as "verified".
    await expectRefusedBy(
      db.execute(sql`delete from solution_evidence where id = 'ev-1'`),
      'solution_component_capabilities_primary_evidence_id_fkey',
    )
    const rows = await db.execute<{ count: number }>(sql`select count(*)::int as count from solution_evidence`)
    expect(rows[0].count).toBe(1)
  })

  it('refuses evidence that expires before it was observed', async () => {
    await expectRefusedBy(db.execute(sql`
      insert into solution_evidence (id, source_key, kind, content_hash, payload, observed_at, expires_at)
      values ('ev-2', 'api', 'benchmark', 'eh2', '{}', now(), now() - interval '1 day')
    `), 'solution_evidence_expiry_order_check')
  })
})

describe('a component has exactly one truth at any instant', () => {
  it('refuses a second open-ended version', async () => {
    // Two "current" versions means "what did we believe when that run executed" has two answers, and
    // a recorded recommendation stops being reproducible.
    await expectRefusedBy(db.execute(sql`
      insert into solution_component_versions (component_id, version, metadata, content_hash, observed_at)
      values ('c-model', 2, '{}', 'h2', now())
    `), 'solution_component_versions_no_overlap')
  })

  it('accepts a new version once the previous one is closed', async () => {
    await db.execute(sql`update solution_component_versions set valid_until = now() where component_id='c-model' and version=1`)
    await db.execute(sql`
      insert into solution_component_versions (component_id, version, metadata, content_hash, observed_at, valid_from)
      values ('c-model', 2, '{}', 'h2', now(), now())
    `)
    const rows = await db.execute<{ count: number }>(sql`select count(*)::int as count from solution_component_versions`)
    expect(rows[0].count).toBe(2)
  })

  it('refuses a version whose window overlaps an already-closed one', async () => {
    await db.execute(sql`update solution_component_versions set valid_until = now() where component_id='c-model' and version=1`)
    await expectRefusedBy(db.execute(sql`
      insert into solution_component_versions (component_id, version, metadata, content_hash, observed_at, valid_from, valid_until)
      values ('c-model', 3, '{}', 'h3', now(), now() - interval '10 days', now() + interval '10 days')
    `), 'solution_component_versions_no_overlap')
  })

  it('refuses a duplicate content hash, so an unchanged refresh mints no version', async () => {
    await db.execute(sql`update solution_component_versions set valid_until = now() where component_id='c-model' and version=1`)
    await expectRefusedBy(db.execute(sql`
      insert into solution_component_versions (component_id, version, metadata, content_hash, observed_at, valid_from)
      values ('c-model', 2, '{}', 'h1', now(), now())
    `), 'solution_component_versions_content_unique')
  })
})

describe('the source register is the kill switch', () => {
  it('refuses to enable a scraping source with no recorded terms review', async () => {
    // The legal gate as a constraint: the admin toggle physically cannot turn on a crawl whose terms
    // nobody signed off. That gate lives in plans/phase-5/01-production-readiness-audit.
    await expectRefusedBy(db.execute(sql`
      insert into solution_sources (key, kind, label, homepage_url, enabled)
      values ('scrape', 'public_scrape', 'S', 'https://s.test', true)
    `), 'solution_sources_scrape_needs_review_check')
  })

  it('allows the same source once the review is recorded', async () => {
    await db.execute(sql`
      insert into solution_sources (key, kind, label, homepage_url, enabled, terms_reviewed_at)
      values ('scrape', 'public_scrape', 'S', 'https://s.test', true, now())
    `)
    const rows = await db.execute<{ enabled: boolean }>(sql`select enabled from solution_sources where key='scrape'`)
    expect(rows[0].enabled).toBe(true)
  })

  it('allows a scraping source to exist while disabled, so it can be registered before review', async () => {
    await db.execute(sql`
      insert into solution_sources (key, kind, label, homepage_url) values ('scrape', 'public_scrape', 'S', 'https://s.test')
    `)
    const rows = await db.execute<{ enabled: boolean }>(sql`select enabled from solution_sources where key='scrape'`)
    // Default false — every source ships off, so enabling one is always an explicit act.
    expect(rows[0].enabled).toBe(false)
  })

  it('refuses an external-link-only source that would store fields', async () => {
    // spec.md routes prohibited sources to link-only records. Storing fields from one would be
    // exactly the ingestion its terms forbid.
    await expectRefusedBy(db.execute(sql`
      insert into solution_sources (key, kind, label, homepage_url, allowed_fields)
      values ('link', 'external_link_only', 'L', 'https://l.test', '["bio"]')
    `), 'solution_sources_link_only_stores_nothing_check')
  })

  it('refuses a component whose source is not registered', async () => {
    await expectRefusedBy(db.execute(sql`
      insert into solution_components (id, kind, slug, display_name, source_key)
      values ('c-x', 'model', 'x', 'X', 'unregistered')
    `), 'solution_components_source_key_fkey')
  })
})

describe('no tenant data, and no request-scoped writes', () => {
  it('has no organization_id column on any catalog table', async () => {
    /**
     * The `solution_*` prefix stopped meaning "catalog" in plan 43 Phase 8: `solution_briefs`,
     * `solution_runs`, `solution_run_routes` and `solution_run_feedback` are tenant-private by design — what an
     * organization asked for, and what it was told, is theirs. So the four are named here rather than the
     * invariant being weakened to a prefix match that would pass for anything.
     *
     * The invariant itself is unchanged and still the important one: a *catalog* fact is not a tenant's
     * property. If `solution_components` or `solution_evidence` grew an organization column, the separation
     * between "what exists" and "what we privately think of it" would quietly collapse.
     */
    const TENANT_OWNED = ['solution_briefs', 'solution_runs', 'solution_run_routes', 'solution_run_feedback']
    const rows = await db.execute<{ offender: string }>(sql`
      select table_name || '.' || column_name as offender
      from information_schema.columns
      where table_schema = 'public' and table_name like 'solution\\_%' and column_name = 'organization_id'
        and table_name <> all(${sql.raw(`array['${TENANT_OWNED.join("','")}']`)})
    `)
    expect([...rows].map((r) => r.offender)).toEqual([])
  })

  it('keeps every tenant-owned Solutions table behind RLS', async () => {
    // The other half of the same rule: the four tables that *do* carry an organization column must all have RLS
    // enabled and forced. A tenant table without RLS is worse than a catalog table with an organization column.
    const rows = await db.execute<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(sql`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relname in ('solution_briefs', 'solution_runs', 'solution_run_routes', 'solution_run_feedback')
        and relkind = 'r'
    `)
    expect([...rows]).toHaveLength(4)
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} has RLS disabled`).toBe(true)
      expect(row.relforcerowsecurity, `${row.relname} does not force RLS`).toBe(true)
    }
  })

  it.each([
    'solution_components',
    'solution_component_versions',
    'solution_component_capabilities',
    'solution_evidence',
    'solution_compatibility_edges',
  ])('denies the app role INSERT on %s', async (table) => {
    const rows = await db.execute<{ ok: boolean }>(sql`
      select has_table_privilege('builderhunt_app', ${table}, 'INSERT') as ok
    `)
    // Ingesting a component or activating an edge is worker/platform work. A request-scoped role that
    // could write here would let any authenticated user assert a capability the catalog then presents
    // as evidenced.
    expect(rows[0].ok).toBe(false)
  })

  it('lets the worker ingest but not flip a source kill switch', async () => {
    const rows = await db.execute<{ ingest: boolean; enable: boolean }>(sql`
      select has_table_privilege('builderhunt_worker', 'solution_components', 'INSERT') as ingest,
             has_table_privilege('builderhunt_worker', 'solution_sources', 'UPDATE') as enable
    `)
    expect(rows[0].ingest).toBe(true)
    // A worker that could enable its own data source would make the kill switch decorative.
    expect(rows[0].enable).toBe(false)
  })
})
