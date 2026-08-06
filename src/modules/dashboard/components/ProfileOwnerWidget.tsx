import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { PROFILE_VIEW_COHORT_FLOOR, type DashboardProfileOwner } from '~/shared/lib/dashboard/contracts'

/**
 * The verified profile owner's own summary (plans/ui-dashboard Wave 5). Body only; `WidgetFrame` owns
 * the header and every non-ready state.
 *
 * ## Who sees this
 *
 * Only someone holding a verified claim on a builder identity. For everyone else the API omits the
 * section entirely, so this component never mounts and the tile never appears in the Customize
 * dialog. That is the disclosure boundary — not anything decided here.
 *
 * ## The count, and the refusal to give one
 *
 * `viewsInWindow` is `null` when fewer than `PROFILE_VIEW_COHORT_FLOOR` people looked, and the number
 * genuinely is not in the response. Two reasons that agree:
 *
 *   * "2 views" beside an approach received the same morning is one inference away from naming the
 *     person who looked. This is a glanceable tile, not the dated series on `/me` where a small
 *     number reads as what it is.
 *   * Below a handful there is no trend to summarise. Printing "3" as a thirty-day figure dresses an
 *     anecdote as a measurement.
 *
 * The copy says which floor applied rather than hiding that a rule ran. An owner who sees "fewer than
 * 5" knows there is a threshold and can go to `/me` for the detail; an owner who saw a blank would
 * think the feature was broken.
 *
 * ## Two publication states, not one
 *
 * Directory publication (`published_builder_profiles`) and portfolio publication
 * (`builder_claims.metadata.portfolio.published`) are independent in this codebase, and a profile can
 * have either without the other. Collapsing them into "published" would misreport both halves for
 * anyone in that position.
 */
export function ProfileOwnerWidget({ profile }: { profile: DashboardProfileOwner }) {
  const published = profile.directoryPublished || profile.portfolioPublished

  return (
    <div className="space-y-3" data-testid="widget-profile-owner">
      <div>
        <p className="text-2xl font-bold text-bh-text" data-testid="profile-owner-views">
          {profile.viewsInWindow === null
            ? `Fewer than ${PROFILE_VIEW_COHORT_FLOOR}`
            : profile.viewsInWindow.toLocaleString()}
        </p>
        <p className="text-xs text-bh-text-dim">
          {profile.viewsInWindow === null
            ? `people viewed your profile in the last ${profile.windowDays} days — too few to summarise`
            : `people viewed your profile in the last ${profile.windowDays} days`}
        </p>
      </div>

      <ul className="space-y-1 text-sm" data-testid="profile-owner-publication">
        <li className="flex items-center justify-between gap-2">
          <span className="text-bh-text-muted">Directory listing</span>
          <span className={profile.directoryPublished ? 'text-bh-text' : 'text-bh-text-dim'}>
            {profile.directoryPublished ? 'Published' : 'Not published'}
          </span>
        </li>
        <li className="flex items-center justify-between gap-2">
          <span className="text-bh-text-muted">Portfolio</span>
          <span className={profile.portfolioPublished ? 'text-bh-text' : 'text-bh-text-dim'}>
            {profile.portfolioPublished ? 'Published' : 'Not published'}
          </span>
        </li>
      </ul>

      {/*
        One continuation, to the page that owns this. The full series, the window control and the
        publication switches all live on `/me`; duplicating any of them here would make two places
        responsible for the same setting.
      */}
      <Link
        to="/me"
        className="inline-block text-sm text-bh-accent hover:underline"
        data-testid="profile-owner-manage-link"
      >
        {published ? 'Manage profile' : 'Publish your profile'}
      </Link>
    </div>
  )
}
