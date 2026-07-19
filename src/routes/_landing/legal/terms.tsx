import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Scale } from 'lucide-react'

export const Route = createFileRoute('/_landing/legal/terms')({
  component: TermsPage,
  head: () => ({
    meta: [
      { title: 'Terms of Service — BuilderHunt' },
      { name: 'description', content: 'The terms and conditions for using BuilderHunt.' },
    ],
  }),
})

const SECTIONS: Array<{ heading: string; body: string }> = [
  {
    heading: '1. Acceptance of terms',
    body: 'By accessing or using BuilderHunt ("the Service"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree, do not use the Service.',
  },
  {
    heading: '2. Service description',
    body: 'BuilderHunt is a public data aggregator that indexes developer activity from public sources (GitHub, Reddit, Hacker News, DEV.to, and other opt-in sources). We surface people, projects, and discussions. We do not host, mirror, or claim ownership of source data.',
  },
  {
    heading: '3. Accounts',
    body: 'You are responsible for your account credentials and for all activity under your account. Use a strong password. Notify us immediately of any unauthorized access. We may suspend or terminate accounts that violate these Terms.',
  },
  {
    heading: '4. Acceptable use',
    body: 'You agree NOT to: (a) scrape, crawl, or systematically harvest the Service without written permission; (b) send unsolicited messages ("spam") to anyone you discover through the Service; (c) use the Service to harass, stalk, defame, or harm others; (d) attempt to reverse-engineer, decompile, or extract source code; (e) use the Service for any illegal purpose or in violation of any applicable laws including GDPR, CCPA, CAN-SPAM, and similar regulations.',
  },
  {
    heading: '5. Content ownership',
    body: 'You retain ownership of any content you create (notes, lists, profile information). You grant BuilderHunt a non-exclusive, worldwide license to use that content to operate the Service (e.g., to display your notes when you sign in). We retain ownership of the platform, code, design, and aggregations.',
  },
  {
    heading: '6. Termination',
    body: 'We may suspend or terminate the Service or your access at any time, with or without cause. You may terminate at any time by deleting your account under Privacy → Delete account. Termination does not relieve you of obligations accrued before termination.',
  },
  {
    heading: '7. Disclaimers',
    body: 'THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE.',
  },
  {
    heading: '8. Limitation of liability',
    body: 'TO THE MAXIMUM EXTENT PERMITTED BY LAW, BUILDERHUNT AND ITS OPERATORS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR REVENUES, WHETHER INCURRED DIRECTLY OR INDIRECTLY, OR ANY LOSS OF DATA, USE, OR GOODWILL, RESULTING FROM (A) YOUR USE OR INABILITY TO USE THE SERVICE; (B) ANY CONDUCT OR CONTENT OF ANY THIRD PARTY ON THE SERVICE; OR (C) UNAUTHORIZED ACCESS, USE, OR ALTERATION OF YOUR TRANSMISSIONS OR CONTENT.',
  },
  {
    heading: '9. Indemnification',
    body: 'You agree to defend, indemnify, and hold harmless BuilderHunt from any claim, demand, loss, liability, damage, or expense (including reasonable attorneys\' fees) arising out of or related to your use of the Service or violation of these Terms.',
  },
  {
    heading: '10. Governing law and disputes',
    body: 'These Terms are governed by the laws of the State of Delaware, United States, without regard to its conflict of law principles. Any dispute arising from or relating to the Service shall be resolved exclusively in the state and federal courts located in Delaware. You agree to submit to the personal jurisdiction of such courts.',
  },
  {
    heading: '11. Changes to these terms',
    body: 'We may update these Terms from time to time. The "Last updated" date at the top reflects the current version. Material changes will be communicated via email or in-product notice. Continued use of the Service after changes constitutes acceptance.',
  },
  {
    heading: '12. Contact',
    body: 'Questions about these Terms? Email legal@builderhunt.dev. We aim to respond within 5 business days.',
  },
]

function TermsPage() {
  return (
    <article className="container py-12 max-w-4xl animate-fade-in" data-testid="legal-terms">
      <div className="card p-8 md:p-12 border border-bh-border/60 bg-bh-surface rounded-2xl shadow-sm">
        <header className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight flex items-center gap-3 mb-2">
            <Scale className="w-7 h-7 text-bh-accent" aria-hidden="true" />
            Terms of Service
          </h1>
          <p className="text-sm text-bh-text-muted">Version v1.0 · Last updated 2026-07-16</p>
        </header>
        <div className="prose prose-invert max-w-none text-bh-text-muted leading-relaxed space-y-6">
          {SECTIONS.map((s) => (
            <section key={s.heading} className="pt-6 border-t border-bh-border/40 first:border-0 first:pt-0">
              <h2 className="text-lg font-bold text-bh-text mb-3">{s.heading}</h2>
              <p className="whitespace-pre-line">{s.body}</p>
            </section>
          ))}
        </div>
      </div>
    </article>
  )
}
