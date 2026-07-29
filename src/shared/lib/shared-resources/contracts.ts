// Shared-resource contracts: the DTOs and permission actions that
// flow across the public APIs of the shared-resources feature.
//
// Why a single file: every API that participates in the feature
// (saved queries, builder lists, public feed capabilities) reads
// from here. The visibility enum, the permission action enum, and
// the typed errors live here so a caller cannot accidentally
// import two different versions of the same shape from two
// different files — that has been a real source of bugs in this
// codebase's pre-multi-org era.
//
// What this file does NOT do: hold any server-only data. There are
// no IDs that should not leave the server, no PII, no third-party
// fields. The schema tag at the top of each interface is the
// authoritative allowlist.

import { z } from 'zod'

/**
 * Two-state visibility for tenant-owned resources. `private` is the
 * default and means the row is only visible to its creator. `organization`
 * means any member of the owning organization can see the row and act
 * on it according to their role's permissions.
 *
 * Deliberately not three-state: a "link-only" or "specific-users"
 * visibility would need an ACL table to back it, which is in the
 * "Future" section of the plan, not this feature.
 */
export const VisibilitySchema = z.enum(['private', 'organization'])
export type Visibility = z.infer<typeof VisibilitySchema>

/**
 * Permission actions the shared-resources feature can ask a
 * `TenantPrincipal` to authorize. The string values are the
 * ones in `src/shared/lib/authorization/permissions.ts`'s
 * `can()` action vocabulary, so an `Action` here is always
 * acceptable to that function.
 */
export const SharedResourceActionSchema = z.enum([
  'read',
  'create',
  'update',
  'delete',
  'change_visibility',
  'add_item',
  'remove_item',
])
export type SharedResourceAction = z.infer<typeof SharedResourceActionSchema>

/** Resource kinds the permission system knows about. */
export const SharedResourceKindSchema = z.enum(['saved_query', 'builder_list', 'list_item', 'feed_capability'])
export type SharedResourceKind = z.infer<typeof SharedResourceKindSchema>

// ── DTOs ────────────────────────────────────────────────────────────────────

/**
 * The allowlisted shape a saved-query row is exposed to the API as.
 * Drizzle column types are not in the type — we project to plain
 * values here so a future schema change cannot accidentally leak
 * a new column into the public DTO.
 */
export const SavedQueryDTOSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  createdByUserId: z.string().min(1),
  name: z.string().min(1).max(120),
  keywords: z.array(z.string().min(1).max(64)).max(32),
  sources: z.array(z.string().min(1).max(32)).max(32),
  language: z.string().min(2).max(8).nullable(),
  country: z.string().length(2).nullable(),
  visibility: VisibilitySchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type SavedQueryDTO = z.infer<typeof SavedQueryDTOSchema>

export const BuilderListDTOSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  createdByUserId: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),
  visibility: VisibilitySchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type BuilderListDTO = z.infer<typeof BuilderListDTOSchema>

/**
 * An item in a builder list. `builderIdentityId` is the canonical
 * identity (the same one `organization_builders.builderIdentityId`
 * points at) — using anything else would let a list entry
 * reference a builder the organization has not tracked, which
 * the FK on the table forbids.
 */
export const BuilderListItemDTOSchema = z.object({
  id: z.string().min(1),
  listId: z.string().min(1),
  organizationId: z.string().min(1),
  builderIdentityId: z.string().min(1),
  createdByUserId: z.string().min(1),
  createdAt: z.coerce.date(),
})
export type BuilderListItemDTO = z.infer<typeof BuilderListItemDTOSchema>

/**
 * A public feed capability — a hashed, revocable, rotatable handle
 * that points at a saved query without exposing the query id. Raw
 * saved-query ids MUST NOT grant public access; a caller who knows
 * a query id gets 404. This shape is what `public-feeds.ts` resolves
 * before the rest of the feed handler runs.
 */
export const FeedCapabilityDTOSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  queryId: z.string().min(1),
  capability: z.string().min(32), // long random, never the query id
  createdAt: z.coerce.date(),
  expiresAt: z.coerce.date().nullable(),
  revokedAt: z.coerce.date().nullable(),
})
export type FeedCapabilityDTO = z.infer<typeof FeedCapabilityDTOSchema>

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Typed errors for the shared-resources feature. The string
 * `code` is the contract a client switches on; the `message` is
 * for humans and is never a stable identifier.
 */
export type SharedResourceErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'tenant_authority_in_request'
  | 'invalid_visibility'
  | 'invalid_identity'
  | 'rate_limited'
  | 'plan_lapsed'

export class SharedResourceError extends Error {
  constructor(
    readonly code: SharedResourceErrorCode,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 422 | 429,
  ) {
    super(message)
    this.name = 'SharedResourceError'
  }
}

/**
 * Hard assert: a request body or query string MUST NOT carry an
 * `organizationId` (or any tenant identifier) as authority. The
 * tenant scope is the active session's `principal.organizationId`,
 * always — any client-supplied value is data, not authority, and
 * is stripped or rejected at the route boundary by this guard.
 *
 * Centralised so every route uses the same coercion; a future
 * "client may set visibility per org" requirement would not silently
 * re-introduce the leak this prevents.
 */
export function stripOrganizationAuthority<T extends Record<string, unknown>>(
  body: T,
  organizationKeys = ['organizationId', 'organization_id', 'orgId'],
): Omit<T, 'organizationId' | 'organization_id' | 'orgId'> {
  const result: Record<string, unknown> = { ...body }
  for (const key of organizationKeys) {
    if (key in result) {
      // Silently strip. The route's downstream call site uses the
      // principal's organizationId, not anything the client said.
      delete result[key]
    }
  }
  return result as Omit<T, 'organizationId' | 'organization_id' | 'orgId'>
}
