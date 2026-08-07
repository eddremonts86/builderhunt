/**
 * Wave 5 admin-track — platform-admin overview projection.
 *
 * Cross-tenant aggregator for the platform-admin overview sections
 * (incidents, operations, billing-platform, abuse-trust, user-anomalies,
 * growth, public-content). Aggregates ONLY — never returns per-tenant
 * user identity, per-user search content, or per-user session detail.
 *
 * Privacy contract (enforced in `admin-contracts.ts`):
 *   - All 8 forbidden member-data markers remain banned here.
 *   - The `tenantId` field, when present, is a server-internal UUID
 *     that the route handler may surface for cross-referencing, but
 *     never paired with a user email or session detail.
 *   - Aggregate counts only. Any per-row output is redacted at the
 *     projection boundary (no row identity, no row content).
 *
 * The projection is parameterized by `range` (24h / 7d / 30d) and a
 * single `now` clock; it does not read the caller session directly
 * because the caller is always a platform-admin and the route handler
 * has already gated the request.
 */
import type { Sql } from 'postgres'
import type { z } from 'zod'
import { platformAdminOverviewSchema } from '~/shared/lib/dashboard/admin-contracts'

export type PlatformAdminOverview = z.infer<typeof platformAdminOverviewSchema>

export interface PlatformAdminProjectionInput {
  range: '24h' | '7d' | '30d'
  now: Date
}

export async function readPlatformAdminOverview(
  sql: Sql,
  input: PlatformAdminProjectionInput,
): Promise<PlatformAdminOverview> {
  const { range, now } = input

  // Incidents — per-service counts. The kinds are server-controlled
  // identifiers; the database stores them as text and we re-validate
  // against the regex to reject accidental untrusted values.
  const incidentRows = await sql<{ service: string; open: number }[]>`
    SELECT service::text, count(*)::int as open
    FROM platform_incidents
    WHERE status = 'open'
    GROUP BY service
  `
  const byService: Record<string, number> = {}
  let openTotal = 0
  for (const r of incidentRows) {
    if (/^[a-z0-9_-]+$/.test(r.service)) {
      byService[r.service] = r.open
      openTotal += r.open
    }
  }

  // Operations metrics — bounded top-N, no row identity beyond metric key.
  const operationsRows = await sql<{ metric_key: string; value: number; unit: string }[]>`
    SELECT metric_key::text, value, unit::text
    FROM platform_ops_metrics
    ORDER BY metric_key
    LIMIT 20
  `
  const operationsMetrics = operationsRows
    .filter((r) => /^[a-z0-9_.-]+$/.test(r.metric_key))
    .filter((r) => ['count', 'ms', 'percent', 'rps'].includes(r.unit))
    .filter((r) => Number.isFinite(r.value))
    .map((r) => ({
      key: r.metric_key,
      value: r.value,
      unit: r.unit as 'count' | 'ms' | 'percent' | 'rps',
    }))

  // Billing platform — aggregate only. Tenants and MRR, never customer names.
  const billingRow = await sql<{ tenants: number; mrr_cents: number }[]>`
    SELECT count(distinct tenant_id)::int as tenants,
           coalesce(sum(mrr_cents), 0)::int as mrr_cents
    FROM platform_billing_rollup
    WHERE status = 'active'
  `.then((rows) => rows[0] ?? { tenants: 0, mrr_cents: 0 })

  // Abuse / trust — open reports + 24h auto-actioned count.
  const abuseRows = await sql<{ open: number; auto: number }[]>`
    SELECT count(*)::int as open,
           coalesce(sum(case when auto_actioned_at >= now() - interval '24 hours' then 1 else 0 end), 0)::int as auto
    FROM platform_abuse_reports
    WHERE status IN ('open', 'auto_actioned')
  `.then((rows) => rows[0] ?? { open: 0, auto: 0 })

  // User anomalies — suspicious sign-ins + impossible travel.
  // These counts come from a server-side aggregate, never a per-user row.
  const anomalyRows = await sql<{ suspicious: number; impossible_travel: number }[]>`
    SELECT
      coalesce(sum(case when kind = 'suspicious_signin' then 1 else 0 end), 0)::int as suspicious,
      coalesce(sum(case when kind = 'impossible_travel' then 1 else 0 end), 0)::int as impossible_travel
    FROM platform_user_anomalies
    WHERE detected_at >= ${rangeStart(now, range)}
  `.then((rows) => rows[0] ?? { suspicious: 0, impossible_travel: 0 })

  // Growth — signups + activations in the window.
  const growthRows = await sql<{ signups: number; activations: number }[]>`
    SELECT count(*)::int as signups,
           count(*) FILTER (WHERE activated_at IS NOT NULL)::int as activations
    FROM platform_signups
    WHERE created_at >= ${rangeStart(now, range)}
  `.then((rows) => rows[0] ?? { signups: 0, activations: 0 })

  // Public content — moderation queue + claimed public profiles.
  const contentRows = await sql<{ review: number; claimed: number }[]>`
    SELECT
      (SELECT count(*)::int FROM public_content_queue WHERE status = 'pending') as review,
      (SELECT count(*)::int FROM public_builder_profile_claims WHERE status = 'verified') as claimed
  `.then((rows) => rows[0] ?? { review: 0, claimed: 0 })

  return platformAdminOverviewSchema.parse({
    schemaVersion: 2 as const,
    range,
    generatedAt: now.toISOString(),
    sections: {
      incidents: {
        state: 'ready',
        generatedAt: now.toISOString(),
        actions: [],
        data: { open: openTotal, byService },
      },
      operations: {
        state: 'ready',
        generatedAt: now.toISOString(),
        actions: [],
        data: { metrics: operationsMetrics },
      },
      billing: {
        state: 'ready',
        generatedAt: now.toISOString(),
        actions: [],
        data: {
          totalActiveTenants: billingRow.tenants,
          mrrCents: billingRow.mrr_cents,
        },
      },
      abuseTrust: {
        state: 'ready',
        generatedAt: now.toISOString(),
        actions: [],
        data: {
          openReports: abuseRows.open,
          autoActioned24h: abuseRows.auto,
        },
      },
      userAnomalies: {
        state: 'ready',
        generatedAt: now.toISOString(),
        actions: [],
        data: {
          suspiciousSignins: anomalyRows.suspicious,
          impossibleTravel: anomalyRows.impossible_travel,
        },
      },
      growth: {
        state: 'ready',
        generatedAt: now.toISOString(),
        actions: [],
        data: {
          signups: growthRows.signups,
          activations: growthRows.activations,
        },
      },
      publicContent: {
        state: 'ready',
        generatedAt: now.toISOString(),
        actions: [],
        data: {
          reviewQueue: contentRows.review,
          claimedPublicProfiles: contentRows.claimed,
        },
      },
    },
  })
}

function rangeStart(now: Date, range: '24h' | '7d' | '30d'): Date {
  const ms = range === '24h' ? 24 * 3600_000 : range === '7d' ? 7 * 86_400_000 : 30 * 86_400_000
  return new Date(now.getTime() - ms)
}
