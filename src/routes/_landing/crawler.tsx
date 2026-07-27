import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Bot } from 'lucide-react'

/**
 * The page `ENRICHMENT_USER_AGENT` points at.
 *
 * Every request the enrichment crawler makes identifies itself as
 * `BuilderHuntBot/1.0 (+https://builderhunt.dev/crawler)` — see
 * `src/lib/enrichment/network.ts`. That URL is the only way a site owner who sees the bot in
 * their logs can find out who we are and how to stop us, so it has to resolve and it has to be
 * accurate. It 404'd until 2026-07-26.
 *
 * Keep this page honest: describe only what the crawler actually does. If a claim here is not
 * enforced by code in `src/lib/enrichment/`, do not make it.
 */
export const Route = createFileRoute('/_landing/crawler')({
  component: CrawlerPage,
  head: () => ({
    meta: [
      { title: 'BuilderHuntBot — our crawler — BuilderHunt' },
      {
        name: 'description',
        content:
          'What BuilderHuntBot is, what it collects, how it identifies itself, and how to ask it to stop.',
      },
    ],
  }),
})

function CrawlerPage() {
  return (
    <article className="container py-12 max-w-4xl animate-fade-in" data-testid="crawler-page">
      <div className="card p-8 md:p-12 border border-bh-border/60 bg-bh-surface rounded-2xl shadow-sm space-y-6">
        <header className="mb-4">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight flex items-center gap-3 mb-2">
            <Bot className="w-7 h-7 text-bh-accent" aria-hidden="true" />
            BuilderHuntBot
          </h1>
          <p className="text-sm text-bh-text-muted">
            If you found this page from a user-agent string in your server logs, you are in the
            right place.
          </p>
        </header>

        <section className="pt-4 border-t border-bh-border/40">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-2">
            How it identifies itself
          </h2>
          <pre className="text-xs bg-bh-bg border border-bh-border/60 rounded-lg p-3 overflow-x-auto">
            BuilderHuntBot/1.0 (+https://builderhunt.dev/crawler)
          </pre>
          <p className="text-bh-text-muted text-sm mt-2">
            We never disguise the crawler as a browser and never rotate identities to avoid being
            recognised.
          </p>
        </section>

        <section className="pt-4 border-t border-bh-border/40">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-2">
            What it collects
          </h2>
          <p className="text-bh-text">
            Publicly visible professional signals about software developers — the same things a
            visitor sees without logging in: profile pages, public repositories, posts and public
            activity timestamps. We use them to build a profile of someone&apos;s public work so
            recruiters can find them.
          </p>
          <p className="text-bh-text-muted text-sm mt-2">
            It does not log in, does not create accounts, does not solve challenges, and does not
            read anything behind authentication or a paywall.
          </p>
        </section>

        <section className="pt-4 border-t border-bh-border/40">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-2">
            robots.txt and rate
          </h2>
          <p className="text-bh-text">
            The crawler honours <code>robots.txt</code>. If a path is disallowed for our
            user-agent or for <code>*</code>, we do not fetch it. Work runs in small batches from a
            scheduled background job — a couple of profiles per run — so this is a trickle, not a
            bulk scrape, and it should be a rounding error in your traffic.
          </p>
          <p className="text-bh-text-muted text-sm mt-2">
            Some sources are excluded entirely regardless of what their <code>robots.txt</code>{' '}
            allows, because their terms of service forbid it. We treat a terms-of-service
            prohibition as binding even where it may not be legally enforceable.
          </p>
        </section>

        <section className="pt-4 border-t border-bh-border/40">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-2">
            How to make it stop
          </h2>
          <p className="text-bh-text">
            <strong>If you run a site:</strong> disallow <code>BuilderHuntBot</code> in your{' '}
            <code>robots.txt</code> and we will stop fetching it on the next pass. You do not need
            to contact us.
          </p>
          <pre className="text-xs bg-bh-bg border border-bh-border/60 rounded-lg p-3 overflow-x-auto mt-2">
            {'User-agent: BuilderHuntBot\nDisallow: /'}
          </pre>
          <p className="text-bh-text mt-4">
            <strong>If this is about you personally:</strong> you can ask us to remove your profile
            and suppress it from future collection at{' '}
            <Link to="/privacy/remove" className="text-bh-accent hover:underline">
              /privacy/remove
            </Link>
            , or email{' '}
            <a href="mailto:privacy@builderhunt.dev" className="text-bh-accent hover:underline">
              privacy@builderhunt.dev
            </a>
            . A human reads that address.
          </p>
        </section>

        <section className="pt-4 border-t border-bh-border/40">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-2">
            Who is behind it
          </h2>
          <p className="text-bh-text">
            BuilderHunt, operated by Eduardo Valdes Inerarte, Dragør, Denmark. Full details on the{' '}
            <Link to="/legal/imprint" className="text-bh-accent hover:underline">
              imprint
            </Link>
            , and what we do with personal data in the{' '}
            <Link to="/legal/privacy" className="text-bh-accent hover:underline">
              privacy policy
            </Link>
            .
          </p>
        </section>
      </div>
    </article>
  )
}
