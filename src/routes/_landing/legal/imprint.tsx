import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Building2 } from 'lucide-react'

export const Route = createFileRoute('/_landing/legal/imprint')({
  component: ImprintPage,
  head: () => ({
    meta: [
      { title: 'Imprint — BuilderHunt' },
      { name: 'description', content: 'Legal entity and contact information for BuilderHunt.' },
    ],
  }),
})

function ImprintPage() {
  return (
    <article className="container py-12 max-w-4xl animate-fade-in" data-testid="legal-imprint">
      <div className="card p-8 md:p-12 border border-bh-border/60 bg-bh-surface rounded-2xl shadow-sm space-y-6" data-testid="imprint-card">
        <header className="mb-4">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight flex items-center gap-3 mb-2">
            <Building2 className="w-7 h-7 text-bh-accent" aria-hidden="true" />
            Imprint
          </h1>
          <p className="text-sm text-bh-text-muted">Required by TMG §5 (Germany) and similar EU regulations.</p>
        </header>

        <section className="pt-4 border-t border-bh-border/40">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-1">Operator</h2>
          <p className="text-bh-text">
            <strong>BuilderHunt</strong>
            <br />
            Operated by Eduardo Valdes Inerarte, individual developer.
            <br />
            Elmevej 4, Dragør, Denmark
            <br />
            <span className="text-bh-text-muted text-sm">A company will be formed before any production/paid launch outside this beta.</span>
          </p>
        </section>

        <section className="pt-4 border-t border-bh-border/40">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-1">Contact</h2>
          <p className="text-bh-text">
            Email: <a href="mailto:hello@builderhunt.dev" className="text-bh-accent hover:underline">hello@builderhunt.dev</a>
            <br />
            Support: <a href="mailto:support@builderhunt.dev" className="text-bh-accent hover:underline">support@builderhunt.dev</a>
            <br />
            Privacy: <a href="mailto:privacy@builderhunt.dev" className="text-bh-accent hover:underline">privacy@builderhunt.dev</a>
            <br />
            Legal: <a href="mailto:legal@builderhunt.dev" className="text-bh-accent hover:underline">legal@builderhunt.dev</a>
            <br />
            DMCA: <a href="mailto:dmca@builderhunt.dev" className="text-bh-accent hover:underline">dmca@builderhunt.dev</a>
          </p>
        </section>

        <section className="pt-4 border-t border-bh-border/40">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-1">Responsible for content (per § 18 MStV)</h2>
          <p className="text-bh-text-muted">Same as operator above.</p>
        </section>

        <section className="pt-4 border-t border-bh-border/40">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-1">Tax &amp; registration</h2>
          <p className="text-bh-text-muted text-sm leading-relaxed">
            VAT ID: not yet assigned (pre-revenue beta, operated by an individual — no company
            has been formed yet).
            <br />
            Registered address: Denmark (see Operator above).
            <br />
            US tax filings via Stripe Tax would only apply once the deferred Stripe integration
            trigger is reached (see pricing plan) — not active today.
          </p>
        </section>

        <section className="pt-4 border-t border-bh-border/40">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-1">Hosting</h2>
          <p className="text-bh-text-muted text-sm leading-relaxed">
            Self-hosted on infrastructure in the European Union. Backed up daily. Encrypted at rest (AES-256) and in transit (TLS 1.3).
          </p>
        </section>

        <section className="pt-4 border-t border-bh-border/40">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-1">DMCA / copyright reports</h2>
          <p className="text-bh-text-muted text-sm leading-relaxed">
            No formal DMCA agent has been designated with the U.S. Copyright Office yet — this is
            an informal reporting channel we monitor and respond to, not a registered agent
            contact. To report copyright infringement, email <a href="mailto:dmca@builderhunt.dev" className="text-bh-accent hover:underline">dmca@builderhunt.dev</a> with:
            (1) the copyrighted work, (2) the URL on BuilderHunt allegedly infringing, (3) your
            contact info, (4) a good-faith statement, (5) a statement under penalty of perjury
            that you are authorized to act for the owner. We respond within 5 business days.
          </p>
        </section>

        <section className="pt-4 border-t border-bh-border/40">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-1">Dispute resolution</h2>
          <p className="text-bh-text-muted text-sm leading-relaxed">
            The European Commission provides an online platform for online dispute resolution:{' '}
            <a href="https://ec.europa.eu/consumers/odr" className="text-bh-accent hover:underline" rel="nofollow noreferrer">ec.europa.eu/consumers/odr</a>.
            We are not obliged and do not commit to participate in dispute resolution procedures before a consumer arbitration board.
          </p>
        </section>
      </div>
    </article>
  )
}
