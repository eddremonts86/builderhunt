import { ArrowUpRight } from 'lucide-react'

import { isShipped, type SectionItem } from '~/modules/landing/content/landing-sections'

/**
 * One home-page section, rendered from data (plan: phase-2/08-homing-page-content-and-sections).
 *
 * Three sections, one component, because the differences between them are content and not layout —
 * and three hand-built sections would drift into three different answers to what this product does.
 * Same reasoning as `SegmentLandingPage`.
 *
 * ## The badge is derived, never passed
 *
 * `isShipped` reads the item's plan path, so a card cannot claim a state its plan contradicts. The
 * draft this replaces badged a shipped feature "Coming soon" by hand; nothing here can express that.
 *
 * ## A roadmap item links to its specification, not to the feature
 *
 * A "Coming soon" card whose link goes to a product surface promises something the click cannot
 * deliver. These point at the plan on GitHub, which is the honest destination: it says what is
 * intended, and it dates it.
 */
export interface LandingSectionProps {
  eyebrow: string
  heading: string
  subheading: string
  items: readonly SectionItem[]
  /** Roadmap items link out to their spec; shipped ones do not need to. */
  linkPlans?: boolean
  className?: string
}

const PLAN_BASE = 'https://github.com/eddremonts86/builderhunt/blob/master/plans'

export function LandingSection({ eyebrow, heading, subheading, items, linkPlans = false, className = '' }: LandingSectionProps) {
  const id = eyebrow.toLowerCase().replace(/[^a-z]+/g, '-')
  return (
    <section className={`section ${className}`} aria-labelledby={`${id}-heading`} data-testid={`landing-section-${id}`}>
      <div className="container">
        <div className="max-w-2xl mb-12">
          <p className="text-xs font-semibold uppercase tracking-widest text-bh-text-dim mb-3">{eyebrow}</p>
          <h2 id={`${id}-heading`} className="text-4xl md:text-5xl font-bold tracking-tight mb-4 text-bh-text">
            {heading}
          </h2>
          <p className="text-lg text-bh-text-muted">{subheading}</p>
        </div>

        <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 list-none p-0 m-0" data-testid={`${id}-items`}>
          {items.map((item) => {
            const shipped = isShipped(item.planPath)
            return (
              <li key={item.title} className="card p-5 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-bold text-bh-text">{item.title}</h3>
                  {!shipped && (
                    <span
                      className="text-[10px] font-semibold uppercase tracking-widest px-2 py-0.5 rounded-full border border-bh-border text-bh-text-dim"
                      data-testid="coming-soon-badge"
                    >
                      Coming soon
                    </span>
                  )}
                </div>
                <p className="text-sm text-bh-text-muted">{item.copy}</p>
                {linkPlans && (
                  <a
                    href={`${PLAN_BASE}/${item.planPath}/spec.md`}
                    className="text-sm text-bh-accent hover:underline inline-flex items-center gap-1 mt-auto"
                    rel="noreferrer"
                    target="_blank"
                    data-plan-path={item.planPath}
                  >
                    Read the plan
                    <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
                  </a>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
