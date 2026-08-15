import { Link } from '@tanstack/react-router'
import { SEGMENT_PAGES, SEGMENT_PAGE_KEYS } from '~/modules/landing/content/segment-pages'
import { trackConversionEvent } from '~/shared/lib/conversion-client'

/**
 * "I am here to…" on the public pages (plan: phase-2/06-landing-segmentada).
 *
 * ## Links, not tabs
 *
 * Each option is an anchor to a real, server-rendered page. That is what makes it work with
 * JavaScript disabled, what makes it crawlable, and what makes a middle-click do the obvious thing.
 * A tab widget would have needed all three re-implemented, and it would have hidden two thirds of
 * the copy from every crawler.
 *
 * The list is a `<nav>` with its own accessible name rather than a `<ul>` of links in a heading,
 * because a screen-reader user landing on the home page needs to know this is a way *out* of it and
 * not a table of contents for what they are reading.
 *
 * ## It proposes; it never gates
 *
 * The home page answers on its own and nothing here is required. A landing that made somebody choose
 * before showing them anything would turn an optional question into a toll — and the segment is a
 * personalisation, never an authorisation, on this surface as on every other.
 *
 * `?goal=` travels on each link so the goal step can *preselect*. It never persists: the URL is
 * attacker-controlled, and the write happens when somebody confirms. See `onboarding/goal.tsx`.
 */
export interface SegmentSelectorProps {
  /** Rendered above the options. A heading on the home page, absent on a segment page. */
  heading?: string
  /** Which option is the page the reader is already on, so it is marked rather than offered. */
  current?: (typeof SEGMENT_PAGE_KEYS)[number]
  className?: string
}

export function SegmentSelector({ heading, current, className }: SegmentSelectorProps) {
  return (
    <nav aria-label="Choose what brings you here" className={className} data-testid="segment-selector">
      {heading && (
        <p className="text-xs font-semibold uppercase tracking-widest text-bh-text-dim mb-3">{heading}</p>
      )}
      <ul className="flex flex-wrap gap-3 list-none p-0 m-0">
        {SEGMENT_PAGE_KEYS.map((key) => {
          const page = SEGMENT_PAGES[key]
          const isCurrent = current === key
          return (
            <li key={key}>
              <Link
                to={page.path}
                search={{ goal: key }}
                // `page` rather than `true`: this is a link to the page you are on, not a tab in a
                // widget, and `aria-current="page"` is what a screen reader announces for that.
                aria-current={isCurrent ? 'page' : undefined}
                data-testid="segment-selector-option"
                data-segment={key}
                /*
                 * `source: 'landing'` and nothing stored — the same rule the whole feature runs on.
                 * The surface says which selector was used, which is the difference between somebody
                 * who arrived undecided and somebody who landed on the wrong page.
                 */
                onClick={() =>
                  trackConversionEvent('segment_selector_click', current ? 'segment_page' : 'hero', {
                    segment: { previous: current ?? null, next: key, source: 'landing' },
                  })
                }
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-full border text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 ${
                  isCurrent
                    ? 'bg-bh-accent-soft border-bh-accent text-bh-accent'
                    : 'bg-bh-surface border-bh-border text-bh-text hover:border-bh-accent hover:text-bh-accent'
                }`}
              >
                {SEGMENT_LABELS[key]}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/**
 * What each option says on the button.
 *
 * Phrased as what the reader is doing, not as what they are — "hiring" rather than "recruiter",
 * because somebody hiring one engineer this quarter is not a recruiter and would not pick a label
 * that says they are. Same reasoning as `USER_SEGMENT_COPY`, kept separate because this is a
 * two-word button and that is a settings row with a description.
 */
const SEGMENT_LABELS: Record<(typeof SEGMENT_PAGE_KEYS)[number], string> = {
  hiring: "I'm hiring",
  investing: "I'm investing",
  building: "I'm building",
}

export { SEGMENT_LABELS }
