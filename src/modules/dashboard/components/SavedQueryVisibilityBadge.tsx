/**
 * SavedQueryVisibilityBadge — plan 28 (shared-resources) task 8.
 *
 * The two-state visibility enum (`private` | `organization`) is the
 * surface area of the shared-searches feature. A user looking at
 * their dashboard or a search results page needs to know, at a
 * glance, whether a saved query is theirs alone or shared with the
 * rest of the organization.
 *
 * The label "Team" is used instead of "organization" because that
 * is what the rest of the design system uses; the API contract is
 * still the strict enum.
 */
import * as React from 'react'
import { Lock, Users } from 'lucide-react'

export type SavedQueryVisibility = 'private' | 'organization'

export interface SavedQueryVisibilityBadgeProps {
  visibility: SavedQueryVisibility
  size?: 'sm' | 'md'
  className?: string
}

export function SavedQueryVisibilityBadge({ visibility, size = 'sm', className = '' }: SavedQueryVisibilityBadgeProps) {
  const isShared = visibility === 'organization'
  const padding = size === 'md' ? 'px-2 py-0.5' : 'px-1.5 py-0.5'
  const text = size === 'md' ? 'text-xs' : 'text-[10px]'
  return (
    <span
      className={`inline-flex items-center gap-1 ${padding} rounded ${text} uppercase tracking-wider ${
        isShared
          ? 'bg-bh-accent-soft text-bh-accent'
          : 'bg-bh-surface text-bh-text-dim'
      } ${className}`}
      data-testid="saved-query-visibility-badge"
      data-visibility={visibility}
    >
      {isShared ? <Users className="w-3 h-3" aria-hidden="true" /> : <Lock className="w-3 h-3" aria-hidden="true" />}
      {isShared ? 'Team' : 'Private'}
    </span>
  )
}
