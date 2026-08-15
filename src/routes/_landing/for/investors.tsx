import { createFileRoute, notFound } from '@tanstack/react-router'
import { SegmentLandingPage } from '~/modules/landing/components/SegmentLandingPage'
import { getSegmentedLandingEnabled } from '~/shared/lib/segmented-landing-flag'
import { segmentPageHead } from '~/modules/landing/content/segment-page-head'
import { SEGMENT_PAGES } from '~/modules/landing/content/segment-pages'

/**
 * The investing page (plan: phase-2/06-landing-segmentada).
 *
 * A static route rather than a slug: the sitemap, the crawler and the router all need to know this
 * path exists, and a dynamic segment accepting exactly three values looks open-ended to every one of
 * them. The content is data — see `segment-pages.ts`, where every claim carries the file that makes
 * it true.
 *
 * `?goal=` is accepted and never persisted. It travels to the goal step, which uses it to
 * *preselect*; the URL is attacker-controlled, so the write happens only when somebody confirms.
 */
export const Route = createFileRoute('/_landing/for/investors')({
  /*
   * Off means this page does not exist, and 404 is the only answer that says so truthfully. Not a
   * redirect to `/` — that tells a crawler the page moved permanently somewhere it did not move to —
   * and not a 200 with the content hidden, which is a switched-off URL that still gets indexed.
   */
  beforeLoad: async () => {
    if (!(await getSegmentedLandingEnabled())) throw notFound()
  },
  validateSearch: (search: Record<string, unknown>): { goal?: string } =>
    (typeof search.goal === 'string' ? { goal: search.goal } : {}),
  head: () => segmentPageHead(SEGMENT_PAGES.investing),
  component: () => <SegmentLandingPage page={SEGMENT_PAGES.investing} />,
})
