import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { Clock } from 'lucide-react'
import { formatDistanceToNow } from '~/shared/lib/format'
import { BentoTileList } from '~/modules/dashboard/ui/bento/Bento'

/**
 * The builders this workspace tracked most recently.
 *
 * Every row detail is gated on the tile's own width, not the viewport's, so the
 * same component works at `md` (298px) and inside a full-width `sections` bubble:
 *   - always            avatar, name, source badge, relative activity
 *   - `@sm` (≥384px)    follower count
 *   - `@md` (≥448px)    bio, and topic chips
 * Nothing is clipped at any width because nothing is shown before it fits.
 */

export interface RecentBuilder {
  id: string
  /** builder_identities.id — the profile link needs this, not `id`. */
  identityId: string
  username: string
  displayName: string | null
  source: 'github' | 'reddit' | 'hn' | 'devto'
  bio: string | null
  followersCount: number | null
  topics: string[]
  lastSeen: string
}

export function RecentBuildersWidget({ builders }: { builders: readonly RecentBuilder[] }) {
  return (
    <BentoTileList>
      <ul>
        {builders.map((builder) => {
          const name = builder.displayName ?? builder.username
          return (
            <li key={builder.identityId}>
              <Link
                to="/builder/$builderId"
                params={{ builderId: builder.identityId }}
                className="flex items-start gap-3 px-6 py-3 transition-colors hover:bg-bh-surface-2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-bh-accent to-bh-cyan text-xs font-semibold text-white"
                >
                  {name[0]?.toUpperCase()}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-bh-text" title={name}>
                      {name}
                    </span>
                    <span className={`badge badge-${builder.source} shrink-0 px-1.5 py-0 text-[9px]`}>
                      {builder.source}
                    </span>
                  </span>

                  {builder.bio && (
                    <span className="mt-0.5 hidden @md:line-clamp-1 text-xs text-bh-text-muted">
                      {builder.bio}
                    </span>
                  )}

                  <span className="mt-0.5 flex items-center gap-1 text-[10px] text-bh-text-dim">
                    <span className="hidden @sm:inline">
                      {builder.followersCount?.toLocaleString() ?? 0} followers
                    </span>
                    <span className="hidden @sm:inline" aria-hidden="true">·</span>
                    <Clock className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">active {formatDistanceToNow(new Date(builder.lastSeen))}</span>
                  </span>

                  {builder.topics.length > 0 && (
                    <span className="mt-1.5 hidden @md:flex flex-wrap gap-1">
                      {builder.topics.slice(0, 3).map((topic) => (
                        <span
                          key={topic}
                          className="rounded-full border border-bh-border bg-bh-bg-alt px-1.5 py-0.5 text-[9px] text-bh-text-dim"
                        >
                          {topic}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </BentoTileList>
  )
}
