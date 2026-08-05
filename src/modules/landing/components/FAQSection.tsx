import * as React from 'react'
import { FaqPanel, type FaqEntry } from '~/shared/components/FaqPanel'
import { SEARCH_SOURCE_COUNT } from '~/shared/lib/search-connectors'

const FAQ_ITEMS: FaqEntry[] = [
  {
    q: 'What is BuilderHunt, in one sentence?',
    a: `A radar for open-source builders: it aggregates public activity from ${SEARCH_SOURCE_COUNT} public developer sources — GitHub, Reddit, Hacker News and DEV.to among them — scores it for recency, and lets you save searches, get alerts, and track the people behind the work.`,
  },
  {
    q: 'Is it really free?',
    a: 'There is a Free plan that stays free: 3 saved searches, 50 saved builders, and full access to /explore and /blog, with no credit card and no expiry. Paid plans (Pro, Pro Max, Team) add smart alerts, semantic search, AI sourcing sprints and a monthly credit grant — see /pricing for what each one includes.',
  },
  {
    q: 'Do I need API tokens for the sources?',
    a: "No. Every source works out of the box with no setup on your end — there's nothing for you to configure or supply.",
  },
  {
    q: 'How is the activity score calculated?',
    a: 'A recency-weighted blend of public signals: stars, forks, PRs, upvotes, karma, posts. Recent activity is worth much more than old activity. The exact weights are visible in the dashboard so you can sanity-check any result.',
  },
  {
    q: 'Do you contact the builders on my behalf?',
    a: "No. We don't send DMs, emails, or anything. You find them, you reach out. We just do the discovery and the tracking.",
  },
  {
    q: 'Can I export my data?',
    a: 'Yes. Any shortlist, saved search, or note collection can be exported to CSV or JSON with one click. Your data is yours.',
  },
]

/**
 * No `title` — the `#faq` section on the home page already carries the eyebrow and the display
 * heading that every other landing section uses, so the panel would repeat it.
 */
export function FAQSection() {
  return <FaqPanel items={FAQ_ITEMS} testId="landing-faq" />
}
