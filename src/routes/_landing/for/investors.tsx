import { createFileRoute } from '@tanstack/react-router'
import { SegmentLandingPage } from '~/modules/landing/components/SegmentLandingPage'
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
  validateSearch: (search: Record<string, unknown>): { goal?: string } =>
    (typeof search.goal === 'string' ? { goal: search.goal } : {}),
  head: () => segmentPageHead(SEGMENT_PAGES.investing),
  component: () => <SegmentLandingPage page={SEGMENT_PAGES.investing} />,
})
