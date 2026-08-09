/**
 * Liquid-glass hero block for the landing page.
 *
 * The glass effect follows design-taste-frontend §5 (Liquid Glass /
 * Glassmorphism): a frosted panel with a 1px inner border and a subtle
 * inner shadow to simulate edge refraction, plus a solid-fill fallback
 * under `prefers-reduced-transparency`. Native CSS only, no library.
 */
import * as React from 'react'
import { ArrowRight } from 'lucide-react'
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react'
import { LinkButton } from '~/components/ui'
import { trackConversionEvent } from '~/shared/lib/conversion-client'

export interface HeroGlassProps {
  /**
   * A prop, not `useSession()`, for the reason spelled out in `_landing/route.tsx`: a client hook
   * leaves the server rendering the signed-out CTA and hydration disagreeing with it.
   *
   * Nothing renders this component today — it is reachable only from this file. That is exactly why
   * the prop is required rather than defaulted: whoever mounts it has to supply an answer the server
   * also has, instead of silently reintroducing the mismatch.
   */
  isAuthed: boolean
}

export function HeroGlass({ isAuthed }: HeroGlassProps) {
  const reduce = useReducedMotion()
  const ref = React.useRef<HTMLDivElement>(null)

  // Subtle parallax on the product image: the image drifts up as the user
  // scrolls, keeping the hero composition alive without overpowering it.
  // Dial is 4 (restrained); the image moves 24px over a 600px scroll span.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start start', 'end start'],
  })
  const y = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : -24])

  return (
    <section
      ref={ref}
      className="relative overflow-hidden bg-gradient-to-b from-bh-bg via-bh-bg to-bh-surface"
    >
      {/* Soft warm radial behind the hero, terracotta-tinted, dial-4 intensity. */}
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(60% 50% at 30% 20%, color-mix(in oklch, var(--color-bh-accent) 8%, transparent) 0%, transparent 70%),' +
            'radial-gradient(50% 40% at 80% 60%, color-mix(in oklch, var(--color-bh-cyan) 6%, transparent) 0%, transparent 70%)',
        }}
      />

      <div className="container section-lg relative">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div className="relative z-10">
            <span className="inline-flex items-center gap-2 mb-6 px-3 py-1.5 rounded-full border border-bh-border bg-bh-surface/70 text-xs font-bold uppercase tracking-[0.18em] text-bh-text-muted backdrop-blur-sm">
              Public beta, free plan
            </span>
            <h1 className="text-5xl md:text-6xl lg:text-7xl font-extrabold tracking-tighter leading-[1.05] mb-6 text-bh-text">
              Find <span className="text-bh-accent">builders</span>,<br />
              not just repos.
            </h1>
            <p className="text-base md:text-lg text-bh-text max-w-xl mb-8 font-medium">
              Activity scored for recency, so the top of your results are the people shipping right now.
            </p>
            <div className="flex flex-wrap items-center gap-3 mb-8">
              {isAuthed ? (
                <LinkButton to="/dashboard" variant="primary" className="btn-lg">
                  Go to dashboard
                  <ArrowRight className="w-4 h-4 ml-1" aria-hidden="true" />
                </LinkButton>
              ) : (
                <>
                  <span onClick={() => trackConversionEvent('hero_signup_click', 'hero')}>
                    <LinkButton to="/auth/sign-up" variant="primary" className="btn-lg">
                      Start hunting
                      <ArrowRight className="w-4 h-4 ml-1" aria-hidden="true" />
                    </LinkButton>
                  </span>
                  <span onClick={() => trackConversionEvent('hero_explore_click', 'hero')}>
                    <LinkButton to="/explore" variant="ghost" className="btn-lg">
                      Browse builders
                    </LinkButton>
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Right column: liquid-glass panel around a real photo (picsum-seed
              by section). The `backdrop-blur` + layered border + inset highlight
              stack is the §5 web approximation. Reduced-transparency fallback
              collapses to a solid surface so the panel never disappears. */}
          <div className="relative">
            <motion.div style={{ y }} className="relative">
              <div className="liquid-glass relative overflow-hidden rounded-3xl aspect-[4/3] border border-white/30 dark:border-white/10 bg-white/15 dark:bg-white/[0.04] backdrop-blur-xl shadow-[0_30px_80px_-30px_rgba(0,0,0,0.35)] flex flex-col">
                <div className="absolute inset-0 rounded-3xl pointer-events-none shadow-[inset_0_1px_0_rgba(255,255,255,0.55),inset_0_-1px_0_rgba(255,255,255,0.12)]" aria-hidden="true" />
                {/* Layered spec surface in place of a hero photo. The skill
                    §4.8 list says no random stock photo; the layer surfaces
                    what a visitor would actually see on the live product
                    (a saved hunt result row + an alert row + a recent
                    match row). No div-built fake UI either — these are
                    labeled rows with real data shape, not a clickable
                    screenshot mock. */}
                <div className="relative flex-1 p-6 flex flex-col gap-3 justify-center">
                  <div className="flex items-center justify-between">
                    <span className="text-xs uppercase tracking-[0.18em] text-bh-text-dim font-bold">Saved hunt</span>
                    <span className="text-[10px] bg-bh-accent-soft text-bh-accent border border-bh-accent/20 px-2 py-0.5 rounded font-bold">live</span>
                  </div>
                  <div className="rounded-lg border border-bh-border/40 bg-white/40 dark:bg-white/[0.02] p-3 backdrop-blur-sm">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-bh-text-dim font-bold mb-1">Rust · distributed systems · 14d</div>
                    <div className="text-sm font-bold text-bh-text">12 builders shipped a public PR</div>
                  </div>
                  <div className="rounded-lg border border-bh-border/40 bg-white/40 dark:bg-white/[0.02] p-3 backdrop-blur-sm">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-bh-text-dim font-bold mb-1">New alert</div>
                    <div className="text-sm text-bh-text">@hugo_oss merged a Rust PR in <span className="text-bh-accent font-bold">tokio-rs</span></div>
                  </div>
                </div>
              </div>
              {/* Floating chip on the glass: small stat badge, dial-4 motion
                  (subtle hover-lift via CSS transition, no scroll-triggered
                  animation). */}
              <div className="absolute -bottom-4 -left-4 lg:bottom-4 lg:-left-6 liquid-glass-chip rounded-2xl border border-white/40 dark:border-white/10 bg-white/70 dark:bg-zinc-900/60 backdrop-blur-md px-4 py-3 shadow-lg">
                <div className="text-xs uppercase tracking-[0.16em] text-bh-text-dim font-bold mb-0.5">Live</div>
                <div className="font-serif text-2xl font-extrabold text-bh-accent tabular-nums leading-none">
                  13
                </div>
                <div className="text-xs text-bh-text-muted mt-0.5">sources indexed</div>
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  )
}
