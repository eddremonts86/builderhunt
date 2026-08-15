import * as React from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { LinkButton } from '~/components/ui'
import { SegmentSelector } from '~/modules/landing/components/SegmentSelector'
import type { SegmentPageContent } from '~/modules/landing/content/segment-pages'
import { trackConversionEvent } from '~/shared/lib/conversion-client'

/**
 * One segment's public page (plan: phase-2/06-landing-segmentada).
 *
 * Three pages, one component, because the differences between them are content and not layout —
 * and three hand-built pages would drift into three different answers to "what does this product
 * do".
 *
 * ## The limits are on the page
 *
 * Every section here renders, including `limits`. A caveat filed as a review note is a caveat the
 * reader never sees, which leaves the promise as the only thing they read. They are not buried
 * either: they sit under the claims, in the same column, at the same size.
 *
 * ## The selector stays
 *
 * Somebody who lands on the wrong page should be one click from the right one. Hiding the other
 * routes once a visitor has "chosen" would be treating a guess about them as a decision they made.
 */
export function SegmentLandingPage({ page }: { page: SegmentPageContent }) {
  /**
   * The top of this page's funnel.
   *
   * Keyed on the segment so a click through the selector — which stays on this component and only
   * swaps the content — reports the page somebody actually read. Without the key, moving between the
   * three pages would count as one view of whichever one they landed on first.
   */
  React.useEffect(() => {
    trackConversionEvent('segment_page_viewed', 'segment_page', {
      segment: { previous: null, next: page.segment, source: 'landing' },
    })
  }, [page.segment])

  return (
    <main className="container max-w-3xl py-16">
      <SegmentSelector current={page.segment} className="mb-10" />

      <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-4" data-testid="segment-heading">
        {page.heading}
      </h1>
      <p className="text-lg text-bh-text-muted mb-8">{page.subheading}</p>

      <div className="flex flex-wrap items-center gap-3 mb-12">
        <LinkButton
          to={page.cta.to}
          variant="primary"
          className="btn-lg"
          data-testid="segment-cta"
          onClick={() =>
            trackConversionEvent('segment_page_cta_click', 'segment_page', {
              segment: { previous: null, next: page.segment, source: 'landing' },
            })
          }
        >
          {page.cta.label}
          <ArrowRight className="w-4 h-4 ml-1" aria-hidden="true" />
        </LinkButton>
        {/*
          The hint travels with the person who signs up from here, because this is the only link on
          the page that leaves the public site. `SignUpPage` stashes it on success and the goal step
          reads it once — see `landing-segment-hint.ts` for why it is a same-tab, expiring stash and
          not a cookie.
        */}
        <LinkButton to="/auth/sign-up" search={{ goal: page.segment }} variant="secondary">
          Create an account
        </LinkButton>
      </div>

      <section aria-labelledby="what-it-does" className="mb-12">
        <h2 id="what-it-does" className="text-xl font-semibold mb-4">
          What it does
        </h2>
        <ul className="space-y-3 list-none p-0 m-0" data-testid="segment-claims">
          {page.claims.map((claim) => (
            <li key={claim.text} className="flex items-start gap-3">
              <Check className="w-4 h-4 mt-1 text-bh-accent shrink-0" aria-hidden="true" />
              <span className="text-bh-text">{claim.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="the-objection" className="mb-12 card p-5">
        <h2 id="the-objection" className="text-base font-semibold mb-2">
          {page.objection.question}
        </h2>
        <p className="text-sm text-bh-text-muted">{page.objection.answer}</p>
      </section>

      <section aria-labelledby="what-it-does-not" className="mb-12">
        <h2 id="what-it-does-not" className="text-xl font-semibold mb-4">
          What it does not do
        </h2>
        <ul className="space-y-3 list-none p-0 m-0 text-sm text-bh-text-muted" data-testid="segment-limits">
          {page.limits.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </section>
    </main>
  )
}
