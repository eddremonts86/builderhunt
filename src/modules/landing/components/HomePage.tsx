import * as React from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { LinkButton } from '~/components/ui'
import {
  Search, Bell, FileText, Download, Sparkles, Target, Mail,
  Zap, Shield, Brain, ArrowRight, Check, Star, LayoutDashboard, LogOut,
} from 'lucide-react'
import { useSession, signOut } from '~/shared/lib/auth/client'
import { GithubIcon, RedditIcon, HackerNewsIcon, DevToIcon } from './BrandIcons'
import { FAQSection } from './FAQSection'
import { Footer } from '~/shared/components/Footer'
import { BackToTop } from '~/shared/components/BackToTop'

/* -------------------------------------------------------------------------- */
/*  Logo component (inline SVG so we don't depend on the public file at first  */
/*  paint — but the public file is the canonical asset)                        */
/* -------------------------------------------------------------------------- */
function Logo({ size = 28 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-lg shrink-0"
      style={{ width: size, height: size, background: 'linear-gradient(135deg, #6366f1, #4f46e5)' }}
      aria-hidden="true"
    >
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none">
        <path d="M5 4h7a4 4 0 0 1 4 4v1" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M16 4h3a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-7a4 4 0 0 0-4 4v3" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M8 20H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h7a4 4 0 0 0 4-4V7" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="11" cy="12" r="1.8" fill="#06b6d4" />
      </svg>
    </span>
  )
}

const NAV_LINKS = [
  { to: '/#how-it-works', label: 'How it works' },
  { to: '/#use-cases', label: 'Use cases' },
  { to: '/#sources', label: 'Sources' },
  { to: '/#faq', label: 'FAQ' },
] as const

