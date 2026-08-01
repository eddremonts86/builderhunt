import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import {
  deleteOrganizationBuilder,
  findOrganizationBuilderByEitherId,
  resolveOrganizationBuilderId,
  updateOrganizationBuilder,
} from '~/shared/lib/repositories/organization-builders'
import { findPublishedBuilderProfile, findVerifiedBuilderClaim } from '~/shared/lib/repositories/public-builders'
import { meterSeatActionAndEmit } from '~/shared/lib/abuse/anomalies'
import { isSuppressed } from '~/shared/lib/profile-suppression'
import { parsePortfolioSettings } from '~/shared/lib/portfolio'
import { env } from '~/shared/lib/env'

/** Null unless the claim's own portfolio has actually been published — a verified-but-unpublished
 * or portfolio-never-configured claim must render no link, per plans/UI/tasks.md Wave 6's "show
 * links only when the allowlisted public target exists". */
function portfolioClaimIdFor(claim: { id: string; metadata: Record<string, unknown> } | null): string | null {
  if (!claim) return null
  const settings = parsePortfolioSettings((claim.metadata as Record<string, unknown>).portfolio)
  return settings.published ? claim.id : null
}

const PatchBody = z.object({
  topics: z.array(z.string().min(1).max(40)).max(20).optional(),
  country: z.string().min(2).max(60).nullable().optional(),
  language: z.string().min(2).max(40).nullable().optional(),
})

export const Route = createFileRoute('/api/builders/$builderId')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          // Authenticated recruiters can view any builder they've tracked in
          // their own organization, even if that builder never went through
          // the separate claim/publish flow (findPublishedBuilderProfile
          // below requires a verified claim — see public-builders.ts). This
          // is what makes "click a tracked builder from Dashboard/Alerts/me"
          // work for the overwhelming majority of tracked-but-unclaimed
          // builders. Anonymous requests (no session) fall straight through
          // to the public path.
          let principal: Awaited<ReturnType<typeof requireTenantPrincipal>> | null = null
          try {
            principal = await requireTenantPrincipal(request)
          } catch {
            principal = null
          }
          if (principal) {
            const tenantBuilder = await withTenantContext(principal, (tx) =>
              findOrganizationBuilderByEitherId(tx, principal!.organizationId, params.builderId),
            )
            if (tenantBuilder) {
              // Meter (abuse-and-usage-integrity Phase 4) — this is the "reveal" of an org's
              // private/enriched builder metadata (language/country/topics below) to the
              // recruiter; observe-only, doesn't gate the response.
              await withTenantContext(principal, (tx) => meterSeatActionAndEmit(tx, {
                organizationId: principal!.organizationId,
                userId: principal!.userId,
                action: 'reveals',
                cap: env.SEAT_DAILY_REVEALS,
                requestId: principal!.requestId,
              }))
              const privateMetadata = tenantBuilder.privateMetadata as {
                topics?: string[]; country?: string; language?: string
                codeStyleFingerprint?: unknown
              }
              const claim = await findVerifiedBuilderClaim(tenantBuilder.identityId)
              return Response.json({
                id: tenantBuilder.identityId,
                // The organization's own row id for this tracked builder, as distinct from the
                // shared identity id above. Only on this branch, because only a tracked builder has
                // one. Exposed so the profile can open an interview invitation against it —
                // `scheduling_invitations.organization_builder_id` FKs to exactly this, and without
                // it an invitation created from this page could not be linked back to the builder it
                // is about. Scoped by RLS to the caller's organization, so it identifies nothing
                // they cannot already see.
                trackedId: tenantBuilder.id,
                source: tenantBuilder.source,
                username: tenantBuilder.username,
                displayName: tenantBuilder.displayName,
                avatarUrl: tenantBuilder.avatarUrl,
                bio: tenantBuilder.bio,
                profileUrl: tenantBuilder.profileUrl,
                followersCount: tenantBuilder.followersCount,
                language: privateMetadata.language ?? tenantBuilder.language,
                country: privateMetadata.country ?? tenantBuilder.country,
                topics: privateMetadata.topics ?? [],
                // Only on the tracked-builder branch: the v2 code-style
                // fingerprint is the org's own derived artifact, so it is not
                // part of the public profile payload below. Sent raw and
                // validated client-side by `codeStyleFingerprintV2Schema`.
                codeStyleFingerprint: privateMetadata.codeStyleFingerprint ?? null,
                isClaimed: Boolean(claim),
                isVerified: Boolean(claim),
                claimedByUserId: claim?.subjectUserId ?? null,
                claimedAt: claim?.verifiedAt ?? null,
                portfolioClaimId: portfolioClaimIdFor(claim),
              })
            }
          }
          const builder = await findPublishedBuilderProfile(params.builderId)
          if (!builder) return Response.json({ error: 'Builder not found' }, { status: 404 })
          // A suppressed identity's published profile must never be publicly reachable, even
          // though its `published_builder_profiles`/`builder_identities` rows are a separate
          // table from `builders` (which the removal flow does delete) — see profile-suppression.ts.
          if (await isSuppressed(builder.source, builder.sourceId)) {
            return Response.json({ error: 'Builder not found' }, { status: 404 })
          }
          const claim = await findVerifiedBuilderClaim(builder.id)
          const { sourceId: _sourceId, ...publicBuilder } = builder
          return Response.json({
            ...publicBuilder,
            isClaimed: Boolean(claim),
            isVerified: Boolean(claim),
            claimedByUserId: claim?.subjectUserId ?? null,
            claimedAt: claim?.verifiedAt ?? null,
            portfolioClaimId: portfolioClaimIdFor(claim),
          })
        } catch (error) {
          console.error('Builder fetch error:', error)
          return Response.json({ error: 'Failed to fetch builder' }, { status: 500 })
        }
      },
      PATCH: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const parsed = PatchBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }
          if (Object.keys(parsed.data).length === 0) {
            return Response.json({ error: 'No fields to update' }, { status: 400 })
          }
          const updated = await withTenantContext(principal, async (tx) => {
            const resolvedId = await resolveOrganizationBuilderId(tx, principal.organizationId, params.builderId)
            if (!resolvedId) return null
            return updateOrganizationBuilder(tx, principal.organizationId, resolvedId, parsed.data)
          })
          if (!updated) return Response.json({ error: 'Builder not found' }, { status: 404 })
          return Response.json(updated)
        } catch (error) {
          const response = tenantAuthorizationResponse(error)
          if (response) return response
          console.error('Builder update error:', error)
          return Response.json({ error: 'Failed to update builder' }, { status: 500 })
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const deleted = await withTenantContext(principal, async (tx) => {
            const resolvedId = await resolveOrganizationBuilderId(tx, principal.organizationId, params.builderId)
            if (!resolvedId) return false
            return deleteOrganizationBuilder(tx, principal.organizationId, resolvedId)
          })
          if (!deleted) return Response.json({ error: 'Builder not found' }, { status: 404 })
          return Response.json({ success: true })
        } catch (error) {
          const response = tenantAuthorizationResponse(error)
          if (response) return response
          console.error('Builder delete error:', error)
          return Response.json({ error: 'Failed to delete builder' }, { status: 500 })
        }
      },
    },
  },
})

function tenantAuthorizationResponse(error: unknown) {
  return error instanceof TenantAuthorizationError
    ? Response.json({ error: error.message }, { status: error.status })
    : null
}
