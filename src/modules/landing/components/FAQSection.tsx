import * as React from 'react'
import { ChevronDown } from 'lucide-react'

const FAQ_ITEMS = [
  {
    q: 'What is BuilderHunt, in one sentence?',
    a: 'A radar for open-source builders: it aggregates public activity from GitHub, Reddit, Hacker News and DEV.to, scores it for recency, and lets you save searches, get alerts, and track the people behind the work.',
  },
  {
    q: 'Is it really free?',
    a: "Yes during public beta. We'll introduce a paid tier eventually for team features (shared shortlists, custom score weights, larger alert volumes) but the core product stays free for individual use.",
  },
  {
    q: 'Do I need API tokens for the sources?',
    a: 'No. Everything works out of the box. Adding a GitHub personal access token (optional, free) lifts the rate limit so you can run larger or more frequent searches.',
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

export function FAQSection() {
  return (
    <div className="space-y-3">
      {FAQ_ITEMS.map((item) => (
        <details key={item.q} className="group card hover:border-bh-border-strong mb-4">
          <summary className="flex cursor-pointer list-none items-center justify-between font-semibold text-bh-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] rounded-lg p-2">
            <span>{item.q}</span>
            <ChevronDown
              className="w-5 h-5 text-bh-text-muted transition-transform duration-200 group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <p className="mt-2 pl-2 text-sm text-bh-text-muted leading-relaxed">
            {item.a}
          </p>
        </details>
      ))}
    </div>
  )
}
