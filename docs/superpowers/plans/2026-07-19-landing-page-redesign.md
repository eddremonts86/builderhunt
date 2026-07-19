# Landing Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the BuilderHunt landing page to make it visually spectacular, warm-light themed, responsive, and interactive across five key sections.

**Architecture:** Use CSS keyframe animations for the marquee, CSS Grid/subgrid for bento styling, React hooks/state for interactive tab elements, and inline SVGs/components for visual mockups in the timeline and bento cards.

**Tech Stack:** React 19, Tailwind CSS v4, Lucide Icons, Playwright for E2E testing.

## Global Constraints
- Target visual theme: Warm-light (cream backgrounds, terracotta accent `#e07338`).
- Maintain WCAG AA contrast ratio (> 4.5:1) for all text.
- Do not modify any core database schema or auth logic; focus purely on landing page UI elements.

---

### Task 1: CSS Animations & Design Tokens Setup

**Files:**
- Modify: `src/shared/styles/globals.css`

**Interfaces:**
- Consumes: None
- Produces: CSS utility classes for infinite scrolling marquee, custom animations, bento styling, and glow effects.

- [ ] **Step 1: Write CSS rules in globals.css**

Add the following classes and keyframes to the end of `src/shared/styles/globals.css` (lines 446+):

```css
/* Infinite Scrolling Marquee */
.marquee-container {
  display: flex;
  overflow: hidden;
  user-select: none;
  gap: 2rem;
  mask-image: linear-gradient(to right, transparent, black 15%, black 85%, transparent);
  -webkit-mask-image: linear-gradient(to right, transparent, black 15%, black 85%, transparent);
}

.marquee-content {
  display: flex;
  flex-shrink: 0;
  gap: 2rem;
  align-items: center;
  justify-content: space-around;
  min-inline-size: 100%;
  animation: scroll-marquee 30s linear infinite;
}

.marquee-container:hover .marquee-content {
  animation-play-state: paused;
}

@keyframes scroll-marquee {
  from { transform: translateX(0); }
  to { transform: translateX(calc(-100% - 2rem)); }
}

/* Hover border-glow and card lifts */
.card-premium-glow {
  position: relative;
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.3s;
}

.card-premium-glow:hover {
  transform: translateY(-4px);
  border-color: var(--color-bh-accent) !important;
  box-shadow: 0 12px 30px -10px rgba(224, 115, 56, 0.15) !important;
}

/* Timeline vertical/horizontal lines */
.timeline-dot {
  position: relative;
  z-index: 10;
}

.timeline-line {
  position: absolute;
  background-image: repeating-linear-gradient(90deg, var(--color-bh-border), var(--color-bh-border) 6px, transparent 6px, transparent 12px);
}
```

- [ ] **Step 2: Verify globals.css is error-free**

Run: `pnpm build`
Expected: Success build.

- [ ] **Step 3: Commit**

```bash
git add src/shared/styles/globals.css
git commit -m "style(theme): add marquee keyframes and premium card glow utilities"
```

---

### Task 2: Redesign Social Proof Bar (Area 1)

**Files:**
- Modify: `src/modules/landing/components/HomePage.tsx:200-220`

**Interfaces:**
- Consumes: Tailwind styles from Task 1.
- Produces: Autoscrolling social proof bar showing source activity.

- [ ] **Step 1: Replace standard text columns with continuous marquee**

Update the social proof section inside `src/modules/landing/components/HomePage.tsx`:

