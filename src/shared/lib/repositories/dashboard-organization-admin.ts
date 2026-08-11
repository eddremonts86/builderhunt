/**
 * Wave 5 — organization-admin overview projection.
 *
 * Tenant-scoped aggregator that composes the six org-admin overview sections (members, billing, blocked
 * workflows, feature adoption, security posture, privacy requests) for one organization.
 *
 * Every field is minimized by owner/admin authority: members sees counts and roles only, never per-user identity,
 * and billing surfaces the plan tier and a single boolean for cap proximity rather than a percentage.
 *
 * Privacy contract (enforced in `admin-contracts.ts`):
 *   - The 8 forbidden markers (`memberEmail`, `candidateEmail`, `productivityScore`, `rank`, `sessionDetail`,
 *     `individualAdoption`, `searchContent`, `noteContent`) MUST NOT appear anywhere in the serialized output. A
 *     grep CI gate is the structural guarantee; this file is the place to look first.
 *
 * The repository is read-only and parameterized by `organizationId`; it never reads cross-tenant data, even for a
 * platform-admin caller.
 *
 * ## Rewritten 2026-08-11, because the first version could not run
 *
 * It was written against a schema that does not exist, and nothing imported it — so it type-checked, parsed its
 * own contract, and had never executed a single query successfully. Called for real it threw
 * `column "email_verified" does not exist`, and that was only the first of four problems:
 *
 * - `email_verified` and `last_sign_in_at` were selected **from `organization_members`**. They are not there.
 *   `email_verified` is on `auth_users` — and the join that looks like the fix answers `permission denied`, because
 *   `builderhunt_app` is not granted on the account table at all. `last_sign_in_at` **does not exist anywhere**:
 *   `auth_users` has seven columns and none of them is a sign-in time.
 * - `entitlements` is really `organization_entitlements`.
 * - `data_privacy_requests` is really two tables, `deletion_requests` and `data_export_requests`, and both are
 *   keyed on `user_id` rather than on an organization — so an organization-scoped count has to go through
 *   membership.
 * - `blocked_workflows` and `feature_adoption` exist in no form at all.
 *
 * ## What it does now
 *
 * Three sections read real tables — members, billing, privacy requests. Three answer
 * `unavailable: 'dependency-missing'`, which is what that state is for: the alternative is inventing a count, and
 * "0 blocked workflows" on a dashboard reads as a healthy workspace rather than as an unbuilt feature. Same rule
 * the Admin Metrics sections follow, and this plan's whole subject.
 *
 * The third of those three is the interesting one, because its dependency is a **privilege** rather than a table.
 * See `securityPosture` below. The per-admin stale-days map the original write-up described is gone for a plainer
 * reason: there is no sign-in timestamp to compute it from, and a map of zeros would say every admin signed in
 * today.
 */
import { sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { TenantTransaction } from '~/shared/lib/db/client'
import { orgAdminOverviewSchema } from '~/shared/lib/dashboard/admin-contracts'

export type OrgAdminOverview = z.infer<typeof orgAdminOverviewSchema>

/**
 * Inputs the projection needs. Every field is a tenant-scoped server-internal reference; the route handler
 * resolves the organizationId from the session, never from a client-supplied value.
 */
export interface OrgAdminProjectionInput {
  organizationId: string
  range: '24h' | '7d' | '30d'
  now: Date
}

/** A section with no table behind it. The reason is closed by the contract; `dependency-missing` is the honest one. */
const dependencyMissing = { state: 'unavailable' as const, reason: 'dependency-missing' as const }

/**
 * The cap proximity threshold: 80 % of the seat limit.
 *
 * A boolean rather than a percentage, deliberately. "You are at 87 % of your seats" invites arithmetic on a
 * number the reader cannot act on precisely; "you are approaching your seat limit" is the decision. And the
 * *count* of seats is already in the members section, so the percentage would be derivable anyway — by whoever
 * wants it, rather than published as a headline.
 */
const SEAT_CAP_WARNING_RATIO = 0.8

/**
 * Takes the tenant transaction, not a raw connection.
 *
 * The first version's signature was postgres.js's `Sql`, and that is a second reason it was never wired: the app's
 * own `withTenantContext` hands out a drizzle transaction, so calling it required a cast — and a cast is what let
 * the mismatch reach a running route as a 500 instead of a compile error. Every other repository in this codebase
 * takes the transaction.
 */
export async function readOrgAdminOverview(
  tx: TenantTransaction,
  input: OrgAdminProjectionInput,
): Promise<OrgAdminOverview> {
  const { organizationId, range, now } = input
  const generatedAt = now.toISOString()

  /**
   * Members and seats — counts and role breakdown only, and **no join to `auth_users`**.
   *
   * The obvious fix for the original `column "email_verified" does not exist` was to join the account table, since
   * that is where the column lives. Running it proved that wrong for a better reason: `builderhunt_app` is not
   * granted `SELECT` on `auth_users` at all — only `builderhunt_auth` and `builderhunt_platform` are — so the join
   * answers `permission denied for table auth_users`.
   *
   * That is the role separation working, not an oversight to route around. A tenant-facing projection has no
   * business reading the account table, and granting it that privilege to populate a dashboard tile would be a
   * real regression traded for a number. So the verified count is gone and `securityPosture` says why.
   *
   * The pending-invitation count is gone for the same kind of reason, found the same way: `organization_invitations`
   * is granted to `builderhunt_auth` only, because invitations are managed by Better Auth. Three of the original
   * design's numbers turned out to need a privilege this connection does not have, and each one was discovered by
   * running the query rather than by reading it — which is exactly why a projection nothing imports proves nothing.
   *
   * The `FILTER` clauses are parenthesised before their casts because `count(*)::int filter (…)` is a syntax
   * error — a shape this repository has already shipped once, in a load monitor that reported a peak of zero while
   * every sample threw.
   */
  const memberRows = (await tx.execute(sql`
    SELECT
      count(*)::int AS total,
      (count(*) FILTER (WHERE m.role = 'owner'))::int AS owners,
      (count(*) FILTER (WHERE m.role = 'admin'))::int AS admins,
      (count(*) FILTER (WHERE m.role = 'member'))::int AS members
    FROM organization_members m
    WHERE m.organization_id = ${organizationId}
  `)) as unknown as Array<{ total: number; owners: number; admins: number; members: number }>
  const memberRow = memberRows[0]

  /** The plan row. Absent is a real state: an organization with no entitlement row has never been provisioned. */
  const entitlementRows = (await tx.execute(sql`
    SELECT tier::text, status::text, seat_limit, current_period_end
    FROM organization_entitlements
    WHERE organization_id = ${organizationId}
    LIMIT 1
  `)) as unknown as Array<{ tier: string; status: string; seat_limit: number | null; current_period_end: string | Date | null }>
  const entitlement = entitlementRows[0]

  /**
   * Privacy requests — counts per status across both request kinds, joined through membership.
   *
   * Both tables are keyed on `user_id`, so "this organization's requests" means "requests by people in it". That
   * is an approximation and worth naming: a member who left keeps their request, and it stops being counted here.
   * The alternative — recording an organization on the request — is a schema change, and for a *deletion* request
   * it is arguably the wrong one: the request belongs to the person, not to a workspace they happened to be in.
   */
  const privacyRows = (await tx.execute(sql`
    SELECT 'deletion' AS kind, d.status::text AS status, count(*)::int AS total
    FROM deletion_requests d
    WHERE d.user_id IN (SELECT user_id FROM organization_members WHERE organization_id = ${organizationId})
    GROUP BY d.status
    UNION ALL
    SELECT 'export' AS kind, e.status::text AS status, count(*)::int AS total
    FROM data_export_requests e
    WHERE e.user_id IN (SELECT user_id FROM organization_members WHERE organization_id = ${organizationId})
    GROUP BY e.status
  `)) as unknown as Array<{ kind: string; status: string; total: number }>

  const memberTotal = Number(memberRow?.total ?? 0)
  const seatLimit = entitlement?.seat_limit ?? null
  const renewalDays =
    entitlement?.current_period_end != null
      ? Math.max(0, Math.ceil((new Date(entitlement.current_period_end).getTime() - now.getTime()) / 86_400_000))
      : null

  return orgAdminOverviewSchema.parse({
    schemaVersion: 1 as const,
    organizationId,
    range,
    generatedAt,
    sections: {
      members:
        memberTotal === 0
          ? // A workspace with no members cannot exist while somebody is reading this page as its admin, so this
            // is really "the join found nothing", which is a state worth showing as empty rather than as zeros.
            { state: 'empty' as const }
          : {
              state: 'ready' as const,
              generatedAt,
              actions: [],
              data: {
                total: memberTotal,
                byRole: {
                  owner: Number(memberRow?.owners ?? 0),
                  admin: Number(memberRow?.admins ?? 0),
                  member: Number(memberRow?.members ?? 0),
                },
                seatLimit,
              },
            },

      billing: entitlement
        ? {
            state: 'ready' as const,
            generatedAt,
            actions: [],
            data: {
              tier: entitlement.tier,
              status: entitlement.status,
              seatLimit,
              /** A boolean, not a percentage — see `SEAT_CAP_WARNING_RATIO`. */
              approachingSeatCap: seatLimit !== null && seatLimit > 0 && memberTotal / seatLimit >= SEAT_CAP_WARNING_RATIO,
              renewalDays,
            },
          }
        : // Never provisioned. Not an error, and not a free tier either — the absence of a row is not a plan.
          { state: 'empty' as const },

      /**
       * No table exists in any form for either of these, so both say so.
       *
       * `dependency-missing` rather than `empty`: empty means "nothing to show", which a reader takes as "no
       * blocked workflows" — a healthy workspace. This says the feature is not there, which is the truth.
       */
      blockedWorkflows: dependencyMissing,
      featureAdoption: dependencyMissing,

      /**
       * Security posture: `dependency-missing`, and the dependency is a *privilege* rather than a table.
       *
       * Both numbers the original design named need the account table. The unverified-admin count needs
       * `auth_users.email_verified`, which `builderhunt_app` is not granted — that separation is deliberate, and
       * granting it to populate a dashboard tile would trade a real boundary for a number. The per-admin
       * stale-days map needs a sign-in timestamp, and `auth_users` has seven columns of which none is one.
       *
       * So this section has no honest content from a tenant-scoped connection. Reporting `elevatedMembers` alone
       * would be worse than nothing: a count of owners and admins is already in the members section, and putting
       * it under "security posture" implies it was assessed.
       */
      securityPosture: dependencyMissing,

      privacyRequests:
        privacyRows.length === 0
          ? { state: 'empty' as const }
          : {
              state: 'ready' as const,
              generatedAt,
              actions: [],
              data: {
                /**
                 * Counts per kind and status, and nothing else.
                 *
                 * No request ids, no subjects, no reasons. A deletion request's *content* is the most sensitive
                 * thing in this projection, and the shape of the query is what keeps it out: it groups and counts,
                 * so there is no column to leak rather than a filter that has to remember.
                 */
                byKind: privacyRows.reduce<Record<string, Record<string, number>>>((accumulator, row) => {
                  if (!/^[a-z_]{1,32}$/.test(row.status)) return accumulator
                  accumulator[row.kind] = { ...(accumulator[row.kind] ?? {}), [row.status]: Number(row.total ?? 0) }
                  return accumulator
                }, {}),
              },
            },
    },
  })
}
