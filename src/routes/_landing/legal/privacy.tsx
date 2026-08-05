import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Shield } from 'lucide-react'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'
import { pageMeta } from '~/shared/lib/page-meta'

export const Route = createFileRoute('/_landing/legal/privacy')({
  component: PrivacyPage,
  head: () => ({
    meta: [
      ...pageMeta({
        title: 'Privacy Policy — BuilderHunt',
        description: 'How BuilderHunt collects, uses, and protects your data.',
      }),
    ],
  }),
})

/** Bumped with the version above. Displayed, so it is stated once rather than in two places. */
const PRIVACY_LAST_UPDATED = '2026-07-28'

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
          <li><strong>Device recognition data:</strong> a one-way, salted hash of a random device identifier we set in a first-party cookie, combined with a coarse browser family (e.g. &quot;chrome&quot;, &quot;safari&quot;) — never your full browser/OS string, screen size, fonts, or any other device fingerprint, and never reversible back to the original values. We use this only to recognize when the same device signs in to multiple accounts or an unusual number of accounts sign up from it, as part of abuse prevention.</li>
          <li><strong>Interview data (candidates):</strong> if someone using BuilderHunt invites you to an interview, we process what you submit and what happens in the interview. This is set out in full in section 9.</li>
          <li><strong>Cookies:</strong> see our <Link to="/legal/cookies" className="text-bh-accent underline">Cookie Policy</Link>.</li>
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
          <li><strong>Stripe</strong> — our payment processor. Billing is not yet enabled for customer accounts: today, Stripe is used only for our own product-catalog setup and to verify the authenticity of Stripe&apos;s webhook messages — no customer payment method, card, or subscription data is sent to or received from Stripe yet. Once billing is enabled, this section will be updated before any customer payment, card, or subscription data is processed.</li>
          <li><strong>Hetzner Online (Germany)</strong> — hosts the servers this service runs on, the database, and the off-site encrypted backups. All of it sits in EU data centres. Everything you store with us is stored on their infrastructure; they do not access it.</li>
          <li><strong>Mistral AI (France)</strong> — generates interview briefs and reports from candidate documents and interview notes, when a customer enables that feature. EU-processed by default, on a paid API that is not used to train models. This replaced a previously planned US provider specifically to keep this processing inside the EU. <em>Not yet enabled for any account.</em></li>
          <li><strong>Deepgram</strong> — transcribes interview audio, when a customer enables that feature and every participant has consented. Routed exclusively through Deepgram&apos;s EU endpoint; our servers refuse to start if configured to use any other region. <em>Not yet enabled for any account.</em></li>
        </ul>
        <p className="mt-2">Entries marked <em>not yet enabled</em> are listed in advance because we would rather over-disclose than update this page after the fact. They process nothing until the corresponding feature is switched on for your organization, and we will not switch it on without the consent flow described below.</p>
        <p className="mt-2">We do not use Sentry or PostHog — no error-tracking or analytics provider currently has access to your data.</p>
      </>
    ),
  },
  {
    heading: '4. Cookies and localStorage',
    body: 'We use cookies and localStorage for authentication (session), cookie-consent state, onboarding state, and a random device identifier used for abuse prevention (see "Device recognition data" above). We do not use third-party analytics cookies by default. See our Cookie Policy for details and how to opt out.',
  },
  {
    heading: '5. Data retention',
    body: (
      <>
        <p>We retain your account data for as long as your account is active. If you delete your account, all your personal data is permanently deleted within 30 days (the grace period you can cancel). After 30 days, we retain only anonymized, aggregated statistics (e.g., &quot;we had N searches today&quot;) that cannot identify you.</p>
        <p className="mt-2">Device recognition data and internal abuse-review records follow the same lifecycle as your account and are deleted along with it, with one exception: where a specific signal was already part of an active fraud or abuse investigation, we may retain that specific record after account deletion, consistent with our need to keep an audit trail for that investigation — never for any other purpose.</p>
      </>
    ),
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
  {
    heading: '9. Interviews: documents, public links, audio, and AI',
    body: (
      <>
        <p>
          This section is for <strong>candidates</strong>. It applies when a company using BuilderHunt invites
          you to an interview. Everything here happens only if you agree to it, and each part is a separate
          choice — there is no single &quot;accept all&quot;.
        </p>

        <h3 className="mt-4 font-semibold">Who is responsible for your data</h3>
        <p>
          The company interviewing you decides why your data is processed and is the <strong>controller</strong>.
          BuilderHunt is their <strong>processor</strong>: we handle it on their instructions and for no purpose
          of our own. Requests about your data are best directed to them; if you contact us we will pass them
          on and tell you we did.
        </p>

        <h3 className="mt-4 font-semibold">What you can be asked to agree to</h3>
        <ul className="list-disc pl-6 mt-2 space-y-1">
          <li>
            <strong>Documents you upload.</strong> A CV or portfolio you choose to send. We scan it for
            malware, extract its text so the interviewer can read and search it, and store both.
          </li>
          <li>
            <strong>Public links you submit.</strong> If you tick the separate box confirming you are entitled
            to share it, we fetch a page you gave us and keep the text. We honour <code>robots.txt</code>, we
            never sign in to anything, and we never bypass a paywall or a login. Platforms whose terms forbid
            it — LinkedIn, X, Facebook, Instagram — are stored as a link only and never fetched.
          </li>
          <li>
            <strong>Live transcription.</strong> During the interview your audio is streamed to a transcription
            service in the EU and turned into text as it happens. <strong>The audio itself is never stored</strong>
            — not by us and not by the provider. The <em>text</em> is stored.
          </li>
          <li>
            <strong>AI assistance.</strong> A model reads the documents, the imported page text, and the
            transcript, and produces a preparation brief, suggested follow-up questions, and a written record
            of the interview.
          </li>
        </ul>

        <h3 className="mt-4 font-semibold">Our legal basis</h3>
        <p>
          Your <strong>consent</strong>, for each of the four purposes above, recorded separately with the exact
          version of the notice you were shown. Boxes are never pre-ticked. Booking a time is not agreement to
          any of it: you can book an interview and decline all four.
        </p>

        <h3 className="mt-4 font-semibold">Withdrawing, and what happens then</h3>
        <p>
          You can withdraw any of them at any time from the same page you gave them on. Withdrawal is not
          retroactive — it stops future processing and does not un-write what has already happened. Concretely:
          withdrawing transcription <strong>stops the transcription within ten seconds</strong> and the
          interview continues without it; withdrawing document processing stops any further use of your
          documents. Already-stored text remains until its retention period ends, or sooner if you ask the
          interviewing company to delete it.
        </p>

        <h3 className="mt-4 font-semibold">Who else sees it</h3>
        <ul className="list-disc pl-6 mt-2 space-y-1">
          <li><strong>Transcription:</strong> Deepgram, EU endpoint (<code>api.eu.deepgram.com</code>). Audio in, text out, nothing retained.</li>
          <li><strong>AI:</strong> Mistral, EU (<code>api.mistral.ai</code>). Chosen for its region.</li>
          {/*
            Corrected 2026-08-05. This said "Cloudflare R2", a storage vendor the product does not use
            and has never used: candidate documents sit in self-hosted MinIO on the same box the app
            runs on. Three independent sources agree — `docs/operations/interview-provider-register.md`
            §1 ("MinIO, self-hosted … Removes a paid vendor, a DPA, and a sub-processor entry"),
            `env.ts`'s own comment on `INTERVIEW_R2_*` (the names were kept so a later switch to R2
            would be env-only), and the running `builderhunt-storage` container.

            Naming a sub-processor that does not exist is a false statement in the section headed "Who
            else sees it", and the truth is the stronger claim: for documents, nobody else does.
          */}
          <li><strong>Storage:</strong> self-hosted, private buckets on our own infrastructure — no third-party storage provider. No document is ever publicly reachable.</li>
          <li><strong>Email:</strong> Resend, to send you the invitation.</li>
        </ul>
        <p className="mt-2">
          <strong>Nothing you give us trains anyone&apos;s model.</strong> We do not train on your data and our
          providers are engaged on terms that forbid training on it.
        </p>

        <h3 className="mt-4 font-semibold">How long it is kept</h3>
        <ul className="list-disc pl-6 mt-2 space-y-1">
          <li><strong>Documents and their extracted text:</strong> 180 days.</li>
          <li><strong>Transcripts, briefs, and interview records:</strong> 90 days.</li>
          <li><strong>Consent receipts:</strong> up to 24 months — longer than the data, because the receipt is the evidence that processing it was lawful.</li>
          <li><strong>Audio:</strong> never stored, so there is nothing to delete.</li>
        </ul>
        <p className="mt-2">
          An interviewing company may choose shorter periods. Deletion is automatic when the period ends.
        </p>

        <h3 className="mt-4 font-semibold">No automated decision about you</h3>
        <p>
          The AI writes drafts for a human to read. It does not score you, rank you against anyone, or
          recommend hiring or rejecting you — the system has nowhere to record such a thing and refuses output
          that attempts it. Every AI output is labelled as a draft and is editable by the interviewer, who
          makes the decision. You are not subject to a decision based solely on automated processing.
        </p>
        <p className="mt-2">
          AI output can be wrong. It can misattribute who said what, mis-transcribe a name or a technical term,
          and miss things. If you believe a record about you is inaccurate, you can ask the interviewing company
          to correct it, and you can ask for a human to review any conclusion drawn from it.
        </p>

        <h3 className="mt-4 font-semibold">Your rights</h3>
        <p>
          Access, correction, deletion, restriction, objection, and portability, plus the right to complain to
          your data protection authority. Because the interviewing company is the controller, ask them first —
          they can act directly. Reach us at{' '}
          <a href="mailto:privacy@builderhunt.dev" className="text-bh-accent underline">privacy@builderhunt.dev</a>{' '}
          and we will route it and confirm we have.
        </p>
      </>
    ),
  },
  {
    heading: '10. Interview credits (for companies)',
    body: (
      <>
        <p>
          Interview features consume prepaid credits: a preparation brief and a written record cost 5 credits
          each, live transcription costs 1 credit per minute the provider bills, and follow-up suggestions are
          included while transcription is running. Credits are reserved when work starts and settled against
          what the provider actually billed, with the unused part returned.
        </p>
        <p className="mt-2">
          Running out of credits stops paid transcription. It does not end an interview in progress, and notes
          keep saving.
        </p>
      </>
    ),
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
          {/* Derived, never typed. This line is the version a reader *sees*, and a consent receipt records
              `CURRENT_CONSENT_VERSIONS.privacy` — if the two can differ, every receipt in the ledger is
              evidence of nothing. It was a hand-written literal until 2026-07-28. */}
          <p className="text-sm text-bh-text-muted">
            Version {CURRENT_CONSENT_VERSIONS.privacy} · Last updated {PRIVACY_LAST_UPDATED}
          </p>
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
