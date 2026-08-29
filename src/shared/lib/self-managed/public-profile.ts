/**
 * What `/u/<handle>` is served from (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## Read as nobody, on purpose
 *
 * The transaction sets no `app.user_id`, so the owner policies added in `0175` match nothing and
 * only the public-read policies can answer. That makes the anonymous page a genuine test of those
 * policies rather than of a query's `WHERE` clause: a draft is invisible at the row level as well
 * as in the predicate, and the two would have to fail together to leak one.
 *
 * ## Attachments are the profile's, and only the clean ones
 *
 * `listPublicAttachments` filters `scan_status = 'clean'` and joins the profile's visibility, so an
 * attachment cannot outlive the decision to hide the profile it hangs off. The DTO built here names
 * its fields: no storage key, no checksum, no scan status, no rejection code.
 */
import { createServerFn } from '@tanstack/react-start'

import { handleSchema, type PublicSelfManagedAttachment, type PublicSelfManagedProfile } from './contracts'

export interface PublicSelfManagedProfilePage {
  profile: PublicSelfManagedProfile
  attachments: PublicSelfManagedAttachment[]
  /**
   * `public` is listed and indexable; `unlisted` is reachable by link and must carry `noindex`.
   * The page needs the decision, not the state name — see `getPublicProfileListing`.
   */
  listed: boolean
}

export const resolvePublicSelfManagedProfile = createServerFn({ method: 'GET' })
  .validator(handleSchema)
  .handler(async ({ data: handle }): Promise<PublicSelfManagedProfilePage | null> => {
    const { publicDb } = await import('../db/client')
    const { getPublicProfileListing } = await import('../repositories/self-managed-profiles')
    const { listPublicAttachments } = await import('../repositories/self-managed-attachments')

    return publicDb.transaction(async (transaction) => {
      const listing = await getPublicProfileListing(transaction, handle)
      if (!listing) return null

      const attachments = await listPublicAttachments(transaction, handle)
      return {
        profile: listing.profile,
        listed: listing.listed,
        attachments: attachments.map((attachment): PublicSelfManagedAttachment => ({
          id: attachment.id,
          kind: attachment.kind,
          title: attachment.title,
          description: attachment.description,
          mediaType: attachment.mimeType,
          // A `clean` row always has both — the presence CHECKs in `0176` say so — and the fallbacks
          // exist so a column that somehow arrived null renders as a zero rather than throwing on a
          // public page nobody is signed in to report.
          sizeBytes: attachment.sizeBytes ?? 0,
          durationSeconds: attachment.durationSeconds,
          uploadedAt: attachment.uploadedAt.toISOString(),
        })),
      }
    }) as Promise<PublicSelfManagedProfilePage | null>
  })
