import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { LinkButton } from '~/components/ui'
import { GitBranch, Zap, Users, TrendingUp } from 'lucide-react'

export function HomePage() {
  return (
    <div className="min-h-screen bg-bh-bg">
      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-4 border-b border-bh-border">
        <div className="flex items-center gap-2">
          <GitBranch className="w-5 h-5 text-bh-accent" />
          <span className="text-bh-text font-semibold text-lg">BuilderHunt</span>
        </div>
        <div className="flex gap-4">
          <LinkButton to="/auth/sign-in" variant="ghost">Sign in</LinkButton>
          <LinkButton to="/auth/sign-up" variant="default">Get started</LinkButton>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-8 py-32 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-bh-border text-bh-text-muted text-sm mb-8">
          <Zap className="w-3 h-3 text-bh-accent" />
          Find builders, not just repos
        </div>
        <h1 className="text-6xl font-bold text-bh-text leading-tight mb-6">
          Discover active builders<br />
          <span className="text-bh-accent">across the open web</span>
        </h1>
        <p className="text-xl text-bh-text-muted max-w-2xl mx-auto mb-12">
          BuilderHunt aggregates activity from GitHub, Reddit, Hacker News and DEV.to —
          no cookies, no OAuth for social platforms. Just signal.
        </p>
        <div className="flex justify-center gap-4">
          <LinkButton to="/auth/sign-up" variant="default">Start hunting →</LinkButton>
          <LinkButton to="/auth/sign-in" variant="ghost">Sign in</LinkButton>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-5xl mx-auto px-8 py-20">
        <div className="grid grid-cols-3 gap-6">
          {[
            {
              icon: Users,
              title: 'Multi-source discovery',
              desc: 'GitHub stars, HN upvotes, Reddit karma, DEV.to posts — all indexed and scored.',
            },
            {
              icon: TrendingUp,
              title: 'Activity scoring',
              desc: 'Recency-weighted algorithms surface builders who are active now, not three years ago.',
            },
            {
              icon: Zap,
              title: 'Keyword alerts',
              desc: 'Get notified when builders matching your stack show up — without tracking their cookies.',
            },
          ].map(({ icon: Icon, title, desc }) => (
            <div key={title} className="card">
              <Icon className="w-8 h-8 text-bh-accent mb-4" />
              <h3 className="text-bh-text font-semibold mb-2">{title}</h3>
              <p className="text-bh-text-muted text-sm">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-bh-border px-8 py-16 text-center">
        <p className="text-bh-text-muted text-lg">
          Built for builders who want to find other builders.
        </p>
        <LinkButton to="/auth/sign-up" variant="default" className="mt-6">
          Create free account →
        </LinkButton>
      </section>
    </div>
  )
}