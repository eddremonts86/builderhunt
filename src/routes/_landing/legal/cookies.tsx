import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Cookie } from 'lucide-react'
import { pageMeta } from '~/shared/lib/page-meta'

export const Route = createFileRoute('/_landing/legal/cookies')({
  component: CookiesPage,
  head: () => ({
    meta: [
      ...pageMeta({
        title: 'Cookie Policy — BuilderHunt',
        description: 'Cookies we use and how to opt out.',
      }),
    ],
  }),
})

interface CookieRow {
  name: string
  purpose: string
  type: 'essential' | 'functional' | 'analytics'
  lifespan: string
}

const COOKIES: CookieRow[] = [
  { name: 'bh_session', purpose: 'Auth session token (HTTP-only secure cookie)', type: 'essential', lifespan: '30 days' },
  { name: 'bh_cookie_consent', purpose: 'Remembers your cookie consent preferences', type: 'essential', lifespan: '1 year' },
  { name: 'bh_onboarding_state', purpose: 'Onboarding step state (dismissible, local)', type: 'functional', lifespan: '30 days' },
  { name: 'bh_claim_token', purpose: 'One-time claim token for builder profile claims', type: 'functional', lifespan: '24 hours' },
]

const TYPE_COLORS: Record<CookieRow['type'], string> = {
  essential: 'bg-bh-success/10 text-bh-success border-bh-success/30',
  functional: 'bg-bh-accent-soft text-bh-accent border-bh-accent/30',
  analytics: 'bg-bh-warning/10 text-bh-warning border-bh-warning/30',
}

function CookiesPage() {
  return (
    <article className="container py-12 max-w-4xl animate-fade-in" data-testid="legal-cookies">
      <div className="card p-8 md:p-12 border border-bh-border/60 bg-bh-surface rounded-2xl shadow-sm">
        <header className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight flex items-center gap-3 mb-2">
            <Cookie className="w-7 h-7 text-bh-accent" aria-hidden="true" />
            Cookie Policy
          </h1>
          <p className="text-sm text-bh-text-muted">Version v1.0 · Last updated 2026-07-16</p>
        </header>
        <p className="text-bh-text-muted mb-6 leading-relaxed">
          We use a minimal set of cookies. We do <strong>not</strong> use third-party analytics, marketing, or advertising cookies. The only cookies we set are first-party and necessary to operate the Service.
        </p>

        <h2 className="text-lg font-semibold text-bh-text mb-3">Cookies in use</h2>
        <div className="card table-scroll mb-8 p-0" tabIndex={0} role="region" aria-label="Cookies table, scrollable">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-bh-border text-left text-xs uppercase tracking-wider text-bh-text-dim">
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Purpose</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Lifespan</th>
              </tr>
            </thead>
            <tbody>
              {COOKIES.map((c) => (
                <tr key={c.name} className="border-b border-bh-border/40" data-testid={`cookie-row-${c.name}`}>
                  <td className="px-3 py-2 font-mono text-xs">{c.name}</td>
                  <td className="px-3 py-2 text-bh-text-muted">{c.purpose}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${TYPE_COLORS[c.type]}`}>
                      {c.type}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-bh-text-dim">{c.lifespan}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className="text-lg font-semibold text-bh-text mb-3">How to opt out</h2>
        <div className="prose prose-invert max-w-none text-bh-text-muted leading-relaxed space-y-4">
          <p>
            <strong>Essential cookies</strong> are required for the Service to function (e.g., authentication). They cannot be disabled while you are signed in. Signing out clears the session cookie immediately.
          </p>
          <p>
            <strong>Functional cookies</strong> can be cleared from your browser at any time. Clearing them will not affect your ability to use the Service — you may simply be re-prompted for things like onboarding.
          </p>
          <p>
            <strong>Analytics</strong>: we currently do not use any analytics cookies. If we add them in the future, this policy will be updated, and you will be re-prompted for consent.
          </p>
          <h3 className="text-base font-semibold text-bh-text mt-4">Browser controls</h3>
          <ul className="list-disc pl-6 space-y-1">
            <li>Chrome: Settings → Privacy and security → Cookies and other site data</li>
            <li>Firefox: Settings → Privacy &amp; Security → Cookies and Site Data</li>
            <li>Safari: Preferences → Privacy → Manage Website Data</li>
            <li>Edge: Settings → Cookies and site permissions → Cookies and site data</li>
          </ul>
          <p className="mt-4">
            Note: blocking essential cookies will sign you out and prevent sign-in.
          </p>
        </div>
      </div>
    </article>
  )
}
