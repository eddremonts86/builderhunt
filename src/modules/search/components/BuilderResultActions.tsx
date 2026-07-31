import * as React from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowUpRight, Bookmark, ExternalLink } from 'lucide-react'
import { Button } from '~/components/ui'
import { getSourcePresentation } from '~/shared/lib/source-presentation'

/**
 * The one action contract for a builder result, wherever one is shown (plans/UI/tasks.md Wave 2
 * "Create a shared builder result action contract"). Before this, each of Search, Recommendations,
 * Alerts, Sprints, Shortlists, and Exports had grown its own slightly different subset of these
 * actions — several with no internal-navigation action at all, only an external link and a Track
 * toggle that never told the user what to do after tracking.
 *
 * - Tracked: `Open workspace` → `/builder/$builderId`.
 * - Untracked, trackable source: `Track & open` → `POST /api/builders/track`, then navigate using
 *   the returned organization-builder id.
 * - Untracked, non-trackable source (devpost/producthunt/bluesky today): the same control,
 *   disabled, with the registry's own reason as its tooltip — never hidden, so the user can see
 *   this result exists and why it can't be opened internally yet.
 * - `Open source profile`: always present when the registry can build one — secondary, never the
 *   only way to continue.
 * - A 402 plan-limit response renders an inline message + upgrade link without removing the result
 *   from whatever list is rendering it — the caller keeps the card, this component owns only the
 *   action area's own state.
 */

export interface BuilderResultActionsBuilder {
  /** Stable key for this specific action instance — the enclosing list's own result id, not the tracked row. */
  id: string
  source: string
  sourceId: string
  username: string
  displayName?: string | null
  avatarUrl?: string | null
  bio?: string | null
  profileUrl: string
  followersCount?: number | null
  language?: string | null
  country?: string | null
  topics?: string[]
  score?: number
  metadata?: Record<string, unknown>
  /** Present once tracked — the organization-builder id the workspace route uses. */
  trackedRowId?: string | null
  tracked?: boolean
}

export interface BuilderResultActionsProps {
  builder: BuilderResultActionsBuilder
  /** A safe, already-resolved same-origin path (see `safe-next.ts`) to carry as `?from=` on the workspace link. */
  from?: string
  /** Called once tracking succeeds, so the caller's own list can flip `tracked`/`trackedRowId` without a full reload. */
  onTracked?: (organizationBuilderId: string) => void
  className?: string
}

interface TrackErrorState {
  message: string
  upgradeUrl?: string
}

export function BuilderResultActions({ builder, from, onTracked, className }: BuilderResultActionsProps) {
  const navigate = useNavigate()
  const [tracking, setTracking] = React.useState(false)
  const [error, setError] = React.useState<TrackErrorState | null>(null)

  const presentation = getSourcePresentation(builder.source)
  const externalUrl = presentation?.buildProfileUrl(builder.username) ?? builder.profileUrl ?? null
  // An unrecognized source string (not one of SOURCE_NAMES) is treated as trackable here — the
  // server's own zod enum in /api/builders/track is the actual boundary; this only decides whether
  // to grey out a control in advance, never whether the request is allowed.
  const isTrackable = presentation?.trackable ?? true
  const dormantReason = presentation?.dormantReason ?? null

  function openWorkspace(organizationBuilderId: string) {
    navigate({
      to: '/builder/$builderId',
      params: { builderId: organizationBuilderId },
      search: from ? { from } : undefined,
    })
  }

  async function trackAndOpen() {
    setError(null)
    setTracking(true)
    try {
      const response = await fetch('/api/builders/track', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: builder.source,
          sourceId: builder.sourceId,
          username: builder.username,
          displayName: builder.displayName ?? null,
          avatarUrl: builder.avatarUrl ?? null,
          bio: builder.bio ?? null,
          // Prefer the registry-built URL — the server's own track endpoint validates profileUrl
          // against the exact same per-source host allowlist, so a caller that never had a real
          // profileUrl to hand us (Recommendations doesn't get one from its own API) still submits
          // a value that will pass rather than a blank string that fails schema validation.
          profileUrl: externalUrl ?? builder.profileUrl,
          followersCount: builder.followersCount ?? null,
          language: builder.language ?? null,
          country: builder.country ?? null,
          topics: builder.topics ?? [],
          score: builder.score,
          metadata: builder.metadata,
        }),
      })

      if (response.status === 402) {
        const body = await response.json().catch(() => null) as { error?: string; upgradeUrl?: string } | null
        setError({ message: body?.error ?? "You've reached your plan's saved-builder limit.", upgradeUrl: body?.upgradeUrl ?? '/pricing' })
        return
      }
      if (!response.ok) {
        setError({ message: 'Could not track this builder — try again.' })
        return
      }

      const data = await response.json() as { id: string }
      onTracked?.(data.id)
      openWorkspace(data.id)
    } catch {
      setError({ message: 'Could not track this builder — try again.' })
    } finally {
      setTracking(false)
    }
  }

  return (
    <div className={className} data-testid={`builder-result-actions-${builder.id}`}>
      <div className="flex items-center gap-2">
        {builder.tracked && builder.trackedRowId ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="rounded-full"
            onClick={() => openWorkspace(builder.trackedRowId!)}
            data-testid={`open-workspace-${builder.id}`}
          >
            Open workspace <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded-full"
            onClick={trackAndOpen}
            disabled={!isTrackable || tracking}
            loading={tracking}
            title={isTrackable ? undefined : (dormantReason ?? undefined)}
            data-testid={`track-and-open-${builder.id}`}
          >
            <Bookmark className="w-3 h-3" aria-hidden="true" /> Track & open
          </Button>
        )}

        {externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary btn-sm rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
            data-testid={`open-source-profile-${builder.id}`}
          >
            Open source profile <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </a>
        )}
      </div>

      {error && (
        <p className="text-xs text-bh-danger mt-1.5" role="alert" data-testid={`track-error-${builder.id}`}>
          {error.message}
          {error.upgradeUrl && (
            <a href={error.upgradeUrl} className="ml-1 underline font-medium">Upgrade plan</a>
          )}
        </p>
      )}
    </div>
  )
}
