import * as React from 'react'
import { Link } from '@tanstack/react-router'

import { PERSONA_COPY } from '~/modules/landing/content/persona-copy'
import { USER_SEGMENT_COPY, USER_SEGMENTS, type UserSegment } from '~/shared/lib/user-segments'

/**
 * "Different goal?" — the switch that is invisible until somebody wants it
 * (plan: phase-2/08-homing-page-content-and-sections).
 *
 * ## Collapsed by default, and links rather than buttons
 *
 * The home page answers on its own. A switch demanding a choice before showing anything would turn an
 * optional question into a toll — the same reason the segment selector proposes rather than gates.
 *
 * Each option is an anchor to `?persona=X`, so it survives JavaScript being off, a crawler follows it,
 * and a middle-click does the obvious thing. A `<button>` calling `navigate` would have needed all
 * three re-implemented.
 *
 * ## Why it is a `<details>`
 *
 * Collapsing needs a disclosure widget, and the browser already ships one with the keyboard
 * behaviour, the focus handling and the `aria-expanded` wiring correct. A `useState` toggle would be
 * three of those re-implemented and one of them forgotten.
 */
export interface PersonaSwitcherProps {
  current: UserSegment
  className?: string
}

export function PersonaSwitcher({ current, className = '' }: PersonaSwitcherProps) {
  return (
    <details className={`inline-block ${className}`} data-testid="persona-switcher">
      <summary className="text-sm text-bh-text-muted underline cursor-pointer inline-flex items-center gap-1 marker:content-none [&::-webkit-details-marker]:hidden">
        Different goal?
      </summary>
      <nav aria-label="Choose what brings you here" className="mt-3">
        <ul className="flex flex-wrap gap-2 list-none p-0 m-0">
          {USER_SEGMENTS.map((segment) => (
            <li key={segment}>
              <Link
                to="/"
                search={{ persona: segment }}
                // `page` rather than `true`: this is a link to the page you are already on with a
                // different query, which is what a screen reader announces for `aria-current="page"`.
                aria-current={segment === current ? 'page' : undefined}
                data-persona={segment}
                data-testid="persona-option"
                className={`inline-flex items-center px-3 py-1.5 rounded-full border text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 ${
                  segment === current
                    ? 'bg-bh-accent-soft border-bh-accent text-bh-accent'
                    : 'bg-bh-surface border-bh-border text-bh-text hover:border-bh-accent hover:text-bh-accent'
                }`}
              >
                {USER_SEGMENT_COPY[segment].label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </details>
  )
}

/** Re-exported so a consumer can assert the switch offers exactly the personas that have copy. */
export const PERSONA_OPTIONS = Object.keys(PERSONA_COPY) as readonly UserSegment[]
