import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { Bell, Sparkles } from 'lucide-react'
import { SOURCE_PRESENTATION } from '~/shared/lib/source-presentation'
import type { SourceName } from '~/lib/sources/types'
import type { DashboardReviewItem } from '~/shared/lib/dashboard/contracts'

/**
 * Candidates to review (plans/ui-dashboard Wave 4). Body only; `WidgetFrame` owns the header and
 * every non-ready state.
 *
 * ## Every row says why it is here
 *
 * The `reason` is server-side text tied to a provenance the schema enumerates — "an alert you set
 * matched this person", or the name of the sprint that found them. Not a score dressed as a
 * sentence, and not generated prose: a review queue that cannot justify a row is asking for trust it
 * has not earned, and the first time a reader disagrees with an unexplained ranking they stop
 * reading the whole widget.
 *
 * ## The continuation depends on whether we already know them
 *
 * A tracked person opens in the internal builder workspace. An untracked one has no internal page
 * yet, so the row links to their public profile through `SOURCE_PRESENTATION.buildProfileUrl`, which
 * validates the handle against that source's own host and returns `null` rather than guessing. A row
 * whose URL cannot be built safely renders without a link instead of with a broken one.
 */

const PROVENANCE_ICON = {
  'alert-match': Bell,
  'sprint-result': Sparkles,
} as const

export function CandidatesToReviewWidget({ items }: { items: readonly DashboardReviewItem[] }) {
  return (
    <ol className="-mx-6 -mb-6 divide-y divide-bh-border border-t border-bh-border">
      {items.map((item) => {
        const Icon = PROVENANCE_ICON[item.provenance]
        const presentation = SOURCE_PRESENTATION[item.source as SourceName]
        const externalUrl = presentation?.buildProfileUrl(item.username) ?? null

        return (
          <li key={item.key} className="flex items-start gap-3 px-6 py-3">
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-bh-accent" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-bh-text">
                {item.displayName ?? item.username}
                <span className="ml-1.5 text-xs font-light text-bh-text-dim">@{item.username}</span>
              </p>
              <p className="mt-0.5 truncate text-xs font-light text-bh-text-muted">
                {item.reason}
                {/* The score is shown next to the sprint that produced it, never alone: a bare
                    number invites the reader to treat it as a ranking they can compare across
                    sources, and it is only comparable within one sprint. */}
                {item.score !== null && <span className="text-bh-text-dim"> · score {item.score}</span>}
              </p>
            </div>

            {item.tracked && item.organizationBuilderId ? (
              <Link
                // Typed params rather than an interpolated path: the router's `to` is a union of
                // registered patterns, and a template literal is not assignable to it. The route is
                // `/_dashboard/builder/$builderId/`, read from its `createFileRoute` and not from
                // the filename.
                to="/builder/$builderId"
                params={{ builderId: item.organizationBuilderId }}
                className="shrink-0 rounded px-2 py-1 text-xs text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
              >
                {/* Without the name every link in the queue announces the same word. */}
                <span className="sr-only">Review {item.displayName ?? item.username}</span>
                <span aria-hidden="true">Review</span>
              </Link>
            ) : externalUrl ? (
              <a
                href={externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded px-2 py-1 text-xs text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
              >
                <span className="sr-only">
                  Open {item.displayName ?? item.username} on {presentation?.label ?? item.source} (opens in a new tab)
                </span>
                <span aria-hidden="true">Profile</span>
              </a>
            ) : (
              // `buildProfileUrl` refused the handle. No link beats a broken one, and a disabled
              // control would imply the profile exists and is merely out of reach.
              <span className="shrink-0 text-xs text-bh-text-dim">{presentation?.label ?? item.source}</span>
            )}
          </li>
        )
      })}
    </ol>
  )
}
