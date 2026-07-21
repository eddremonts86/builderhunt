import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Shield } from 'lucide-react'

export const Route = createFileRoute('/_landing/legal/privacy')({
  component: PrivacyPage,
  head: () => ({
    meta: [
      { title: 'Privacy Policy — BuilderHunt' },
      { name: 'description', content: 'How BuilderHunt collects, uses, and protects your data.' },
    ],
  }),
})

const SECTIONS: Array<{ heading: string; body: React.ReactNode }> = [
  {
    heading: '1. Data we collect',
    body: (
      <>
        <p>We collect the following categories of data:</p>
        <ul className="list-disc pl-6 mt-2 space-y-1">
          <li><strong>Account data:</strong> name, email, profile image (if you sign in with a social provider), password hash (we never store plaintext).</li>
          <li><strong>Workspace data:</strong> saved searches, saved builders, private notes per builder, alerts, exports.</li>
          <li><strong>Claim data:</strong> if you claim a builder profile, your email and a one-time token. We never store the token after use.</li>
          <li><strong>Usage data:</strong> server logs (IP address, user agent, page path, response code) for 30 days. We use these for abuse prevention and capacity planning.</li>
          <li><strong>Cookies:</strong> see our <Link to="/legal/cookies" className="text-bh-accent hover:underline">Cookie Policy</Link>.</li>
        </ul>
      </>
    ),
  },
  {
    heading: '2. How we use your data',
    body: 'We use your data solely to: (a) provide and improve the Service; (b) deliver alerts and exports you create; (c) prevent abuse and enforce our Terms; (d) comply with legal obligations. We do not sell your personal data to third parties, ever.',
  },
  {
    heading: '3. Subprocessors',
    body: (
      <>
        <p>We share data only with the following subprocessors, all of which are bound by data processing agreements:</p>
        <ul className="list-disc pl-6 mt-2 space-y-1">
          <li><strong>PostgreSQL database (self-hosted)</strong> — primary data store. Encrypted at rest.</li>
          <li><strong>Redis (self-hosted, when configured)</strong> — session cache, rate limiting.</li>
          <li><strong>GitHub, Reddit, Hacker News, DEV.to, npm, Hugging Face, GitLab, Codeberg</strong> — public data sources we query on your behalf.</li>
          <li><strong>Resend</strong> — sends transactional email only (account verification, password reset, organization invitations, smart-alert digests, and account deletion/data-export notices). Falls back to a server-side console log with no third-party call when unconfigured.</li>
          <li><strong>MiniMax M3</strong> — a server-side AI model used to generate persisted, shared artifacts (e.g. profile enrichment summaries, code fingerprints) and to power background AI features. We only send public profile data and your own submitted inputs (e.g. a job description) — never your account email, password, private notes, or other users&apos; data.</li>
          <li><strong>Embedding provider (configured via a server-only vector API)</strong> — converts already-public builder profile text into numeric vectors that power semantic search. No account data is embedded.</li>
        </ul>
        <p className="mt-2">We do not use Sentry, PostHog, or Stripe — no error-tracking, analytics, or payment processor currently has access to your data.</p>
      </>
    ),
  },
  {
    heading: '4. Cookies and localStorage',
    body: 'We use cookies and localStorage for authentication (session), cookie-consent state, and onboarding state. We do not use third-party analytics cookies by default. See our Cookie Policy for details and how to opt out.',
  },
  {
    heading: '5. Data retention',
    body: 'We retain your account data for as long as your account is active. If you delete your account, all your personal data is permanently deleted within 30 days (the grace period you can cancel). After 30 days, we retain only anonymized, aggregated statistics (e.g., "we had N searches today") that cannot identify you.',
  },
  {
    heading: '6. Your rights (GDPR Art. 15–22)',
    body: (
      <>
        <p>As a data subject you have the right to:</p>
        <ul className="list-disc pl-6 mt-2 space-y-1">
          <li><strong>Access (Art. 15):</strong> see all data we hold about you. Use Privacy → Export my data in your dashboard.</li>
          <li><strong>Rectification (Art. 16):</strong> edit your profile and notes anytime from your dashboard.</li>
          <li><strong>Erasure (Art. 17):</strong> delete your account. Use Privacy → Delete account.</li>
          <li><strong>Restriction (Art. 18):</strong> contact us to restrict processing while a dispute is open.</li>
          <li><strong>Portability (Art. 20):</strong> export your data as JSON. Same control as access.</li>
          <li><strong>Object (Art. 21):</strong> opt out of non-essential processing. Cookie preferences are available on the cookie banner.</li>
        </ul>
      </>
    ),
  },
  {
    heading: '7. California (CCPA / CPRA)',
    body: 'California residents have the right to: (a) know what personal information we collect, use, share, or sell; (b) delete personal information we collect; (c) opt out of the sale or sharing of personal information. We do not sell personal information. To exercise these rights, use the in-product controls or email privacy@builderhunt.dev. We honor Global Privacy Control (GPC) signals as opt-out.',
  },
  {
    heading: '8. International transfers',
    body: 'Our servers are located in the European Union. If you access the Service from outside the EU, your data is transferred to the EU. For users in the US, the data is stored in the EU. We use standard contractual clauses where required.',
  },
  {
    heading: '9. Children',
    body: 'The Service is not directed to children under 16. We do not knowingly collect data from children under 16. If you believe a child has provided us data, contact privacy@builderhunt.dev and we will delete it within 7 days.',
  },
  {
    heading: '10. Security',
    body: 'We use industry-standard security: TLS for data in transit, encryption at rest for the database, bcrypt for password hashing, parameterized queries to prevent SQL injection, and HTTP-only secure cookies for sessions. Despite our efforts, no system is 100% secure.',
  },
  {
    heading: '11. Changes to this policy',
    body: 'We may update this policy. Material changes will be communicated via email and in-product notice at least 14 days before they take effect. The current version is always at /legal/privacy.',
  },
  {
    heading: '12. Contact',
    body: 'Privacy questions: privacy@builderhunt.dev. You can also reach us at the address listed in our Imprint. We aim to respond within 5 business days.',
  },
]

function PrivacyPage() {
  return (
    <article className="container py-12 max-w-4xl animate-fade-in" data-testid="legal-privacy">
      <div className="card p-8 md:p-12 border border-bh-border/60 bg-bh-surface rounded-2xl shadow-sm">
        <header className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight flex items-center gap-3 mb-2">
            <Shield className="w-7 h-7 text-bh-accent" aria-hidden="true" />
            Privacy Policy
          </h1>
          <p className="text-sm text-bh-text-muted">Version v1.0 · Last updated 2026-07-21</p>
        </header>
        <div className="prose prose-invert max-w-none text-bh-text-muted leading-relaxed space-y-6">
          {SECTIONS.map((s) => (
            <section key={s.heading} className="pt-6 border-t border-bh-border/40 first:border-0 first:pt-0">
              <h2 className="text-lg font-bold text-bh-text mb-3">{s.heading}</h2>
              <div>{s.body}</div>
            </section>
          ))}
        </div>
      </div>
    </article>
  )
}
