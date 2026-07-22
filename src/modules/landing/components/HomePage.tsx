import * as React from 'react'
import { LinkButton, Input } from '~/components/ui'
import {
  Sparkles, Target, ArrowRight, Check, Search,
  Bell, FileText, Download, Zap, Shield, Star
} from 'lucide-react'
import { useSession } from '~/shared/lib/auth/client'
import { GithubIcon, RedditIcon, HackerNewsIcon, DevToIcon } from './BrandIcons'
import { FAQSection } from './FAQSection'

export function HomePage() {
  const session = useSession()
  const [activePersonaIdx, setActivePersonaIdx] = React.useState(0)
  const isAuthed = !!session.data?.user

  return (
    <>
      <div id="main-content">
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
                      src="/images/search-desktop.png"
                      alt="BuilderHunt's search page: 118 real results for “react” across GitHub, Reddit and other sources, each with a match score."
                      width={1280}
                      height={973}
                      loading="eager"
                      decoding="async"
                      className="rounded-xl w-full h-auto"
                    />
                  </div>
                </div>

                {/* Real mobile screenshot, peeking from the corner — same live
                    results, proof the product (not a mockup) works on any screen. */}
                <div
                  className="hidden lg:block absolute -bottom-10 -right-10 w-36 rounded-[20px] border-4 border-bh-surface bg-bh-surface shadow-2xl overflow-hidden animate-fade-in-up"
                  style={{ animationDelay: '360ms' }}
                >
                  <img
                    src="/images/search-mobile.png"
                    alt="The same search results on a phone."
                    width={360}
                    height={220}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-44 object-cover object-top"
                  />
                </div>

                {/* One real, live signal — not decorative chips duplicating what's already on screen. */}
                <div className="hidden md:flex absolute -left-6 top-10 items-center gap-2 px-3 py-2 rounded-full bg-bh-surface border border-bh-border shadow-lg animate-fade-in" style={{ animationDelay: '500ms' }}>
                  <GithubIcon className="w-4 h-4 text-bh-github" title="GitHub" />
                  <span className="text-xs font-medium">+128 stars / 7d</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ───────────────────── SOCIAL PROOF ───────────────────── */}
        <section className="border-y border-bh-border bg-bh-bg-alt/30 py-8 overflow-hidden">
          <div className="container">
            <p className="text-center text-xs uppercase tracking-widest text-bh-text-dim mb-6 font-bold">
              Aggregating activity from the platforms builders already use
            </p>
            <div className="marquee-container">
              <div className="marquee-content">
                {[
                  { name: 'GitHub', count: '420M+ profiles', desc: 'Stars, commits & PRs', Icon: GithubIcon, color: 'text-bh-github' },
                  { name: 'Reddit', count: '100K+ dev communities', desc: 'Karma & comments', Icon: RedditIcon, color: 'text-bh-reddit' },
                  { name: 'Hacker News', count: 'Real-time signal', desc: 'Upvotes & top-stories', Icon: HackerNewsIcon, color: 'text-bh-hn' },
                  { name: 'DEV.to', count: '1M+ articles', desc: 'Articles & reactions', Icon: DevToIcon, color: 'text-bh-devto' },
                ].map((s, idx) => (
                  <div key={`${s.name}-1-${idx}`} className="flex items-center gap-4 bg-bh-surface border border-bh-border/50 rounded-2xl px-6 py-4 shadow-sm min-w-[280px] hover:border-bh-accent/40 transition-colors">
                    <s.Icon className={`w-8 h-8 ${s.color}`} title={s.name} />
                    <div>
                      <div className="font-bold text-bh-text flex items-center gap-1.5">
                        {s.name}
                        <span className="w-1 h-1 rounded-full bg-bh-accent" />
                        <span className="text-xs font-semibold text-bh-accent">{s.count}</span>
                      </div>
                      <div className="text-xs text-bh-text-muted">{s.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="marquee-content" aria-hidden="true">
                {[
                  { name: 'GitHub', count: '420M+ profiles', desc: 'Stars, commits & PRs', Icon: GithubIcon, color: 'text-bh-github' },
                  { name: 'Reddit', count: '100K+ dev communities', desc: 'Karma & comments', Icon: RedditIcon, color: 'text-bh-reddit' },
                  { name: 'Hacker News', count: 'Real-time signal', desc: 'Upvotes & top-stories', Icon: HackerNewsIcon, color: 'text-bh-hn' },
                  { name: 'DEV.to', count: '1M+ articles', desc: 'Articles & reactions', Icon: DevToIcon, color: 'text-bh-devto' },
                ].map((s, idx) => (
                  <div key={`${s.name}-2-${idx}`} className="flex items-center gap-4 bg-bh-surface border border-bh-border/50 rounded-2xl px-6 py-4 shadow-sm min-w-[280px] hover:border-bh-accent/40 transition-colors">
                    <s.Icon className={`w-8 h-8 ${s.color}`} title={s.name} />
                    <div>
                      <div className="font-bold text-bh-text flex items-center gap-1.5">
                        {s.name}
                        <span className="w-1 h-1 rounded-full bg-bh-accent" />
                        <span className="text-xs font-semibold text-bh-accent">{s.count}</span>
                      </div>
                      <div className="text-xs text-bh-text-muted">{s.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
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

            <div className="relative">
              {/* Dotted Connection Line for desktop */}
              <div className="hidden md:block absolute top-24 left-[15%] right-[15%] h-0.5 border-t-2 border-dashed border-bh-border/80 z-0" aria-hidden="true" />
              
              <ol className="grid md:grid-cols-3 gap-8 relative z-10">
                {[
                  {
                    n: '01',
                    title: 'Define your hunt',
                    desc: 'Pick keywords, sources, language and country filters. Save as many searches as you like — one per stack or persona.',
                    icon: Search,
                    preview: (
                      <div className="bg-bh-bg/50 border border-bh-border/60 rounded-xl p-3 text-left font-sans mt-4">
                        <div className="flex items-center gap-2 bg-bh-surface border border-bh-border rounded-lg px-2.5 py-1.5 text-xs text-bh-text-muted">
                          <Search className="w-3.5 h-3.5 text-bh-accent" />
                          <span>Keywords: <strong className="text-bh-text">React, TypeScript</strong></span>
                        </div>
                        <div className="flex flex-wrap gap-1 mt-2">
                          <span className="text-[10px] bg-bh-accent-soft border border-bh-accent/20 text-bh-accent px-1.5 py-0.5 rounded-full font-bold">GitHub</span>
                          <span className="badge badge-reddit text-[10px] px-1.5 py-0.5">Reddit</span>
                        </div>
                      </div>
                    )
                  },
                  {
                    n: '02',
                    title: 'Get scored matches',
                    desc: 'A recency-weighted score surfaces builders shipping now. Open profiles to view cross-platform signals in one place.',
                    icon: Sparkles,
                    preview: (
                      <div className="bg-bh-bg/50 border border-bh-border/60 rounded-xl p-3 mt-4 text-left">
                        <div className="flex items-center justify-between bg-bh-surface border border-bh-border rounded-lg p-2">
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-full bg-bh-accent-soft border border-bh-accent/20 flex items-center justify-center text-[10px] font-bold text-bh-accent">JD</div>
                            <span className="text-xs font-bold text-bh-text">Jane Dev</span>
                          </div>
                          <span className="text-xs bg-bh-success/15 border border-bh-success/30 text-bh-success px-2 py-0.5 rounded font-mono font-bold">Score 98</span>
                        </div>
                      </div>
                    )
                  },
                  {
                    n: '03',
                    title: 'Alert, export, follow up',
                    desc: 'New match? Get an email or RSS ping. Export your shortlist to CSV / JSON, attach private notes, and share.',
                    icon: Bell,
                    preview: (
                      <div className="bg-bh-bg/50 border border-bh-border/60 rounded-xl p-3 mt-4 flex justify-between gap-1.5">
                        <span className="flex-1 bg-bh-surface border border-bh-border rounded-lg py-1 px-1.5 text-[10px] font-bold text-bh-text-muted inline-flex items-center justify-center gap-1">
                          <Download className="w-3 h-3" /> Export
                        </span>
                        <span className="flex-1 bg-bh-accent text-[color:var(--color-bh-accent-contrast)] rounded-lg py-1 px-1.5 text-[10px] font-bold inline-flex items-center justify-center gap-1">
                          <Bell className="w-3 h-3" /> Alerts
                        </span>
                      </div>
                    )
                  },
                ].map((step) => (
                  <li key={step.n} className="card card-premium-glow relative overflow-hidden bg-bh-surface p-6 flex flex-col justify-between min-h-[300px]">
                    <div>
                      <div className="flex items-center justify-between mb-4">
                        <div className="w-12 h-12 rounded-2xl bg-bh-accent-soft border border-bh-accent/20 flex items-center justify-center timeline-dot">
                          <step.icon className="w-6 h-6 text-bh-accent" aria-hidden="true" />
                        </div>
                        <span className="text-4xl font-extrabold text-bh-accent/20 font-serif leading-none">{step.n}</span>
                      </div>
                      <h3 className="text-xl font-bold text-bh-text mb-2">{step.title}</h3>
                      <p className="text-bh-text-muted text-sm leading-relaxed">{step.desc}</p>
                    </div>
                    {step.preview}
                  </li>
                ))}
              </ol>
            </div>
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
              {/* Feature 1: Multi-source discovery (Bento Large) */}
              <article className="card card-premium-glow md:col-span-2 flex flex-col justify-between bg-bh-surface p-6">
                <div>
                  <div className="w-10 h-10 rounded-lg bg-bh-cyan-soft border border-bh-cyan/20 flex items-center justify-center mb-4">
                    <Search className="w-5 h-5 text-bh-cyan" aria-hidden="true" />
                  </div>
                  <h3 className="text-xl font-bold text-bh-text mb-2">Multi-source discovery</h3>
                  <p className="text-bh-text-muted text-sm leading-relaxed max-w-xl">
                    GitHub stars, HN upvotes, Reddit karma, DEV.to posts — indexed and cross-referenced so you can see one person across all four signals.
                  </p>
                </div>
                
                {/* SVG Visual: Central Developer avatar connected to sources */}
                <div className="mt-6 bg-bh-bg/40 border border-bh-border/50 rounded-xl p-4 flex items-center justify-center gap-6 h-28 relative overflow-hidden">
                  <div className="flex items-center gap-1.5 bg-bh-surface border border-bh-border/60 shadow-sm rounded-lg px-3 py-1.5 z-10">
                    <div className="w-6 h-6 rounded-full bg-bh-accent flex items-center justify-center text-[color:var(--color-bh-accent-contrast)] text-[10px] font-bold">JD</div>
                    <span className="text-xs font-bold text-bh-text">Developer Profile</span>
                  </div>
                  <svg className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true">
                    <line x1="15%" y1="50%" x2="50%" y2="50%" stroke="var(--color-bh-accent)" strokeWidth="1" strokeDasharray="4 4" opacity="0.4" />
                    <line x1="50%" y1="50%" x2="85%" y2="50%" stroke="var(--color-bh-cyan)" strokeWidth="1" strokeDasharray="4 4" opacity="0.4" />
                  </svg>
                  <div className="flex gap-3 z-10">
                    <span className="p-2 bg-bh-surface border border-bh-border rounded-lg shadow-sm"><GithubIcon className="w-4 h-4 text-bh-github" title="GitHub" /></span>
                    <span className="p-2 bg-bh-surface border border-bh-border rounded-lg shadow-sm"><RedditIcon className="w-4 h-4 text-bh-reddit" title="Reddit" /></span>
                    <span className="p-2 bg-bh-surface border border-bh-border rounded-lg shadow-sm"><HackerNewsIcon className="w-4 h-4 text-bh-hn" title="Hacker News" /></span>
                  </div>
                </div>
              </article>

              {/* Feature 2: Recency-weighted scoring (Bento Standard) */}
              <article className="card card-premium-glow flex flex-col justify-between bg-bh-surface p-6">
                <div>
                  <div className="w-10 h-10 rounded-lg bg-bh-cyan-soft border border-bh-cyan/20 flex items-center justify-center mb-4">
                    <Sparkles className="w-5 h-5 text-bh-cyan" aria-hidden="true" />
                  </div>
                  <h3 className="text-lg font-bold text-bh-text mb-2">Recency-weighted scoring</h3>
                  <p className="text-bh-text-muted text-sm leading-relaxed">
                    A 7-day commit is worth more than a 3-year-old star pile. Scores decay on a half-life curve so you see active shippers.
                  </p>
                </div>
                {/* SVG Visual: Decay Curve */}
                <div className="mt-4 bg-bh-bg/40 border border-bh-border/50 rounded-xl p-3 flex items-end justify-center h-20">
                  <svg className="w-full h-12" viewBox="0 0 120 40" fill="none" aria-hidden="true">
                    <path d="M10 5 Q 40 35 110 38" stroke="var(--color-bh-accent)" strokeWidth="2" />
                    <circle cx="10" cy="5" r="3.5" fill="var(--color-bh-accent)" />
                    <circle cx="45" cy="20" r="3" fill="var(--color-bh-cyan)" />
                    <circle cx="108" cy="38" r="3" fill="var(--color-bh-text-dim)" />
                    <text x="18" y="10" fill="var(--color-bh-text)" fontSize="8" fontWeight="bold">New commit</text>
                    <text x="65" y="32" fill="var(--color-bh-text-dim)" fontSize="7">3 yr old stars</text>
                  </svg>
                </div>
              </article>

              {/* Standard grid items */}
              {[
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
                <article key={f.title} className="card card-premium-glow bg-bh-surface p-6 flex flex-col justify-between">
                  <div>
                    <div className="w-10 h-10 rounded-lg bg-bh-cyan-soft border border-bh-cyan/20 flex items-center justify-center mb-4">
                      <f.icon className="w-5 h-5 text-bh-cyan" aria-hidden="true" />
                    </div>
                    <h3 className="text-lg font-bold text-bh-text mb-2">{f.title}</h3>
                    <p className="text-bh-text-muted text-sm leading-relaxed">{f.desc}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ───────────────────── USE CASES ─────────────────────── */}
        <section id="use-cases" className="section bg-bh-surface">
          <div className="container">
            <div className="max-w-2xl mb-12">
              <span className="eyebrow-neutral mb-4 inline-flex">
                <Target className="w-3.5 h-3.5" aria-hidden="true" /> Who it's for
              </span>
              <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-4 text-bh-text">
                Whoever you need to find, BuilderHunt finds first.
              </h2>
            </div>

            {/* Persona Interactive tabs */}
            <div className="grid lg:grid-cols-12 gap-8 items-start">
              <div className="lg:col-span-4 flex flex-col gap-2">
                {[
                  { title: 'Open-source maintainers', icon: GithubIcon },
                  { title: 'Founders sourcing hires', icon: Target },
                  { title: 'Recruiters & talent partners', icon: Search },
                  { title: 'DevRel & community teams', icon: Sparkles },
                ].map((p, idx) => {
                  const active = activePersonaIdx === idx
                  return (
                    <button
                      key={p.title}
                      type="button"
                      onClick={() => setActivePersonaIdx(idx)}
                      className={`flex items-center gap-3 w-full text-left px-5 py-4 rounded-xl border text-sm font-bold transition-all ${
                        active
                          ? 'bg-bh-accent-soft border-bh-accent/30 text-bh-accent shadow-sm'
                          : 'bg-bh-surface border-bh-border/50 text-bh-text-muted hover:bg-bh-bg/50 hover:text-bh-text'
                      }`}
                    >
                      <p.icon className="w-4 h-4" />
                      <span>{p.title}</span>
                    </button>
                  )
                })}
              </div>

              {/* Persona Showcase Panel */}
              <div className="lg:col-span-8">
                {[
                  {
                    persona: 'Open-source maintainers',
                    pain: 'You are shipping a popular repository and need a few good co-maintainers, but the bar is high and the pool is wide.',
                    fix: 'Filter by language, country, and recent merged-PR velocity. Find people already shipping in your stack at the activity level you need.',
                    preview: (
                      <div className="border border-bh-border/60 rounded-xl p-4 bg-bh-bg/30 text-left font-sans">
                        <div className="flex items-center justify-between border-b border-bh-border/50 pb-2 mb-3">
                          <span className="text-xs font-bold text-bh-text">Shortlisted Contributors</span>
                          <span className="text-[10px] bg-bh-accent/10 text-bh-accent border border-bh-accent/25 px-1.5 py-0.5 rounded font-bold">24 Active</span>
                        </div>
                        <div className="space-y-2">
                          <div className="flex justify-between items-center bg-bh-surface border border-bh-border/60 rounded-lg p-2 text-xs">
                            <span className="font-bold text-bh-text">@hugo_oss</span>
                            <span className="text-bh-accent font-semibold font-mono">14 PRs merged / 14d</span>
                          </div>
                          <div className="flex justify-between items-center bg-bh-surface border border-bh-border/60 rounded-lg p-2 text-xs">
                            <span className="font-bold text-bh-text">@anna_codes</span>
                            <span className="text-bh-accent font-semibold font-mono">8 PRs merged / 14d</span>
                          </div>
                        </div>
                      </div>
                    )
                  },
                  {
                    persona: 'Founders sourcing early hires',
                    pain: 'You need a senior engineer who actually writes code, not just one who says they do. Resumes lie. Git history does not.',
                    fix: 'Search by domain keywords, see public activity, attach private notes per candidate. Export the shortlist when you are ready to reach out.',
                    preview: (
                      <div className="border border-bh-border/60 rounded-xl p-4 bg-bh-bg/30 text-left font-sans">
                        <div className="flex items-center justify-between border-b border-bh-border/50 pb-2 mb-3">
                          <span className="text-xs font-bold text-bh-text">Saved Candidate Hunt</span>
                          <span className="text-[10px] bg-bh-cyan-soft text-bh-cyan border border-bh-cyan/20 px-1.5 py-0.5 rounded font-bold">Senior TS/Rust</span>
                        </div>
                        <div className="bg-bh-surface border border-bh-border/60 rounded-lg p-3 text-xs">
                          <div className="font-bold text-bh-text mb-1">Alex Miller (Shortlist candidate)</div>
                          <div className="text-bh-text-muted text-[11px] italic">"Notes: Built the core rust-db driver. Prefers remote. Highly skilled."</div>
                        </div>
                      </div>
                    )
                  },
                  {
                    persona: 'Recruiters & talent partners',
                    pain: 'Boolean strings on LinkedIn are noisy. You want the people who are visibly building, right now.',
                    fix: 'Set up a saved hunt per role, get an alert the moment someone matching the spec lights up across GitHub, HN, or Reddit.',
                    preview: (
                      <div className="border border-bh-border/60 rounded-xl p-4 bg-bh-bg/30 text-left font-sans">
                        <div className="flex items-center justify-between border-b border-bh-border/50 pb-2 mb-3">
                          <span className="text-xs font-bold text-bh-text">Email / RSS Alert Stream</span>
                          <span className="w-2.5 h-2.5 rounded-full bg-bh-success animate-pulse" />
                        </div>
                        <div className="flex gap-2 items-center bg-bh-surface border border-bh-border/60 rounded-lg p-2 text-xs">
                          <Bell className="w-3.5 h-3.5 text-bh-accent" />
                          <div>
                            <div className="font-semibold text-bh-text">New match: developer in Berlin</div>
                            <div className="text-[10px] text-bh-text-dim">Matched keywords: Kubernetes, Go</div>
                          </div>
                        </div>
                      </div>
                    )
                  },
                  {
                    persona: 'DevRel & community teams',
                    pain: 'You want to invite the right people to your conference, your beta, or your program — but you cannot read every timeline.',
                    fix: 'Discover the active voices in your topic without DMs, scraping, or sending mass emails. Reach out to the ones worth your time.',
                    preview: (
                      <div className="border border-bh-border/60 rounded-xl p-4 bg-bh-bg/30 text-left font-sans">
                        <div className="flex items-center justify-between border-b border-bh-border/50 pb-2 mb-3">
                          <span className="text-xs font-bold text-bh-text">Active Subreddit/HN Voices</span>
                        </div>
                        <div className="space-y-2">
                          <div className="bg-bh-surface border border-bh-border/60 rounded-lg p-2 text-xs flex justify-between">
                            <span className="font-bold text-bh-text">@r_coder</span>
                            <span className="text-bh-accent text-[11px] font-mono">Top contributor (r/reactjs)</span>
                          </div>
                        </div>
                      </div>
                    )
                  },
                ].map((c, idx) => {
                  if (activePersonaIdx !== idx) return null
                  return (
                    <article key={c.persona} className="card bg-bh-surface border border-bh-border p-8 grid md:grid-cols-2 gap-8 items-center animate-fade-in">
                      <div>
                        <h3 className="text-2xl font-bold text-bh-text mb-4">{c.persona}</h3>
                        <div className="space-y-4">
                          <div>
                            <p className="text-bh-text-dim font-bold uppercase tracking-wider text-[10px] mb-1">The Problem</p>
                            <p className="text-bh-text-muted text-sm leading-relaxed">{c.pain}</p>
                          </div>
                          <div>
                            <p className="text-bh-accent font-bold uppercase tracking-wider text-[10px] mb-1">How BuilderHunt helps</p>
                            <p className="text-bh-text text-sm leading-relaxed">{c.fix}</p>
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-col justify-center h-full">
                        <p className="text-bh-text-dim font-bold uppercase tracking-wider text-[10px] mb-2 text-center md:text-left">Interactive Showcase</p>
                        {c.preview}
                      </div>
                    </article>
                  )
                })}
              </div>
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
            <div className="max-w-md mx-auto mt-8 p-1 bg-bh-surface border border-bh-border/80 rounded-xl flex shadow-sm focus-within:ring-2 focus-within:ring-bh-accent/40 focus-within:border-bh-accent transition-all">
              <Input
                type="email"
                placeholder="Enter your email"
                className="!bg-transparent !border-0 !shadow-none !rounded-none !px-3 !py-2 text-sm text-bh-text flex-grow placeholder:text-bh-text-dim"
                aria-label="Newsletter email input"
              />
              <button type="submit" className="btn-primary btn-sm px-4 rounded-lg font-bold">
                Join Alerts
              </button>
            </div>
            <p className="text-xs text-bh-text-dim mt-3">
              We send launch updates and feature summaries. No spam, unsubscribe anytime.
            </p>
          </div>
        </section>
      </div>
    </>
  )
}
