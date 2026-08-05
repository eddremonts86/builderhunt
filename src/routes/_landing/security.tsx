import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Lock, ShieldCheck } from 'lucide-react'
import { pageMeta } from '~/shared/lib/page-meta'

/**
 * Plan: audit-trust. Every statement below must match shipped behavior — this page exists
 * specifically because prior copy claimed things the code didn't do (a user-suppliable GitHub
 * PAT, an unsubstantiated rating). See trust-claims.test.ts for the regression guard on the
 * landing components; this page has no equivalent generated content to test against, so it is
 * kept deliberately narrow and factual instead.
 */
export const Route = createFileRoute('/_landing/security')({
  component: SecurityPage,
  head: () => ({
    meta: [
      ...pageMeta({
        title: 'Security — BuilderHunt',
        description: 'How BuilderHunt handles source credentials, data in transit, and public profile data.',
      }),
    ],
  }),
})

const SECTIONS: Array<{ heading: string; body: React.ReactNode }> = [
  {
    heading: 'Source credentials',
    body: (
      <>
        <p>
          BuilderHunt queries public APIs (GitHub, GitLab, Codeberg, DEV.to, Hacker News, and others)
          to find and score builder profiles. Some of those APIs allow a higher rate limit when a
          credential is attached — for example a GitHub token.
        </p>
        <p className="mt-2">
          <strong>Any such credential is an operator-managed server secret, configured in our
          deployment environment.</strong> There is no field anywhere in the product where you can
          enter your own personal access token, API key, or password for a third-party service — we
          do not collect them, and we never ask for them.
        </p>
      </>
    ),
  },
  {
    heading: 'Secrets in transit and at rest',
    body: (
      <>
        <p>All traffic to and from BuilderHunt is served over HTTPS, which protects data in transit.</p>
        <p className="mt-2">
          Operator-managed secrets (API tokens, signing keys) are never rendered in any page, API
          response, or client-side bundle, and are redacted before any application log is written.
        </p>
      </>
    ),
  },
  {
    heading: 'Public source data and caching',
    body: (
      <>
        <p>
          The builder profiles you see come from public source APIs — the same data anyone could
          find by visiting that person&apos;s GitHub, GitLab, Codeberg, or DEV.to profile directly.
        </p>
        <p className="mt-2">
          To keep search fast, results are cached for a short period and may be cached separately
          per organization. A profile removed from BuilderHunt (see &quot;Removal vs. deletion&quot;
          below) is filtered out of every cache and every fresh search, not just the one currently
          showing on your screen.
        </p>
      </>
    ),
  },
  {
    heading: 'Removal vs. deletion',
    body: (
      <>
        <p>
          <strong>Account deletion</strong> removes your own BuilderHunt account and the data tied to
          it (see our <Link to="/legal/privacy" className="text-bh-accent underline">Privacy Policy</Link>).
        </p>
        <p className="mt-2">
          <strong>Profile suppression</strong> is a different action: it stops a specific external
          identity (a GitHub/GitLab/Codeberg/DEV.to profile) from appearing on BuilderHunt at all,
          for every user of the product — even if you have never had a BuilderHunt account. See{' '}
          <Link to="/privacy/remove" className="text-bh-accent underline">Remove my profile</Link> to
          start that process.
        </p>
        <p className="mt-2">
          Suppression removes BuilderHunt&apos;s copy of that data. It cannot and does not delete
          your profile on GitHub, GitLab, Codeberg, DEV.to, or any other upstream platform — those
          remain under your control on the platform where you created them.
        </p>
      </>
    ),
  },
  {
    heading: 'Subprocessors',
    body: (
      <>
        <p>
          The services BuilderHunt sends any data to are listed in our{' '}
          <Link to="/legal/privacy" className="text-bh-accent underline">Privacy Policy</Link>{' '}
          (Section 3, &quot;Subprocessors&quot;). That list is kept current with what is actually
          deployed — we do not add a new subprocessor to product copy before it is live in
          production.
        </p>
      </>
    ),
  },
]

function SecurityPage() {
  return (
    <article className="container py-12 max-w-4xl animate-fade-in" data-testid="landing-security">
      <div className="card p-8 md:p-12 border border-bh-border/60 bg-bh-surface rounded-2xl shadow-sm">
        <header className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight flex items-center gap-3 mb-2">
            <ShieldCheck className="w-7 h-7 text-bh-accent" aria-hidden="true" />
            Security
          </h1>
          <p className="text-sm text-bh-text-muted">
            What BuilderHunt does and does not do with credentials and data. If something below
            stops being true, tell us — this page is meant to describe shipped behavior only.
          </p>
        </header>

        <div className="space-y-8">
          {SECTIONS.map((section) => (
            <section key={section.heading}>
              <h2 className="text-lg font-semibold text-bh-text mb-3 flex items-center gap-2">
                <Lock className="w-4 h-4 text-bh-text-dim" aria-hidden="true" />
                {section.heading}
              </h2>
              <div className="text-bh-text-muted leading-relaxed">{section.body}</div>
            </section>
          ))}
        </div>

        <div className="mt-10 pt-8 border-t border-bh-border/50 text-sm text-bh-text-dim">
          Questions about this page? Email{' '}
          <a href="mailto:privacy@builderhunt.dev" className="text-bh-accent underline">privacy@builderhunt.dev</a>.
        </div>
      </div>
    </article>
  )
}
