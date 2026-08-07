/**
 * Sticky-stack pattern for the "Three steps from keyword to shortlist"
 * section. As each card scrolls into view it pins, the next card slides
 * over it, and the previous one shrinks. Implemented with Motion's
 * `useScroll` + `useTransform` (the skill's preferred stack for landing
 * pages — Motion, not GSAP).
 *
 * Dial: 4 (restrained). Sticky distance is one viewport, scale 0.94 at the
 * bottom of each card's run, opacity 0.6. Reduced-motion skips pinning
 * and renders a plain stack.
 */
import * as React from 'react'
import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from 'motion/react'

interface StickyStep {
  number: string
  title: string
  body: string
  image: string
  imageAlt: string
}

interface StickyStackProps {
  steps: StickyStep[]
}

export function StickyStack({ steps }: StickyStackProps) {
  const reduce = useReducedMotion()
  const containerRef = React.useRef<HTMLDivElement>(null)

  if (reduce) {
    return (
      <div className="grid md:grid-cols-3 gap-8">
        {steps.map((step) => (
          <StepCard key={step.number} step={step} />
        ))}
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative">
      {steps.map((step, i) => (
        <StickyStep key={step.number} step={step} index={i} total={steps.length} />
      ))}
    </div>
  )
}

function StickyStep({
  step,
  index,
  total,
}: {
  step: StickyStep
  index: number
  total: number
}) {
  const ref = React.useRef<HTMLDivElement>(null)

  // The card's own scroll progress through the container; 0 when the card
  // first sticks at the top of the viewport, 1 when it is about to be
  // pushed off by the next card.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start start', 'end start'],
  })

  // Drive visual stack from the same progress value.
  const scale = useTransform(scrollYProgress, [0, 1], [1, 0.94])
  const opacity = useTransform(scrollYProgress, [0, 1], [1, 0.6])
  const y = useTransform(scrollYProgress, [0, 1], [0, -40])

  const isLast = index === total - 1

  return (
    <div
      ref={ref}
      className="min-h-[100dvh] flex items-center justify-center px-4 py-12"
      style={{ zIndex: index + 1 }}
    >
      <motion.div
        style={isLast ? undefined : { scale, opacity, y }}
        className="card card-premium-glow bg-bh-surface p-6 md:p-10 max-w-3xl w-full rounded-3xl border border-bh-border/60 overflow-hidden"
      >
        <StepCard step={step} />
      </motion.div>
    </div>
  )
}

function StepCard({ step }: { step: StickyStep }) {
  return (
    <>
      <div className="grid md:grid-cols-2 gap-6 items-center">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-bh-text-dim font-bold mb-3">
            {step.number}
          </div>
          <h3 className="text-2xl md:text-3xl font-extrabold tracking-tight text-bh-text mb-3">
            {step.title}
          </h3>
          <p className="text-bh-text-muted leading-relaxed">{step.body}</p>
        </div>
        <div className="relative rounded-2xl overflow-hidden aspect-[4/3] bg-bh-bg/40">
          <img
            src={step.image}
            alt={step.imageAlt}
            loading="lazy"
            className="w-full h-full object-cover"
          />
        </div>
      </div>
    </>
  )
}