```tsx
        {/* ───────────────────── SOCIAL PROOF ───────────────────── */}
        <section className="border-y border-bh-border bg-bh-bg-alt/30 py-8 overflow-hidden">
          <div className="container">
            <p className="text-center text-xs uppercase tracking-widest text-bh-text-dim mb-6 font-bold">
              Aggregating activity from the platforms builders already use
            </p>
            <div className="marquee-container">
              <div className="marquee-content">
                {[
                  { name: 'GitHub', count: '420M+ profiles', desc: 'Stars, commits & PRs', Icon: GithubIcon, color: 'text-[#24292f]' },
                  { name: 'Reddit', count: '100K+ dev communities', desc: 'Karma & comments', Icon: RedditIcon, color: 'text-[#ff4500]' },
                  { name: 'Hacker News', count: 'Real-time signal', desc: 'Upvotes & top-stories', Icon: HackerNewsIcon, color: 'text-[#d05300]' },
                  { name: 'DEV.to', count: '1M+ articles', desc: 'Articles & reactions', Icon: DevToIcon, color: 'text-[#09090b]' },
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
                  { name: 'GitHub', count: '420M+ profiles', desc: 'Stars, commits & PRs', Icon: GithubIcon, color: 'text-[#24292f]' },
                  { name: 'Reddit', count: '100K+ dev communities', desc: 'Karma & comments', Icon: RedditIcon, color: 'text-[#ff4500]' },
                  { name: 'Hacker News', count: 'Real-time signal', desc: 'Upvotes & top-stories', Icon: HackerNewsIcon, color: 'text-[#d05300]' },
                  { name: 'DEV.to', count: '1M+ articles', desc: 'Articles & reactions', Icon: DevToIcon, color: 'text-[#09090b]' },
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
```

- [ ] **Step 2: Verify local build**

Run: `pnpm build`
Expected: Success build.

- [ ] **Step 3: Commit**

```bash
git add src/modules/landing/components/HomePage.tsx
git commit -m "feat(landing): implement continuous infinite-scrolling social proof bar"
```

---

### Task 3: Redesign Three Steps Timeline (Area 2)

**Files:**
- Modify: `src/modules/landing/components/HomePage.tsx:238-272`

**Interfaces:**
- Consumes: Icons from `lucide-react`.
- Produces: Timeline component layout connecting the 3 steps with visual previews.

- [ ] **Step 1: Replace steps cards with connected timeline & product previews**

Update the "How it works" section cards in `src/modules/landing/components/HomePage.tsx` to use the timeline format:

```tsx
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
                          <span className="text-[10px] bg-[#ff4500]/10 border border-[#ff4500]/20 text-[#c03600] px-1.5 py-0.5 rounded-full font-bold">Reddit</span>
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
                        <button type="button" className="flex-1 bg-bh-surface border border-bh-border rounded-lg py-1 px-1.5 text-[10px] font-bold text-bh-text-muted hover:border-bh-border-strong inline-flex items-center justify-center gap-1">
                          <Download className="w-3 h-3" /> Export
                        </button>
                        <button type="button" className="flex-1 bg-bh-accent text-white rounded-lg py-1 px-1.5 text-[10px] font-bold inline-flex items-center justify-center gap-1">
                          <Bell className="w-3 h-3" /> Alerts
                        </button>
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
```

- [ ] **Step 2: Verify local build**

Run: `pnpm build`
Expected: Success build.

- [ ] **Step 3: Commit**

```bash
git commit -a -m "feat(landing): replace static steps with interactive connected timeline and product previews"
```

---

### Task 4: Implement Features Bento Grid (Area 3)

**Files:**
- Modify: `src/modules/landing/components/HomePage.tsx:292-334`

**Interfaces:**
- Consumes: Icons from `lucide-react`.
- Produces: Layout featuring 2 wider Bento cards with inline SVG graphics and 4 standard cards.

- [ ] **Step 1: Replace feature grid with bento grid structure**

Update the feature grid section in `src/modules/landing/components/HomePage.tsx`:

```tsx
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
                    <div className="w-6 h-6 rounded-full bg-bh-accent flex items-center justify-center text-white text-[10px] font-bold">JD</div>
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
```

- [ ] **Step 2: Verify local build**

Run: `pnpm build`
Expected: Success build.

- [ ] **Step 3: Commit**

```bash
git commit -a -m "feat(landing): convert standard grid to interactive Bento Grid with SVG visual charts"
```

---

### Task 5: Implement Use Cases Persona Selector (Area 4)

**Files:**
- Modify: `src/modules/landing/components/HomePage.tsx:349-386`

**Interfaces:**
- Consumes: Icons from `lucide-react`, React hooks state.
- Produces: Interactive tab component updating the selected persona preview layout.

- [ ] **Step 1: Write tab state & persona selection logic**

Inside the `HomePage` component code (lines 30+), add the selected persona state:

```tsx
  const [activePersonaIdx, setActivePersonaIdx] = React.useState(0)
```

- [ ] **Step 2: Replace Use Cases list with tabbed interface layout**

Update the use cases section in `src/modules/landing/components/HomePage.tsx`:

