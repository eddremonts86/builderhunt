/**
 * Wave 5 — organization-admin overview projection.
 *
 * Tenant-scoped aggregator that composes the six org-admin overview
 * sections (members, billing, blocked workflows, feature adoption,
 * security posture, privacy requests) from real organization data.
 *
 * Every field is minimized by owner/admin authority: members sees
 * counts + roles only, never per-user identity; billing surfaces the
 * plan tier and a single boolean for cap proximity; security posture
 * counts unverified admins but never their email.
 *
 * Privacy contract (enforced in `admin-contracts.ts`):
 *   - The 8 forbidden markers (`memberEmail`, `candidateEmail`,
 *     `productivityScore`, `rank`, `sessionDetail`, `individualAdoption`,
 *     `searchContent`, `noteContent`) MUST NOT appear anywhere in the
 *     serialized output. A grep CI gate is the structural guarantee;
 *     this file is the place to look first.
 *
 * The repository is read-only and parameterized by `organizationId`; it
 * never reads cross-tenant data, even for a platform-admin caller.
 */
import type { Sql } from 'postgres'
import type { z } from 'zod'
import { orgAdminOverviewSchema } from '~/shared/lib/dashboard/admin-contracts'

export type OrgAdminOverview = z.infer<typeof orgAdminOverviewSchema>

/**
 * Inputs the projection needs. Every field is a tenant-scoped
 * server-internal reference; the route handler resolves the
 * organizationId from the session, never from a client-supplied value.
 */
export interface OrgAdminProjectionInput {
  organizationId: string
  range: '24h' | '7d' | '30d'
  now: Date
  clock: { now: () => Date }
}

/**
 * Aggregate the six org-admin sections for a single organization.
 * Returns the typed overview directly — the route handler
 * (`GET /api/dashboard/organization-admin`) is responsible for auth
 * and serialization; this function is pure data.
 */
