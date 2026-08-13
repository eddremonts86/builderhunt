// table-surface-semantic: the cookie disclosure is four rows of legal prose — bounded, read
// rather than operated, and the one thing native <th scope> gives it (row/column context for a
// screen reader) is what a role="grid" would have to reconstruct by hand.
import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Cookie } from 'lucide-react'
import { SemanticTable, StatusCell, type SemanticColumn, type StatusTone } from '~/shared/components/table'
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

/**
 * Which of the shared status tones each cookie class reads as.
 *
 * The tones are the table system's, not this page's: `essential` is the resting, unremarkable
 * state; `functional` is the one a reader may want to act on; `analytics` is the one this policy
 * exists to say we do not set. Local colour classes here were how a "chip" on the cookie page came
 * to be a different size and radius from every chip in the admin queues.
 */
const TYPE_TONES: Record<CookieRow['type'], StatusTone> = {
  essential: 'neutral',
  functional: 'accent',
  analytics: 'warning',
}

const COOKIE_COLUMNS: SemanticColumn<CookieRow>[] = [
  // The cookie's literal name, which is a key a reader may go looking for in their browser's
  // storage inspector — one of the two things DESIGN.md:221 keeps the monospace face for.
  { id: 'name', header: 'Name', rowHeader: true, cell: (row) => <span className="font-mono text-xs">{row.name}</span> },
  { id: 'purpose', header: 'Purpose', cell: (row) => row.purpose },
  { id: 'type', header: 'Type', cell: (row) => <StatusCell label={row.type} tone={TYPE_TONES[row.type]} /> },
  { id: 'lifespan', header: 'Lifespan', cell: (row) => row.lifespan },
]

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
        <SemanticTable
          caption="Cookies BuilderHunt sets, their purpose, class and lifespan"
          columns={COOKIE_COLUMNS}
          rows={COOKIES}
          rowKey={(row) => row.name}
          rowTestId={(row) => `cookie-row-${row.name}`}
          className="mb-8"
        />

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