export function HomePage() {
  const session = useSession()
  const navigate = useNavigate()
  const [signingOut, setSigningOut] = React.useState(false)

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut()
    } finally {
      navigate({ to: '/' })
    }
  }

  const isAuthed = !!session.data?.user

  return (
    <>
      {/* ──────────────────────────────────────────────────────────────── */}
      {/*  Skip target for the "Skip to main content" link                */}
      {/* ──────────────────────────────────────────────────────────────── */}
      {/* Floating topbar — same treatment as the dashboard shell (rounded
          pill, shadow, bg-bh-surface), just wider: this nav carries a logo
          wordmark + 4 links + auth actions, so it spans nearly the full
          width instead of staying icon-width like the dashboard's. */}
      <header className="fixed top-4 inset-x-4 md:inset-x-6 lg:inset-x-10 z-40 bg-bh-surface border border-bh-border/60 rounded-full shadow-lg">
        <nav className="flex h-14 items-center justify-between px-3 md:px-5" aria-label="Primary">
          <Link to="/" className="flex items-center gap-2.5 group shrink-0" aria-label="BuilderHunt home">
            <Logo />
            <span className="font-bold text-lg tracking-tight hidden sm:inline">BuilderHunt</span>
          </Link>

          <ul className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map((l) => (
              <li key={l.to}>
                <a
                  href={l.to.replace('/', '') || '/'}
                  className="btn-ghost text-sm"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-2 shrink-0">
            {isAuthed ? (
              <>
                <LinkButton to="/dashboard" variant="secondary" className="btn-sm">
                  <LayoutDashboard className="w-4 h-4" /> Dashboard
                </LinkButton>
                <button
                  type="button"
                  onClick={handleSignOut}
                  disabled={signingOut}
                  className="btn-ghost btn-sm"
                  aria-label="Sign out"
                >
                  {signingOut ? (
                    <span className="spinner" aria-hidden="true" />
                  ) : (
                    <LogOut className="w-4 h-4" aria-hidden="true" />
                  )}
                  <span className="hidden sm:inline">Sign out</span>
                </button>
              </>
            ) : (
              <>
                <LinkButton to="/auth/sign-in" variant="ghost" className="hidden sm:inline-flex">Sign in</LinkButton>
                <LinkButton to="/auth/sign-up" variant="primary" className="btn-sm">Get started</LinkButton>
              </>
            )}
          </div>
        </nav>
      </header>

      <main id="main-content" className="pt-24">
        {/* ───────────────────────── HERO ───────────────────────── */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 bg-grid" aria-hidden="true" />
          <div className="container section-lg relative">
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              <div>
                <span className="eyebrow mb-6 inline-flex animate-fade-in">
                  <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                  Public beta · Free during beta
                </span>
                <h1 className="text-5xl md:text-6xl lg:text-7xl font-extrabold tracking-tighter leading-[1.05] mb-6 animate-fade-in-up">
                  Find <span className="text-gradient-accent">builders</span>,<br />
                  not just repos.
                </h1>
                <p className="text-lg md:text-xl text-bh-text-muted max-w-xl mb-8 animate-fade-in-up">
                  BuilderHunt aggregates public activity from GitHub, Reddit, Hacker News and DEV.to,
                  scores it for recency, and lets you save searches, get email alerts, and track the
                  people shipping the work — not just the repositories.
                </p>
                <div className="flex flex-wrap items-center gap-3 mb-8 animate-fade-in-up">
                  {isAuthed ? (
                    <LinkButton to="/dashboard" variant="primary" className="btn-lg">
                      Go to dashboard <ArrowRight className="w-4 h-4" aria-hidden="true" />
                    </LinkButton>
                  ) : (
                    <LinkButton to="/auth/sign-up" variant="primary" className="btn-lg">
                      Start hunting <ArrowRight className="w-4 h-4" aria-hidden="true" />
                    </LinkButton>
                  )}
                  <a href="#how-it-works" className="btn-secondary btn-lg">See how it works</a>
                </div>
                <ul className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-bh-text-muted animate-fade-in">
                  {['No credit card', 'OAuth-free', 'Email or RSS alerts'].map((t) => (
                    <li key={t} className="flex items-center gap-1.5">
                      <Check className="w-4 h-4 text-bh-success" aria-hidden="true" /> {t}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="relative animate-fade-in-up" style={{ animationDelay: '120ms' }}>
                <div className="card-glow">
                  <div className="p-2">
                    <img
                      src="/brand/hero-illustration.png"
                      alt="A magnifying glass scanning a network of connected developer avatars, representing BuilderHunt's multi-source builder discovery."
                      width={1280}
                      height={720}
                      loading="eager"
                      decoding="async"
                      className="rounded-xl w-full h-auto"
                    />
                  </div>
                </div>

                {/* Floating chips over the illustration */}
                <div className="hidden md:flex absolute -left-6 top-12 items-center gap-2 px-3 py-2 rounded-full bg-bh-surface border border-bh-border shadow-lg animate-fade-in" style={{ animationDelay: '400ms' }}>
                  <GithubIcon className="w-4 h-4 text-bh-github" title="GitHub" />
                  <span className="text-xs font-medium">+128 stars / 7d</span>
                </div>
                <div className="hidden md:flex absolute -right-4 top-1/3 items-center gap-2 px-3 py-2 rounded-full bg-bh-surface border border-bh-border shadow-lg animate-fade-in" style={{ animationDelay: '600ms' }}>
                  <Bell className="w-4 h-4 text-bh-accent" aria-hidden="true" />
                  <span className="text-xs font-medium">New match · HN</span>
                </div>
                <div className="hidden md:flex absolute left-8 -bottom-4 items-center gap-2 px-3 py-2 rounded-full bg-bh-surface border border-bh-border shadow-lg animate-fade-in" style={{ animationDelay: '800ms' }}>
                  <Brain className="w-4 h-4 text-bh-cyan" aria-hidden="true" />
                  <span className="text-xs font-medium">Score 92 · active</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ───────────────────── SOCIAL PROOF ───────────────────── */}
        <section className="border-y border-bh-border bg-bh-bg-alt/40">
          <div className="container py-10">
            <p className="text-center text-xs uppercase tracking-widest text-bh-text-dim mb-6 font-semibold">
              Aggregating activity from the platforms builders already use
            </p>
            <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-bh-text-muted">
              {[
                { name: 'GitHub', count: '420M+ profiles' },
                { name: 'Reddit', count: '100K+ dev communities' },
                { name: 'Hacker News', count: 'real-time signal' },
                { name: 'DEV.to', count: '1M+ articles' },
              ].map((s) => (
                <div key={s.name} className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-bh-accent" aria-hidden="true" />
                  <span className="font-semibold text-bh-text">{s.name}</span>
                  <span className="text-sm">· {s.count}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ─────────────────── HOW IT WORKS ────────────────────── */}
        <section id="how-it-works" className="section">
          <div className="container">
            <div className="max-w-2xl mx-auto text-center mb-16">
              <span className="eyebrow-neutral mb-4 inline-flex">
                <Target className="w-3.5 h-3.5" aria-hidden="true" /> How it works
              </span>
              <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
                Three steps from keyword to shortlist.
              </h2>
              <p className="text-lg text-bh-text-muted">
                Stop scrolling timelines. Define what you're looking for, let BuilderHunt
                do the discovery, and only review the people worth your attention.
              </p>
            </div>

            <ol className="grid md:grid-cols-3 gap-6">
              {[
                {
                  n: '01',
                  title: 'Define your hunt',
                  desc: 'Pick keywords, sources, language and country filters. Save as many searches as you like — one per topic, stack, or persona.',
                  icon: Search,
                },
                {
                  n: '02',
                  title: 'Get scored matches',
                  desc: 'A recency-weighted score surfaces builders who are shipping now, not who shipped three years ago. Open the profile to see all their signals in one place.',
                  icon: Sparkles,
                },
                {
                  n: '03',
                  title: 'Alert, export, follow up',
                  desc: 'New match? Get an email or RSS ping. Export the shortlist to CSV / JSON, attach private notes, share with your team.',
                  icon: Bell,
                },
              ].map((step) => (
                <li key={step.n} className="card card-hover relative overflow-hidden">
                  <div className="absolute -top-4 -right-4 text-7xl font-extrabold text-bh-border/40 select-none" aria-hidden="true">
                    {step.n}
                  </div>
                  <div className="relative">
                    <div className="w-12 h-12 rounded-xl bg-bh-accent-soft border border-bh-accent/20 flex items-center justify-center mb-4">
                      <step.icon className="w-6 h-6 text-bh-accent" aria-hidden="true" />
                    </div>
                    <h3 className="text-xl font-semibold mb-2">{step.title}</h3>
                    <p className="text-bh-text-muted">{step.desc}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ───────────────────── FEATURE GRID ──────────────────── */}
        <section className="section bg-bh-bg-alt/30 border-y border-bh-border">
          <div className="container">
            <div className="max-w-2xl mb-16">
              <span className="eyebrow mb-4 inline-flex">
                <Zap className="w-3.5 h-3.5" aria-hidden="true" /> Features
              </span>
              <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
                Built for the people who build things.
              </h2>
              <p className="text-lg text-bh-text-muted">
                No fluff. Every feature exists because it makes finding, scoring, and tracking
                builders faster than doing it by hand.
              </p>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[
                {
                  icon: Search,
                  title: 'Multi-source discovery',
                  desc: 'GitHub stars, HN upvotes, Reddit karma, DEV.to posts — indexed and cross-referenced so you can see one person across all four signals.',
                },
                {
                  icon: Sparkles,
                  title: 'Recency-weighted scoring',
                  desc: 'A 7-day-old commit is worth more than a 3-year-old star pile. Scores decay on a half-life curve so the top of your results are the people shipping now.',
                },
                {
                  icon: Bell,
                  title: 'Keyword alerts',
                  desc: 'Set it once. Get an email (or RSS feed) the moment a new builder matching your filters shows up. No daily digest, just signal.',
                },
                {
                  icon: FileText,
                  title: 'Private notes',
                  desc: 'Attach private context to any builder — outreach status, where you met them, why they matter. Only you see them.',
                },
                {
                  icon: Download,
                  title: 'CSV / JSON export',
                  desc: 'One-click export of any shortlist. Pipe it into Notion, Airtable, your ATS, or a spreadsheet. No lock-in.',
                },
                {
                  icon: Shield,
                  title: 'No tracking, no spam',
                  desc: 'We don\'t message builders on your behalf. We don\'t sell profile data. You find them, you reach out — the way it should be.',
                },
              ].map((f) => (
                <article key={f.title} className="card card-hover">
                  <div className="w-10 h-10 rounded-lg bg-bh-cyan-soft border border-bh-cyan/20 flex items-center justify-center mb-4">
                    <f.icon className="w-5 h-5 text-bh-cyan" aria-hidden="true" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2">{f.title}</h3>
                  <p className="text-bh-text-muted text-sm leading-relaxed">{f.desc}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ───────────────────── USE CASES ─────────────────────── */}
        <section id="use-cases" className="section">
          <div className="container">
            <div className="max-w-2xl mb-16">
              <span className="eyebrow-neutral mb-4 inline-flex">
                <Target className="w-3.5 h-3.5" aria-hidden="true" /> Who it's for
              </span>
              <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
                Whoever you need to find, BuilderHunt finds first.
              </h2>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              {[
                {
                  persona: 'Open-source maintainers',
                  pain: 'You\'re shipping a popular repo and need a few good co-maintainers, but the bar is high and the pool is wide.',
                  fix: 'Filter by language, country, and recent merged-PR velocity. Find people already shipping in your stack at the activity level you need.',
                },
                {
                  persona: 'Founders sourcing early hires',
                  pain: 'You need a senior engineer who actually writes, not just one who says they do. Resumes lie. Git history doesn\'t.',
                  fix: 'Search by domain keywords, see public activity, attach private notes per candidate. Export the shortlist when you\'re ready to reach out.',
                },
                {
                  persona: 'Recruiters & talent partners',
                  pain: 'Boolean strings on LinkedIn are noisy. You want the people who are visibly building, right now.',
                  fix: 'Set up a saved hunt per role, get an alert the moment someone matching the spec lights up across GitHub, HN, or Reddit.',
                },
                {
                  persona: 'DevRel & community teams',
                  pain: 'You want to invite the right people to your conference, your beta, or your program — but you can\'t read every timeline.',
                  fix: 'Discover the active voices in your topic without DMs, scraping, or sending mass emails. Reach out to the ones worth your time.',
                },
              ].map((c) => (
                <article key={c.persona} className="card">
                  <h3 className="text-xl font-semibold mb-3">{c.persona}</h3>
                  <div className="space-y-3 text-sm">
                    <div>
                      <p className="text-bh-text-dim font-semibold uppercase tracking-wider text-xs mb-1">Pain</p>
                      <p className="text-bh-text-muted">{c.pain}</p>
                    </div>
                    <div>
                      <p className="text-bh-accent font-semibold uppercase tracking-wider text-xs mb-1">How BuilderHunt helps</p>
                      <p className="text-bh-text">{c.fix}</p>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ───────────────────── SOURCES ───────────────────────── */}
        <section id="sources" className="section border-t border-bh-border">
          <div className="container">
            <div className="max-w-2xl mb-16">
              <span className="eyebrow mb-4 inline-flex">
                <GithubIcon className="w-3.5 h-3.5" title="GitHub" /> Sources
              </span>
              <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
                Signal from the four places builders actually are.
              </h2>
              <p className="text-lg text-bh-text-muted">
                All sources work without API tokens. Add a GitHub token (optional) to lift rate limits
                on heavier searches.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { name: 'GitHub', color: 'badge-github', Icon: GithubIcon, desc: 'Stars, forks, PRs, releases, language mix, commit recency.' },
                { name: 'Reddit', color: 'badge-reddit', Icon: RedditIcon, desc: 'Subreddit karma, top posts, comment velocity in dev subs.' },
                { name: 'Hacker News', color: 'badge-hn', Icon: HackerNewsIcon, desc: 'Submission upvotes, comment karma, top-story activity.' },
                { name: 'DEV.to', color: 'badge-devto', Icon: DevToIcon, desc: 'Article publishes, reactions, follow counts, tag mix.' },
              ].map((s) => (
                <article key={s.name} className="card">
                  <span className={`badge ${s.color} mb-3 inline-flex items-center gap-1.5`}>
                    <s.Icon className="w-3 h-3" title={s.name} /> {s.name}
                  </span>
                  <p className="text-bh-text-muted text-sm leading-relaxed">{s.desc}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ───────────────────── TESTIMONIAL ────────────────────── */}
        <section className="section border-t border-bh-border bg-bh-bg-alt/30">
          <div className="container-narrow text-center">
            <div className="flex justify-center gap-1 mb-6" aria-label="5 out of 5 stars">
              {[...Array(5)].map((_, i) => (
                <Star key={i} className="w-5 h-5 fill-bh-warning text-bh-warning" aria-hidden="true" />
              ))}
            </div>
            <blockquote className="text-2xl md:text-3xl font-medium leading-snug mb-6">
              "I spent two hours a week curating a list of contributors for our OSS project.
              BuilderHunt does it in the background and pings me when someone new is worth a look.
              It paid for itself in the first week."
            </blockquote>
            <footer className="text-bh-text-muted text-sm">
              — <cite>Beta user</cite> · open-source maintainer, Rust tooling
            </footer>
          </div>
        </section>

        {/* ───────────────────── FAQ ───────────────────────────── */}
        <section id="faq" className="section">
          <div className="container-narrow">
            <div className="text-center mb-12">
              <span className="eyebrow-neutral mb-4 inline-flex">FAQ</span>
              <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
                Common questions.
              </h2>
            </div>

            <FAQSection />
          </div>
        </section>

        {/* ───────────────────── FINAL CTA ─────────────────────── */}
        <section className="section border-t border-bh-border bg-gradient-to-b from-bh-bg-alt/40 to-bh-bg">
          <div className="container-narrow text-center">
            <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
              Start hunting the right builders.
            </h2>
            <p className="text-lg text-bh-text-muted max-w-xl mx-auto mb-8">
              Free during public beta. Set up your first hunt in under a minute — no credit card,
              no demo call, no waiting list.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              {isAuthed ? (
                <LinkButton to="/dashboard" variant="primary" className="btn-lg">
                  Go to dashboard <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </LinkButton>
              ) : (
                <>
                  <LinkButton to="/auth/sign-up" variant="primary" className="btn-lg">
                    Create free account <ArrowRight className="w-4 h-4" aria-hidden="true" />
                  </LinkButton>
                  <LinkButton to="/auth/sign-in" variant="secondary" className="btn-lg">
                    I already have an account
                  </LinkButton>
                </>
              )}
            </div>
            <p className="text-sm text-bh-text-dim mt-6 flex items-center justify-center gap-2">
              <Mail className="w-3.5 h-3.5" aria-hidden="true" />
              Or get the launch notes in your inbox
              <span className="text-bh-text-muted">— coming soon</span>
            </p>
          </div>
        </section>
      </main>

      {/* ───────────────────────── FOOTER ──────────────────────── */}
      <Footer />
      <BackToTop />
    </>
  )
}