export async function readOrgAdminOverview(
  sql: Sql,
  input: OrgAdminProjectionInput,
): Promise<OrgAdminOverview> {
  const { organizationId, range, now } = input

  // Members and seats — counts only. The query explicitly does NOT
  // SELECT user email, name, or any per-member identity.
  const membersRow = await sql<
    {
      total: number
      active: number
      pending: number
      owners: number
      admins: number
      members: number
    }[]
  >`
    SELECT
      count(*)::int as total,
      count(*) FILTER (WHERE email_verified)::int as active,
      (SELECT count(*)::int FROM organization_invitations
        WHERE organization_id = ${organizationId} AND status = 'pending') as pending,
      count(*) FILTER (WHERE role = 'owner')::int as owners,
      count(*) FILTER (WHERE role = 'admin')::int as admins,
      count(*) FILTER (WHERE role = 'member')::int as members
    FROM organization_members
    WHERE organization_id = ${organizationId}
  `.then((rows) => rows[0] ?? {
    total: 0, active: 0, pending: 0, owners: 0, admins: 0, members: 0,
  })

  // Billing + entitlement
  const billingRow = await sql<
    { tier: 'free' | 'pro' | 'team'; seats_used: number; seats_total: number; renews_at: Date | null }[]
  >`
    SELECT tier, seats_used, seats_total, renews_at
    FROM entitlements
    WHERE organization_id = ${organizationId}
  `.then((rows) => rows[0])
  const approachingCap =
    billingRow !== undefined && billingRow.seats_total > 0
      ? billingRow.seats_used / billingRow.seats_total >= 0.8
      : false
  const renewalDaysRemaining =
    billingRow?.renews_at
      ? Math.max(
          0,
          Math.round((new Date(billingRow.renews_at).getTime() - now.getTime()) / 86_400_000),
        )
      : null

  // Blocked workflows — counts per kind, no row identity. The kinds are
  // a server-controlled enum; the table column stores them as text.
  const blockedRows = await sql<{ kind: string; count: number }[]>`
    SELECT kind::text, count(*)::int as count
    FROM blocked_workflows
    WHERE organization_id = ${organizationId}
    GROUP BY kind
  `
  const blockedCounts: Record<string, number> = {}
  let blockedTotal = 0
  for (const r of blockedRows) {
    if (/^[a-z0-9_-]+$/.test(r.kind)) {
      blockedCounts[r.kind] = r.count
      blockedTotal += r.count
    }
  }

  // Feature adoption — org-aggregated fractions. Never per-member.
  const adoptionRows = await sql<{ feature_key: string; total: number; used: number }[]>`
    SELECT feature_key, total, used
    FROM feature_adoption
    WHERE organization_id = ${organizationId}
      AND window_days = ${rangeDays(range)}
  `
  const rates: Record<string, number> = {}
  for (const r of adoptionRows) {
    if (/^[a-z0-9_-]+$/.test(r.feature_key) && r.total > 0) {
      rates[r.feature_key] = Math.min(1, Math.max(0, r.used / r.total))
    }
  }

  // Security posture — counts and stale-admin map (adminUserId, days).
  // Only `admin` and `owner` rows are returned; member rows are excluded.
  const securityRows = await sql<{ user_id: string; last_sign_in: Date | null; verified: boolean }[]>`
    SELECT user_id, last_sign_in_at as last_sign_in, email_verified as verified
    FROM organization_members
    WHERE organization_id = ${organizationId}
      AND role IN ('owner', 'admin')
  `
  const unverifiedAdmins = securityRows.filter((r) => !r.verified).length
  const staleAdminDays: Record<string, number> = {}
  for (const r of securityRows) {
    if (r.last_sign_in) {
      const days = Math.floor((now.getTime() - new Date(r.last_sign_in).getTime()) / 86_400_000)
      if (days > 30 && Object.keys(staleAdminDays).length < 50) {
        staleAdminDays[r.user_id] = days
      }
    }
  }

  // Privacy requests — public statuses only, never request bodies.
  const privacyRow = await sql<{ pending: number }[]>`
    SELECT count(*)::int as pending
    FROM data_privacy_requests
    WHERE organization_id = ${organizationId}
      AND status IN ('pending', 'processing')
  `.then((rows) => rows[0] ?? { pending: 0 })

  const built = orgAdminOverviewSchema.parse({
    schemaVersion: 1 as const,
    organizationId,
    range,
    generatedAt: now.toISOString(),
    sections: {
      members: {
        state: 'ready',
        generatedAt: now.toISOString(),
        actions: [],
        data: {
          totalMembers: membersRow.total,
          activeSeats: membersRow.active,
          pendingInvitations: membersRow.pending,
          byRole: { owner: membersRow.owners, admin: membersRow.admins, member: membersRow.members },
        },
      },
      billing: {
        state: 'ready',
        generatedAt: now.toISOString(),
        actions: [],
        data: {
          tier: billingRow?.tier ?? 'free',
          approachingCap,
          renewalDaysRemaining,
        },
      },
      blockedWorkflows: {
        state: 'ready',
        generatedAt: now.toISOString(),
        actions: [],
        data: { blockedCounts, total: blockedTotal },
      },
      featureAdoption: {
        state: 'ready',
        generatedAt: now.toISOString(),
        actions: [],
        data: { rates },
      },
      securityPosture: {
        state: 'ready',
        generatedAt: now.toISOString(),
        actions: [],
        data: { unverifiedAdmins, staleAdminDays },
      },
      privacyRequests: {
        state: 'ready',
        generatedAt: now.toISOString(),
        actions: [],
        data: {
          pending: privacyRow.pending,
          allowedStatuses: ['pending', 'processing'],
        },
      },
    },
  })

  return built
}

function rangeDays(range: '24h' | '7d' | '30d'): number {
  if (range === '24h') return 1
  if (range === '7d') return 7
  return 30
}
