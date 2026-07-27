import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { BrandLogoMark } from '~/shared/components/BrandLogoMark'
import { Tooltip } from '~/shared/components/Tooltip'
import { ICON_TRANSITION } from '~/shared/lib/useSlidingIndicator'
import type { NavArea } from './nav-config'

/**
 * Level 1 of shell C: the 60px area switcher.
 *
 * Icon-only, so every item needs a tooltip *and* an accessible name — the old
 * topbar could rely on visible labels and this cannot. The active area gets a
 * white surface rather than an accent fill: the accent is already carrying the
 * active item in the level-2 panel, and two accent fills in the same corner
 * read as two selections.
 */
export function AreaRail({
  areas, activeAreaId, badges, onNavigate,
}: {
  areas: readonly NavArea[]
  activeAreaId: string
  badges: { unreadAlerts: number; planRequests: number }
  onNavigate?: () => void
}) {
  const body = areas.filter((area) => !area.footer)
  const footer = areas.filter((area) => area.footer)

  return (
    <nav
      aria-label="Areas"
      // `h-full` matters: the parent is the 100dvh sticky column, and without it
      // the rail's surface stops at the last icon and the page background shows
      // through the rest of the column.
      className="flex h-full flex-col gap-0.5 bg-bh-bg-alt border-r border-bh-border py-2"
    >
      <Tooltip label="Back to home">
        <Link
          to="/"
          aria-label="BuilderHunt home"
          className="mx-auto mt-1.5 mb-3 flex items-center justify-center"
        >
          <BrandLogoMark />
        </Link>
      </Tooltip>

      {body.map((area) => (
        <RailItem
          key={area.id}
          area={area}
          active={area.id === activeAreaId}
          badges={badges}
          onNavigate={onNavigate}
        />
      ))}

      {footer.length > 0 && (
        <div className="mt-auto flex flex-col gap-0.5">
          {footer.map((area) => (
            <RailItem
              key={area.id}
              area={area}
              active={area.id === activeAreaId}
              badges={badges}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </nav>
  )
}

function RailItem({
  area, active, badges, onNavigate,
}: {
  area: NavArea
  active: boolean
  badges: { unreadAlerts: number; planRequests: number }
  onNavigate?: () => void
}) {
  const Icon = area.icon
  // An area's badge is the sum of its items' badges: the rail is collapsed, so
  // a count that only exists at level 2 would be invisible until you opened
  // the area it lives in.
  const count = area.items.reduce(
    (total, item) => total + (item.badge ? badges[item.badge] : 0),
    0,
  )

  return (
    <Tooltip label={area.label}>
      <Link
        to={area.items[0]?.to ?? '/dashboard'}
        aria-label={area.label}
        aria-current={active ? 'true' : undefined}
        data-area={area.id}
        data-active={active || undefined}
        onClick={onNavigate}
        className={`relative mx-auto grid h-[38px] w-10 place-items-center rounded-[10px] ${ICON_TRANSITION} ${
          active
            ? 'bg-bh-surface text-bh-accent shadow-sm'
            : 'text-bh-text-dim hover:bg-bh-surface/70 hover:text-bh-text'
        }`}
      >
        <Icon className="h-[17px] w-[17px]" aria-hidden="true" />
        {count > 0 && (
          <span
            data-testid={`area-badge-${area.id}`}
            className="absolute -right-px -top-px inline-grid h-4 min-w-4 place-items-center rounded-full bg-bh-accent px-1 text-[0.5625rem] font-bold text-bh-accent-contrast ring-2 ring-bh-bg-alt"
          >
            {count > 9 ? '9+' : count}
          </span>
        )}
      </Link>
    </Tooltip>
  )
}
