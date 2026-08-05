import * as React from 'react'
import { HelpCircle } from 'lucide-react'

export interface FaqEntry {
  q: string
  a: string
}

interface FaqPanelProps {
  items: readonly FaqEntry[]
  /** The panel's own heading. Omit when the calling section already provides one. */
  title?: string
  testId?: string
  /** Outer spacing only — the surface, radius and border belong to the panel. */
  className?: string
}

/**
 * The single FAQ presentation for the whole public site.
 *
 * Both public FAQs — the landing page's `#faq` and `/pricing` — hand-rolled their own disclosure
 * list, and the two drifted into unrelated components: the landing built every question as a
 * standalone `.card` with a chevron floating on the page background, `/pricing` built them as
 * divider-separated rows inside one surface panel. Same content type, adjacent pages, two card
 * idioms — exactly what DESIGN.md's "one button system, one card system" rule exists to prevent.
 * Presentation lives here so they cannot diverge again; the questions stay with each caller,
 * because product copy and billing copy are genuinely different content.
 */
export function FaqPanel({ items, title, testId, className }: FaqPanelProps) {
  return (
    <div
      className={`card p-8 border border-bh-border/60 bg-bh-surface rounded-2xl shadow-sm${className ? ` ${className}` : ''}`}
      data-testid={testId}
    >
      {title && (
        <h2 className="text-xl font-bold flex items-center gap-2 mb-6">
          <HelpCircle className="w-5 h-5 text-bh-accent" aria-hidden="true" />
          {title}
        </h2>
      )}
      <div className="space-y-4">
        {items.map((item) => (
          <details key={item.q} className="group border-b border-bh-border/40 last:border-0 pb-4 last:pb-0">
            {/* `/pricing` set a bare `outline-none` here, which left keyboard users with no focus
                indicator at all on a summary that is the only control in the section. The landing
                copy had the ring; the shared version keeps it. */}
            <summary className="flex cursor-pointer items-center gap-2 rounded-md list-none font-semibold text-bh-text transition-colors hover:text-bh-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent [&::-webkit-details-marker]:hidden">
              <span
                className="w-1.5 h-1.5 rounded-full bg-bh-accent opacity-0 transition-opacity group-open:opacity-100"
                aria-hidden="true"
              />
              <span>{item.q}</span>
            </summary>
            <p className="mt-2 pl-3 text-sm text-bh-text-muted leading-relaxed">{item.a}</p>
          </details>
        ))}
      </div>
    </div>
  )
}