```tsx
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
```

- [ ] **Step 3: Verify local build**

Run: `pnpm build`
Expected: Success build.

- [ ] **Step 4: Commit**

```bash
git commit -a -m "feat(landing): replace use cases static cards with interactive persona tab selector"
```

---

### Task 6: Premium Footer & Newsletter Signup (Area 5 & 4)

**Files:**
- Modify: `src/shared/components/Footer.tsx:17-73`
- Modify: `src/modules/landing/components/HomePage.tsx:482-487`

**Interfaces:**
- Consumes: Tailwind styles.
- Produces: Re-styled footer component and dynamic newsletter signup box on the landing page CTA.

- [ ] **Step 1: Add newsletter signup form input to the landing CTA**

Update the email signup text in the CTA area of `src/modules/landing/components/HomePage.tsx` (around lines 480+):

```tsx
            <div className="max-w-md mx-auto mt-8 p-1 bg-bh-surface border border-bh-border/80 rounded-xl flex shadow-sm focus-within:ring-2 focus-within:ring-bh-accent/40 focus-within:border-bh-accent transition-all">
              <input
                type="email"
                placeholder="Enter your email"
                className="bg-transparent border-0 outline-none px-3 py-2 text-sm text-bh-text flex-grow placeholder:text-bh-text-dim"
                aria-label="Newsletter email input"
              />
              <button type="submit" className="btn-primary btn-sm px-4 rounded-lg font-bold">
                Join Alerts
              </button>
            </div>
            <p className="text-xs text-bh-text-dim mt-3">
              We send launch updates and feature summaries. No spam, unsubscribe anytime.
            </p>
```

- [ ] **Step 2: Restructure the Footer layout**

Update the `Footer` component in `src/shared/components/Footer.tsx` (lines 17-73):

```tsx
export function Footer() {
  return (
    <footer className="border-t border-bh-border bg-bh-bg-alt/30" data-testid="site-footer">
      <div className="container py-16">
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-12 mb-12">
          <div className="lg:col-span-2">
            <Link to="/" className="flex items-center gap-2.5 mb-4 group">
              <Logo size={28} />
              <span className="font-bold text-lg tracking-tight group-hover:text-bh-accent transition-colors">BuilderHunt</span>
            </Link>
            <p className="text-sm text-bh-text-muted max-w-sm leading-relaxed">
              Find active open-source builders across the open web. Track GitHub stars, Hacker News comments, and Reddit velocity from one clean dashboard.
            </p>
          </div>
          <div>
            <h3 className="font-bold text-bh-text mb-4 text-xs uppercase tracking-wider">Product</h3>
            <ul className="space-y-2.5 text-sm text-bh-text-muted">
              <li><Link to="/explore" className="hover:text-bh-accent transition-colors" data-testid="footer-explore">Explore Profiles</Link></li>
              <li><Link to="/blog" className="hover:text-bh-accent transition-colors" data-testid="footer-blog">Blog & Case Studies</Link></li>
              <li><Link to="/pricing" className="hover:text-bh-accent transition-colors" data-testid="footer-pricing">Pricing Plans</Link></li>
              <li><a href="/#how-it-works" className="hover:text-bh-accent transition-colors">How it works</a></li>
            </ul>
          </div>
          <div>
            <h3 className="font-bold text-bh-text mb-4 text-xs uppercase tracking-wider">Trust & Legal</h3>
            <ul className="space-y-2.5 text-sm text-bh-text-muted">
              <li>
                <Link to="/status" className="hover:text-bh-accent transition-colors inline-flex items-center gap-1.5" data-testid="footer-status">
                  <span className="w-1.5 h-1.5 rounded-full bg-bh-success inline-block" aria-hidden="true" />
                  Status
                </Link>
              </li>
              <li><Link to="/changelog" className="hover:text-bh-accent transition-colors" data-testid="footer-changelog">Changelog</Link></li>
              <li><Link to="/legal/terms" className="hover:text-bh-accent transition-colors" data-testid="footer-terms">Terms of Service</Link></li>
              <li><Link to="/legal/privacy" className="hover:text-bh-accent transition-colors" data-testid="footer-privacy">Privacy Policy</Link></li>
            </ul>
          </div>
          <div>
            <h3 className="font-bold text-bh-text mb-4 text-xs uppercase tracking-wider">Contact</h3>
            <ul className="space-y-2.5 text-sm text-bh-text-muted">
              <li><a href="mailto:privacy@builderhunt.dev" className="hover:text-bh-accent transition-colors" data-testid="footer-do-not-sell">Do Not Sell My Info</a></li>
              <li><a href="mailto:support@builderhunt.dev" className="hover:text-bh-accent transition-colors">Get Support</a></li>
              <li><span className="text-xs bg-bh-accent-soft border border-bh-accent/20 text-bh-accent px-2 py-0.5 rounded-full font-bold">Beta version</span></li>
            </ul>
          </div>
        </div>
        <div className="pt-8 border-t border-bh-border/65 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-bh-text-dim">
          <p>© {new Date().getFullYear()} BuilderHunt. Built for builders, by builders.</p>
          <p>Made with ☕ in Barcelona, Madrid &amp; remote.</p>
        </div>
      </div>
    </footer>
  )
}
```

