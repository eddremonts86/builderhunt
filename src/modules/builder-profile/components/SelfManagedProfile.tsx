import { FileText, Image as ImageIcon, Music, Video, Paperclip } from 'lucide-react'

import type { PublicSelfManagedAttachment, PublicSelfManagedProfile } from '~/shared/lib/self-managed/contracts'
import { serviceLabel } from '~/shared/lib/self-managed/service-taxonomy'

/**
 * The public face of a self-managed profile (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## The chip is the product, not decoration
 *
 * A profile with no `builder_claims` behind it must say so on its face, in one glance, everywhere
 * its content appears — that is the plan's whole reason for existing. So `SelfManagedChip` marks
 * every self-declared block rather than only the header: a reader who lands mid-page on a list of
 * work samples is exactly the reader most likely to mistake declared for verified.
 *
 * ## Deliberately not the verified badge, and not its colour
 *
 * `BuilderProfilePage` renders "Verified" as `bh-success` green with a `BadgeCheck`. Nothing here
 * may reach for either. The chip is neutral surface, neutral border, full-contrast text — it reads
 * as a *label*, not as an award, which is the honest thing for a claim nobody has checked. Full
 * `bh-text` rather than the muted token because the sentence it carries is the one caveat a reader
 * must not have to squint at (#18181b on #fcfcfc, and #f4f4f5 on #1c1c24 — both far past 4.5:1).
 */
export function SelfManagedChip({ className }: { className?: string }) {
  return (
    <span
      data-testid="self-managed-chip"
      className={`inline-flex items-center gap-1.5 rounded-full border border-bh-border-strong bg-bh-surface-2 px-2.5 py-0.5 text-xs font-semibold text-bh-text ${className ?? ''}`}
    >
      Self-managed
    </span>
  )
}

const ATTACHMENT_ICON = {
  pdf: FileText,
  image: ImageIcon,
  audio: Music,
  video: Video,
  other: Paperclip,
} as const

function iconFor(mediaType: string) {
  if (mediaType === 'application/pdf') return ATTACHMENT_ICON.pdf
  if (mediaType.startsWith('image/')) return ATTACHMENT_ICON.image
  if (mediaType.startsWith('audio/')) return ATTACHMENT_ICON.audio
  if (mediaType.startsWith('video/')) return ATTACHMENT_ICON.video
  return ATTACHMENT_ICON.other
}

const KIND_LABEL: Record<PublicSelfManagedAttachment['kind'], string> = {
  cv: 'CV',
  'work-sample': 'Work sample',
  certificate: 'Certificate',
  other: 'Attachment',
}

/** Bytes as something a person reads, rounded down so a 25 MB cap never renders as "25 MB" at 26 MB. */
function readableSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.floor(bytes / (1024 * 1024))} MB`
  if (bytes >= 1024) return `${Math.floor(bytes / 1024)} KB`
  return `${bytes} bytes`
}

export interface SelfManagedProfileProps {
  profile: PublicSelfManagedProfile
  attachments: PublicSelfManagedAttachment[]
}

export function SelfManagedProfile({ profile, attachments }: SelfManagedProfileProps) {
  const location = [profile.locationCity, profile.locationCountryCode].filter(Boolean).join(', ')

  return (
    <article data-testid="self-managed-profile" className="mx-auto w-full max-w-3xl">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-balance text-3xl font-bold tracking-tight text-bh-text md:text-4xl">
            {profile.displayName}
          </h1>
          <SelfManagedChip />
        </div>
        <p className="mt-1 text-sm text-bh-text-muted">@{profile.handle}</p>

        {profile.headline && (
          <p className="mt-4 text-lg leading-7 text-bh-text">{profile.headline}</p>
        )}

        {/*
          The caveat, rendered at reading size and directly under the name rather than filed at the
          bottom of the page. A disclaimer a reader has to go looking for is a disclaimer that only
          protects the people who write it.
        */}
        <p
          data-testid="self-managed-disclaimer"
          className="mt-4 rounded-2xl border border-bh-border bg-bh-surface-2 px-4 py-3 text-sm leading-6 text-bh-text-muted"
        >
          Everything on this page is declared by its owner. BuilderHunt has not verified any of it
          against an external account.
        </p>

        {location && (
          <p className="mt-4 text-sm text-bh-text-muted">
            <span className="sr-only">Location: </span>
            {location}
          </p>
        )}
      </header>

      {profile.bio && (
        <section aria-labelledby="self-managed-about" className="mt-10">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="self-managed-about" className="text-lg font-semibold text-bh-text">About</h2>
            <SelfManagedChip />
          </div>
          <p className="mt-3 whitespace-pre-line text-base leading-7 text-bh-text-muted">{profile.bio}</p>
        </section>
      )}

      {profile.services.length > 0 && (
        <section aria-labelledby="self-managed-services" className="mt-10">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="self-managed-services" className="text-lg font-semibold text-bh-text">Services</h2>
            <SelfManagedChip />
          </div>
          <ul className="mt-3 flex flex-wrap gap-2">
            {profile.services.map((service) => (
              <li
                key={service}
                className="rounded-full border border-bh-border bg-bh-surface px-3 py-1 text-sm text-bh-text"
              >
                {serviceLabel(service)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(profile.languages.length > 0 || profile.topics.length > 0) && (
        <section aria-labelledby="self-managed-details" className="mt-10">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="self-managed-details" className="text-lg font-semibold text-bh-text">Languages and topics</h2>
            <SelfManagedChip />
          </div>
          <dl className="mt-3 space-y-2 text-sm">
            {profile.languages.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <dt className="font-medium text-bh-text">Languages:</dt>
                <dd className="text-bh-text-muted">{profile.languages.join(', ')}</dd>
              </div>
            )}
            {profile.topics.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <dt className="font-medium text-bh-text">Topics:</dt>
                <dd className="text-bh-text-muted">{profile.topics.join(', ')}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      <section aria-labelledby="self-managed-work" className="mt-10">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="self-managed-work" className="text-lg font-semibold text-bh-text">Work samples</h2>
          <SelfManagedChip />
        </div>

        {attachments.length === 0 ? (
          <p data-testid="self-managed-no-attachments" className="mt-3 text-sm text-bh-text-muted">
            Nothing attached yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-2" data-testid="self-managed-attachments">
            {attachments.map((attachment) => {
              const Icon = iconFor(attachment.mediaType)
              return (
                <li
                  key={attachment.id}
                  className="flex items-start gap-3 rounded-2xl border border-bh-border bg-bh-surface p-4"
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-bh-text-muted" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="font-medium text-bh-text">{attachment.title}</p>
                    <p className="mt-0.5 text-xs text-bh-text-muted">
                      {KIND_LABEL[attachment.kind]} · {readableSize(attachment.sizeBytes)} · declared by the owner
                    </p>
                    {attachment.description && (
                      <p className="mt-2 text-sm leading-6 text-bh-text-muted">{attachment.description}</p>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </article>
  )
}
