import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight, PanelLeft } from 'lucide-react'
import { OrganizationSwitcher } from '~/modules/dashboard/components/OrganizationSwitcher'
import { UserMenu } from '~/modules/dashboard/components/UserMenu'
import { ThemeToggle } from '~/shared/components/ThemeToggle'
import { ICON_TRANSITION } from '~/shared/lib/useSlidingIndicator'
import type { BreadcrumbSegment } from './breadcrumbs'

/**
 * The topbar, now contextual.
 *
 * It used to carry all seven primary destinations, which is why it ran out of
 * room. With navigation in the sidebar the bar's job is to say *where you are*
 * (breadcrumb) and hold the workspace-level controls. Page-level actions are
 * still rendered by pages themselves, so this bar stays the same height on
 * every route.
 */
export function ContextTopbar({
  crumbs, signingOut, onSignOut, pathname, onOpenNav,
}: {
  crumbs: readonly BreadcrumbSegment[]
  signingOut: boolean
  onSignOut: () => void
  pathname: string
  /** Opens the flattened mobile drawer. Hidden from `lg` up. */
  onOpenNav: () => void
}) {
  return (
    <header
      aria-label="Context bar"
      className="glass-topbar sticky top-0 z-30 flex min-h-[57px] items-center gap-3 px-4 lg:px-5"
    >
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-bh-text-dim hover:bg-bh-bg-alt hover:text-bh-text lg:hidden ${ICON_TRANSITION}`}
      >
        <PanelLeft className="h-4 w-4" aria-hidden="true" />
      </button>

      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[0.8125rem]">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1
          return (
            <React.Fragment key={`${index}:${crumb.label}`}>
              {index > 0 && (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-bh-text-dim" aria-hidden="true" />
              )}
              {!last && crumb.to ? (
                <Link to={crumb.to} className="truncate text-bh-text-dim hover:text-bh-text hover:underline">
                  {crumb.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? 'page' : undefined}
                  className={last ? 'truncate font-semibold text-bh-text' : 'truncate text-bh-text-dim'}
                >
                  {crumb.label}
                </span>
              )}
            </React.Fragment>
          )
        })}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ThemeToggle />
        <OrganizationSwitcher />
        <UserMenu
          pathname={pathname}
          signingOut={signingOut}
          onSignOut={onSignOut}
        />
      </div>
    </header>
  )
}