- [ ] **Step 3: Verify local build**

Run: `pnpm build`
Expected: Success build.

- [ ] **Step 4: Commit**

```bash
git commit -a -m "feat(footer): redesign footer with premium spacing, columns, and newsletter signup box"
```

---

### Task 7: E2E Testing & Visual Verification

**Files:**
- Create: `test/test-landing-redesign.mjs`

**Interfaces:**
- Consumes: Running dev server.
- Produces: E2E test confirmation verifying elements exist and interactive tabs work.

- [ ] **Step 1: Create E2E test script**

Create `test/test-landing-redesign.mjs`:

```javascript
// E2E verification test for the landing page redesign
import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'

async function run() {
  console.log('🚀 Running E2E verification for Landing Page Redesign...')
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()

  // 1. Visit homepage
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)

  // 2. Check Marquee exists
  const marquee = await page.$('.marquee-container')
  if (marquee) {
    console.log('✅ Marquee container is present.')
  } else {
    throw new Error('❌ Marquee container not found!')
  }

  // 3. Check Timeline elements are present
  const steps = await page.$$('li.card-premium-glow')
  if (steps.length >= 3) {
    console.log(`✅ Steps timeline contains cards. Count: ${steps.length}`)
  } else {
    throw new Error(`❌ Timeline step card count mismatch! Found: ${steps.length}`)
  }

  // 4. Check Bento grid feature cards
  const bentoScoring = await page.$('text:has-text("Recency-weighted scoring")')
  if (bentoScoring) {
    console.log('✅ Bento feature card: Recency-weighted scoring is present.')
  }

  // 5. Check Persona selection interactive tabs
  const tabButton = await page.$('button:has-text("Founders sourcing hires")')
  if (tabButton) {
    console.log('✅ Persona tabs found. Clicking second tab...')
    await tabButton.click()
    await page.waitForTimeout(500)
    
    // Check panel has updated
    const updatedPane = await page.$('text:has-text("Saved Candidate Hunt")')
    if (updatedPane) {
      console.log('✅ Persona interactive pane updated successfully on tab click!')
    } else {
      throw new Error('❌ Interactive showcase did not update correctly!')
    }
  } else {
    throw new Error('❌ Persona tabs not found!')
  }

  // 6. Check newsletter form and footer
  const signupInput = await page.$('input[aria-label="Newsletter email input"]')
  if (signupInput) {
    console.log('✅ Newsletter email signup is present.')
  } else {
    throw new Error('❌ Newsletter input not found!')
  }

  const footer = await page.$('[data-testid="site-footer"]')
  if (footer) {
    console.log('✅ Redesigned footer is present.')
  } else {
    throw new Error('❌ Site footer not found!')
  }

  await browser.close()
  console.log('🎉 All E2E landing page verification tests passed!')
  process.exit(0)
}

run().catch((e) => {
  console.error('❌ E2E Verification failed:', e)
  process.exit(1)
})
```

- [ ] **Step 2: Start dev server in background and run E2E test**

Run: `node test/test-landing-redesign.mjs`
Expected: "All E2E landing page verification tests passed!" output.

- [ ] **Step 3: Commit**

```bash
git add test/test-landing-redesign.mjs
git commit -m "test(landing): add E2E verification tests for redesigned sections"
```
