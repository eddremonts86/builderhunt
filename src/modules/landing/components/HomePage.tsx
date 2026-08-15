import * as React from 'react'
import { LinkButton } from '~/components/ui'
import {
  Sparkles, Target, ArrowRight, Check, Search,
  Bell, FileText, Download, Zap, Shield
} from 'lucide-react'
import { GithubIcon, RedditIcon, HackerNewsIcon, DevToIcon } from './BrandIcons'
import { FAQSection } from './FAQSection'
import { trackConversionEvent } from '~/shared/lib/conversion-client'
import { SegmentSelector } from '~/modules/landing/components/SegmentSelector'
import { SEARCH_SOURCE_COUNT } from '~/shared/lib/search-connectors'

export interface HomePageProps {
  /**
   * Resolved on the server by `_landing/route.tsx`'s `beforeLoad` and passed in by
   * `_landing/index.tsx`. Read from `useSession()` here, it was absent during SSR and possibly
   * present on the client's first render — a hydration mismatch on every CTA below.
   */
  isAuthed: boolean
}

export function HomePage({ isAuthed }: HomePageProps) {
  const [activePersonaIdx, setActivePersonaIdx] = React.useState(0)

  React.useEffect(() => {
    trackConversionEvent('landing_view', 'hero')
  }, [])

  return (
    <>
        {/* ───────────────────────── HERO ───────────────────────── */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 bg-grid" aria-hidden="true" />
          <div className="container section-lg relative">
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              <div>
                <span className="eyebrow mb-6 inline-flex animate-fade-in">
                  <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                  Public beta · Free plan, no credit card
                </span>
                <h1 className="text-5xl md:text-6xl lg:text-7xl font-extrabold tracking-tighter leading-[1.05] mb-6 animate-fade-in-up">
                  Find <span className="text-bh-accent">builders</span>,<br />
                  not just repos.
                </h1>
                {/* The differentiator — kept as a single sentence so the hero stays
                    within the pre-flight cap of 4 text elements + 1+1 CTAs (§4.7).
                    The full product pitch used to live below in a second paragraph;
                    it is now part of the closing CTA copy on the page. */}
                <p className="text-base md:text-lg text-bh-text max-w-xl mb-8 font-medium animate-fade-in-up">
                  Activity scored for recency, so the top of your results are the people shipping right now.
                </p>
                <div className="flex flex-wrap items-center gap-3 mb-8 animate-fade-in-up">
                  {isAuthed ? (
                    <LinkButton to="/dashboard" variant="primary" className="btn-lg">
                      Go to dashboard <ArrowRight className="w-4 h-4" aria-hidden="true" />
                    </LinkButton>
                  ) : (
                    <>
                      {/* onClick on the wrapper (not the Link itself) — TanStack's
                          typed LinkProps doesn't accept a raw onClick, and event
                          bubbling from the inner anchor reaches it identically. */}
                      <span onClick={() => trackConversionEvent('hero_signup_click', 'hero')}>
                        <LinkButton to="/auth/sign-up" variant="primary" className="btn-lg">
                          Start hunting <ArrowRight className="w-4 h-4" aria-hidden="true" />
                        </LinkButton>
                      </span>
                      {/* Secondary CTA: drop the solid secondary variant. An outline
                          button reads as "the other choice" without competing with the
                          primary. Copy went from "Try it without an account" (implies
                          friction) to "Browse builders" (describes the action and its
                          destination — /explore). Impeccable fix-ui-ux C1. */}
                      <span onClick={() => trackConversionEvent('hero_explore_click', 'hero')}>
                        <LinkButton to="/explore" variant="ghost" className="btn-lg" data-testid="hero-explore-cta">
                          Browse builders
                        </LinkButton>
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="relative animate-fade-in-up" style={{ animationDelay: '120ms' }}>
                <div className="card-glow">
                  <div className="p-2">
                    {/* This is the page's LCP element — responsive AVIF/WebP
                        with the PNG kept only as a last-resort fallback, plus
                        fetchPriority so the browser fetches it before other
                        below-priority resources. */}
                    <picture>
                      <source
                        type="image/avif"
                        srcSet="/images/search-desktop-640.avif 640w, /images/search-desktop-1280.avif 1280w, /images/search-desktop-1920.avif 1920w"
                        sizes="(min-width: 1024px) 45vw, 100vw"
                      />
                      <source
                        type="image/webp"
                        srcSet="/images/search-desktop-640.webp 640w, /images/search-desktop-1280.webp 1280w, /images/search-desktop-1920.webp 1920w"
                        sizes="(min-width: 1024px) 45vw, 100vw"
                      />
                      <img
                        src="/images/search-desktop.png"
                        alt="BuilderHunt's search page: 118 real results for “react” across GitHub, Reddit and other sources, each with a match score."
                        width={1280}
                        height={973}
                        loading="eager"
                        decoding="async"
                        fetchPriority="high"
                        className="rounded-xl w-full h-auto"
                      />
                    </picture>
                  </div>
                </div>

                {/* Real mobile screenshot, peeking from the corner — same live
                    results, proof the product (not a mockup) works on any screen.
                    Stays lazy + inside a `hidden` (display:none) ancestor below
                    `lg`, so it isn't fetched on phones where it's never shown. */}
                <div
                  className="hidden lg:block absolute -bottom-10 -right-10 w-36 rounded-[20px] border-4 border-bh-surface bg-bh-surface shadow-2xl overflow-hidden animate-fade-in-up"
                  style={{ animationDelay: '360ms' }}
                >
                  <picture>
                    <source
                      type="image/avif"
                      srcSet="/images/search-mobile-360.avif 360w, /images/search-mobile-720.avif 720w"
                      sizes="144px"
                    />
                    <source
                      type="image/webp"
                      srcSet="/images/search-mobile-360.webp 360w, /images/search-mobile-720.webp 720w"
                      sizes="144px"
                    />
                    <img
                      src="/images/search-mobile.png"
                      alt="The same search results on a phone."
                      width={360}
                      height={220}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-44 object-cover object-top"
                    />
                  </picture>
                </div>

              </div>
            </div>
          </div>
        </section>

        {/*
          The three segment routes, in their own band (plan: phase-2/06-landing-segmentada).

          Below the hero rather than inside it: the hero documents a cap of four text elements plus
          one primary and one secondary CTA (§4.7), and three more links would break it. Its own band
          also means nothing above moves, so every visual baseline of the hero is unchanged.

          Offered, never required. The main message answers on its own and somebody who does not want
          to classify themselves never has to — a landing that made people choose before showing them
          anything would turn an optional question into a toll.
        */}
        <section className="container py-8" aria-labelledby="segment-routes">
          <h2 id="segment-routes" className="sr-only">Start with what brings you here</h2>
          <SegmentSelector heading="Or start with what brings you here" />
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
                  { name: 'GitHub', desc: 'Stars, commits & PRs', Icon: GithubIcon, color: 'text-bh-github' },
                  { name: 'Reddit', desc: 'Karma & comments', Icon: RedditIcon, color: 'text-bh-reddit' },
                  { name: 'Hacker News', desc: 'Upvotes & top-stories', Icon: HackerNewsIcon, color: 'text-bh-hn' },
                  { name: 'DEV.to', desc: 'Articles & reactions', Icon: DevToIcon, color: 'text-bh-devto' },
                  { name: '+ 11 more sources', desc: 'GitLab, Codeberg, Stack Overflow, npm and others', Icon: Sparkles, color: 'text-bh-text-muted' },
                ].map((s, idx) => (
                  <div key={`${s.name}-1-${idx}`} className="flex items-center gap-4 bg-bh-surface border border-bh-border/50 rounded-2xl px-6 py-4 shadow-sm min-w-[280px] hover:border-bh-accent/40 transition-colors">
                    <s.Icon className={`w-8 h-8 ${s.color}`} title={s.name} />
                    <div>
                      <div className="font-bold text-bh-text">{s.name}</div>
                      <div className="text-xs text-bh-text-muted">{s.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="marquee-content" aria-hidden="true">
                {[
                  { name: 'GitHub', desc: 'Stars, commits & PRs', Icon: GithubIcon, color: 'text-bh-github' },
                  { name: 'Reddit', desc: 'Karma & comments', Icon: RedditIcon, color: 'text-bh-reddit' },
                  { name: 'Hacker News', desc: 'Upvotes & top-stories', Icon: HackerNewsIcon, color: 'text-bh-hn' },
                  { name: 'DEV.to', desc: 'Articles & reactions', Icon: DevToIcon, color: 'text-bh-devto' },
                  { name: '+ 11 more sources', desc: 'GitLab, Codeberg, Stack Overflow, npm and others', Icon: Sparkles, color: 'text-bh-text-muted' },
                ].map((s, idx) => (
                  <div key={`${s.name}-2-${idx}`} className="flex items-center gap-4 bg-bh-surface border border-bh-border/50 rounded-2xl px-6 py-4 shadow-sm min-w-[280px] hover:border-bh-accent/40 transition-colors">
                    <s.Icon className={`w-8 h-8 ${s.color}`} title={s.name} />
                    <div>
                      <div className="font-bold text-bh-text">{s.name}</div>
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
              <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
                Three steps from keyword to shortlist.
              </h2>
              <p className="text-lg text-bh-text-muted">
                Pick keywords, let BuilderHunt cross-reference public activity across
                sources, and review only the people worth your attention.
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
                    desc: 'Pick keywords, sources, language and country filters. Save as many searches as you like, one per stack or persona.',
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
                          <span className="text-xs bg-bh-success/15 border border-bh-success/30 text-bh-success px-2 py-0.5 rounded font-bold">Score 98</span>
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
                        {/* Decorative — the `<ol>` already conveys step order to
                            assistive tech; a faint 20%-opacity numeral fails
                            text-contrast checks for no accessibility benefit. */}
                        <span className="text-4xl font-extrabold text-bh-accent/20 font-serif leading-none" aria-hidden="true">{step.n}</span>
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
                Every feature is here because it makes finding, scoring, or tracking
                builders faster than doing it by hand.
              </p>
            </div>

            {/* `grid-cols-1` is not redundant with the implicit single column. Without it the grid's one column
                is `auto`-sized, which means "as wide as my widest child's min-content" — one card here has a
                ~350px min-content width, so the column grew past a 320px viewport and took the document with
                it. Tailwind's `grid-cols-1` is `repeat(1, minmax(0, 1fr))`, and the `minmax(0, ...)` is the
                part that caps it at the container. */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {/* Feature 1: Multi-source discovery (Bento Large).
                  The original preview was a fake-UI div (central avatar + 3 source
                  pills + connector lines), which is the #1 LLM-design Tell per
                  `design-taste-frontend` §9.F "Fake product previews". Replace
                  with a real seeded image that grounds the abstract claim in
                  something a visitor can see. Picsum-seed by section name so the
                  asset is reproducible and stable across rebuilds. */}
              <article className="card card-premium-glow md:col-span-2 flex flex-col justify-between bg-bh-surface p-6 overflow-hidden">
                <div>
                  <div className="w-10 h-10 rounded-lg bg-bh-cyan-soft border border-bh-cyan/20 flex items-center justify-center mb-4">
                    <Search className="w-5 h-5 text-bh-cyan" aria-hidden="true" />
                  </div>
                  <h3 className="text-xl font-bold text-bh-text mb-2">Multi-source discovery</h3>
                  <p className="text-bh-text-muted text-sm leading-relaxed max-w-xl">
                    GitHub stars, HN upvotes, Reddit karma, DEV.to posts. We index them and dedupe by person, so a single profile shows up across all four.
                  </p>
                </div>

                {/* Editorial number + brief evidence statement instead of a div-built
                    fake UI. The number interpolates `SEARCH_SOURCE_COUNT` so the
                    regression guard in trust-claims.test.ts stays green. */}
                <div className="mt-6 grid grid-cols-[auto_1fr] gap-4 items-end">
                  <div className="font-serif text-6xl md:text-7xl font-extrabold tracking-tight text-bh-accent leading-none tabular-nums">
                    {SEARCH_SOURCE_COUNT}
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] text-bh-text-dim font-bold mb-1">Sources</div>
                    <p className="text-sm text-bh-text leading-snug">
                      indexed across GitHub, Reddit, Hacker News, DEV.to and 9 more, scored and deduped to one profile per person.
                    </p>
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
                    A 7-day commit is worth more than a 3-year-old star pile. Scores decay on a half-life curve, so the top of your results is whoever shipped most recently.
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
                  desc: 'Set the filters once. We send an email or RSS ping the moment a new builder matches. No daily digest, just the hits that matter.',
                },
                {
                  icon: FileText,
                  title: 'Private notes',
                  desc: 'Stash private context on any builder: outreach status, where you met them, why they matter. Only you see them.',
                },
                {
                  icon: Download,
                  title: 'CSV / JSON export',
                  desc: 'Export any shortlist to CSV or JSON. Pipe it into Notion, Airtable, your ATS, or a spreadsheet. No lock-in.',
                },
                {
                  icon: Shield,
                  title: 'No tracking, no spam',
                  desc: 'We don\'t message builders on your behalf and we don\'t sell profile data. You find them, you reach out. That\'s the whole model.',
                },
              ].map((f) => (
                <article key={f.title} className="card card-premium-glow bg-bh-surface p-6 flex flex-col justify-between overflow-hidden">
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
              <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-4 text-bh-text">
                Whoever you need to find, we surface them first.
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
                    pain: "You're shipping a popular repo and need a few good co-maintainers. The bar is high and the pool is wide.",
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
                            <span className="text-bh-accent font-semibold">14 PRs merged / 14d</span>
                          </div>
                          <div className="flex justify-between items-center bg-bh-surface border border-bh-border/60 rounded-lg p-2 text-xs">
                            <span className="font-bold text-bh-text">@anna_codes</span>
                            <span className="text-bh-accent font-semibold">8 PRs merged / 14d</span>
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
                    pain: 'You want to invite the right people to your conference, your beta, or your program, but you cannot read every timeline.',
                    fix: 'Discover the active voices in your topic without DMs, scraping, or sending mass emails. Reach out to the ones worth your time.',
                    preview: (
                      <div className="border border-bh-border/60 rounded-xl p-4 bg-bh-bg/30 text-left font-sans">
                        <div className="flex items-center justify-between border-b border-bh-border/50 pb-2 mb-3">
                          <span className="text-xs font-bold text-bh-text">Active Subreddit/HN Voices</span>
                        </div>
                        <div className="space-y-2">
                          <div className="bg-bh-surface border border-bh-border/60 rounded-lg p-2 text-xs flex justify-between">
                            <span className="font-bold text-bh-text">@r_coder</span>
                            <span className="text-bh-accent text-[11px]">Top contributor (r/reactjs)</span>
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
                Signal from the places builders actually are.
              </h2>
              <p className="text-lg text-bh-text-muted">
                Every source works out of the box. No setup, no API keys to bring.
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

        {/* ───────────────────── FAQ ───────────────────────────── */}
        <section id="faq" className="section">
          <div className="container-narrow">
            <div className="text-center mb-12">
              <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-4 text-bh-text">
                Common questions, answered.
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
              {/* This CTA used to promise that sign-up had no queue to wait in. Dropped rather
                  than reworded: `ACCESS_ALLOWLIST_ENABLED` gates sign-up behind an
                  `access_requests` approval queue, so the promise is false whenever production
                  has the flag on — and the flag exists to be turned on. The regression guard in
                  trust-claims.test.ts matches raw source, so don't restate the old phrasing. */}
              Start on the Free plan, no credit card, no demo call. Set up your first hunt in
              under a minute, and upgrade only when you outgrow the limits.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              {isAuthed ? (
                <LinkButton to="/dashboard" variant="primary" className="btn-lg">
                  Go to dashboard <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </LinkButton>
              ) : (
                <>
                  <span onClick={() => trackConversionEvent('hero_signup_click', 'final_cta')}>
                    <LinkButton to="/auth/sign-up" variant="primary" className="btn-lg">
                      Create free account <ArrowRight className="w-4 h-4" aria-hidden="true" />
                    </LinkButton>
                  </span>
                  <LinkButton to="/auth/sign-in" variant="secondary" className="btn-lg">
                    I already have an account
                  </LinkButton>
                </>
              )}
            </div>
          </div>
        </section>
    </>
  )
}
