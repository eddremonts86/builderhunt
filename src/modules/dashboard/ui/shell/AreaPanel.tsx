import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { groupedItems, isItemActive, type NavArea } from './nav-config'

/**
 * Level 2 of shell C: the destinations inside the active area.
 *
 * Group headings come from the registry's declaration order, which is what lets
 * admin's ten destinations read as three short lists instead of one long one.
 */
export function AreaPanel({
  area, pathname, badges, onNavigate, className = '',
}: {
  area: NavArea
  pathname: string
  badges: { unreadAlerts: number }
  onNavigate?: () => void
  className?: string
}) {
  const groups = groupedItems(area)

  return (
    <div className={`flex min-h-0 flex-col bg-bh-surface ${className}`}>
      <div className="flex min-h-[57px] items-center border-b border-bh-border px-3.5">
        <b className="text-[0.9375rem] font-bold tracking-tight text-bh-text">{area.label}</b>
      </div>

      <nav aria-label={`Sections of ${area.label}`} className="min-h-0 flex-1 overflow-y-auto p-2">
        {groups.map((group, index) => (
          <div key={group.group ?? `ungrouped-${index}`}>
            {group.group && (
              <p
                className={`px-3 pb-1 font-mono text-[0.625rem] uppercase tracking-[0.11em] text-bh-text-dim ${
                  index === 0 ? 'pt-1' : 'pt-3'
                }`}
              >
                {group.group}
              </p>
            )}
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const active = isItemActive(item, pathname)
                const count = item.badge ? badges[item.badge] : 0
                return (
                  <Link
                    key={`${item.to}-${item.label}`}
                    to={item.to}
                    aria-current={active ? 'page' : undefined}
                    data-active={active || undefined}
                    onClick={onNavigate}
                    className={`relative flex items-center gap-2.5 rounded-[9px] px-2.5 py-1.5 text-[0.8125rem] transition-colors duration-150 ${
                      active
                        ? 'bg-bh-accent-soft font-semibold text-bh-accent before:absolute before:-left-2 before:top-1/2 before:h-[18px] before:w-0.5 before:-translate-y-1/2 before:rounded-r-sm before:bg-bh-accent'
                        : 'font-medium text-bh-text-muted hover:bg-bh-bg-alt hover:text-bh-text'
                    }`}
                  >
                    <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{item.label}</span>
                    {count > 0 && (
                      <span
                        data-testid={item.badge === 'unreadAlerts' ? 'alerts-nav-badge' : undefined}
                        className="ml-auto inline-grid h-[17px] min-w-[17px] place-items-center rounded-full bg-bh-accent px-1 text-[0.625rem] font-bold text-bh-accent-contrast"
                      >
                        {count > 9 ? '9+' : count}
                      </span>
                    )}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>
    </div>
  )
}
