/**
 * What a self-managed profile is, as a closed contract (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## Nothing here carries authority
 *
 * No request schema accepts `ownerUserId`. The owner comes from the authenticated session on the
 * server, never from a body — the same rule `user-preferences-api.ts` states, and for the same
 * reason: a field that names a subject is a field somebody will eventually send.
 *
 * ## Visibility is three states, and only one of them is "gone from search"
 *
 * `public` is listed and searchable. `unlisted` is reachable at `/u/<handle>` and excluded from
 * search — the state for somebody who wants to share a link without being discoverable. `draft` is
 * the owner's alone. Merging `unlisted` into `draft` would take away the only setting that makes
 * "send this to one person" possible.
 */
import { z } from 'zod'

import { SERVICE_IDS } from './service-taxonomy'

/** Lowercase, hyphenated, 3–32. Deliberately narrower than a username: it becomes a public URL. */
export const HANDLE_PATTERN = /^[a-z0-9-]{3,32}$/

export const SELF_MANAGED_VISIBILITIES = ['public', 'unlisted', 'draft'] as const
export type SelfManagedVisibility = (typeof SELF_MANAGED_VISIBILITIES)[number]

export const SELF_MANAGED_ATTACHMENT_KINDS = ['cv', 'work-sample', 'certificate', 'other'] as const
export type SelfManagedAttachmentKind = (typeof SELF_MANAGED_ATTACHMENT_KINDS)[number]

/** Twelve active work samples, from the spec. Enforced in the repository, mirrored here for the form. */
export const MAX_ACTIVE_ATTACHMENTS = 12
/** 25 MB, from the spec. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
/** Seven days, from the spec. */
export const HANDLE_RESERVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** A deleted profile's handle is held for thirty days before anybody else may take it. */
export const HANDLE_RELEASE_AFTER_DELETE_MS = 30 * 24 * 60 * 60 * 1000

export const handleSchema = z.string().regex(HANDLE_PATTERN, 'A handle is 3–32 lowercase letters, digits or hyphens')

/**
 * What an owner may send. No `ownerUserId`, no `id`, no `visibility` transitions that skip a state —
 * and `.strict()`, so an unexpected key is a 400 rather than a value quietly ignored.
 */
export const upsertSelfManagedProfileSchema = z
  .object({
    handle: handleSchema,
    displayName: z.string().min(1).max(80),
    headline: z.string().max(120).nullable().optional(),
    bio: z.string().max(1200).nullable().optional(),
    locationCity: z.string().max(80).nullable().optional(),
    // ISO 3166-1 alpha-2, upper case. Rejected rather than coerced: a lowercase code is a caller bug.
    locationCountryCode: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
    // BCP-47 tags, capped at twelve. Free text by design — the world has more languages than a list.
    languages: z.array(z.string().min(2).max(35)).max(12).default([]),
    services: z.array(z.enum(SERVICE_IDS as [string, ...string[]])).max(SERVICE_IDS.length).default([]),
    topics: z.array(z.string().min(1).max(40)).max(20).default([]),
    visibility: z.enum(SELF_MANAGED_VISIBILITIES).default('draft'),
  })
  .strict()

export type UpsertSelfManagedProfile = z.infer<typeof upsertSelfManagedProfileSchema>

/**
 * What a stranger may read.
 *
 * Explicitly a *projection*, not the row with fields deleted: `ownerUserId`, `promotedToBuilderClaimId`
 * and every timestamp except `updatedAt` are absent because a reader has no business with them, and
 * a projection built by naming what goes in cannot leak a column added later.
 */
export interface PublicSelfManagedProfile {
  handle: string
  displayName: string
  headline: string | null
  bio: string | null
  locationCity: string | null
  locationCountryCode: string | null
  languages: string[]
  services: string[]
  topics: string[]
  updatedAt: string
  /**
   * Whether a verified claim backs this profile.
   *
   * The one field a reader most needs, and the plan's whole point: an unverified profile must say so
   * on its face rather than in a page of caveats somewhere else.
   */
  verified: boolean
}

export const upsertAttachmentSchema = z
  .object({
    kind: z.enum(SELF_MANAGED_ATTACHMENT_KINDS),
    title: z.string().min(1).max(120),
    description: z.string().max(600).nullable().optional(),
  })
  .strict()

export type UpsertAttachment = z.infer<typeof upsertAttachmentSchema>

/**
 * Whether a visibility change is one the product allows.
 *
 * Every transition is legal today — the owner may move freely between the three — and this exists so
 * that when one stops being legal there is a single place to say so, rather than a condition grown
 * into a route handler.
 */
export function isAllowedVisibilityTransition(from: SelfManagedVisibility, to: SelfManagedVisibility): boolean {
  return SELF_MANAGED_VISIBILITIES.includes(from) && SELF_MANAGED_VISIBILITIES.includes(to)
}

/** Whether a stranger may read this profile at its handle. `draft` is the owner's alone. */
export function isPubliclyReadable(visibility: SelfManagedVisibility): boolean {
  return visibility === 'public' || visibility === 'unlisted'
}

/** Whether it may appear in search. `unlisted` is reachable by link and never listed. */
export function isSearchable(visibility: SelfManagedVisibility): boolean {
  return visibility === 'public'
}
