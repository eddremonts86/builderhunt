import * as React from 'react'
import { motion } from 'motion/react'
import { fadeInUpVariants, staggerContainer } from '~/shared/lib/motion/tokens'
import {
  SPAN_CLASS,
  resolveBentoLayout,
  type BentoDensity,
  type BentoWidget,
} from './layout'

/**
 * The bento grid and its bubble.
 *
 * The bubble is `.card` from globals.css — same 24px radius, border and diffusion
 * shadow the dashboard already uses. This file adds no new surface treatment; it
 * decides how wide each bubble is and, crucially, lets each one be exactly as
 * tall as its content.
 */

/**
 * The field: 1 column on phones, 6 at `md`, 12 at `xl`. Rows are as tall as their
 * tallest tile, and tiles stretch to fill them.
 *
 * ## Two mechanisms were removed here on 2026-08-06, for one reason
 *
 * This grid used to combine `grid-flow-row-dense` with a JS masonry: rows of 4px,
 * no row gap, and a ResizeObserver writing `grid-row-end: span N` per tile. Both
 * exist to pack tiles tightly, and **both reorder the page.**
 *
 * `dense` does it openly — it backfills a gap by promoting a later tile into it.
 * The masonry does it subtly, and that was the harder one to see: with tiles
 * placed on a 4px row grid, a short tile beside a tall one leaves its column free
 * further down, and the *next* tile cascades into that space. Measured on the real
 * dashboard, `plan-usage` landed in the left column at y=2171 while
 * `recent-builders`, which precedes it in the DOM, sat in the right column at
 * y=2173. Read left-to-right, the later widget came first.
 *
 * The old comment argued the divergence was "acceptable here because every tile is
 * an independent, separately-labelled region rather than a step in a sequence".
 * That was true of a mosaic of read-only cards. It stopped being true when the
 * dashboard became an urgency-ordered command surface: the tiles carry links and
 * controls, and the order is the product's central claim
 * (plans/ui-dashboard, structural problem 3).
 *
 * So the layout is now plain CSS Grid with content-height rows. DOM order, focus
 * order and visual order are one sequence at every width, with no tolerance and no
 * measurement involved.
 *
 * **What this costs, stated plainly:** tiles in a band now share the band's height,
 * so a short tile beside a tall one is padded. That is the dead space the masonry
 * was built to reclaim. It is a smaller cost than it was for the version *before*
 * the masonry, which padded every tile to a multiple of a 176px row unit whether or
 * not it had content — here the row is exactly as tall as its tallest member. The
 * remedy is to band widgets of similar height together in the registry, which is a
 * choice an author can make and a reader can see, unlike a runtime cascade.
 */
/**
 * ## Why there is no `useReducedMotion()` branch here any more
 *
 * There was one, on both this container and the tile: `initial={reduceMotion ? false : 'hidden'}`
 * and `variants={reduceMotion ? undefined : fadeInUpVariants}`. It did not work, and it left the
 * grid **permanently invisible** for exactly the viewers it was meant to accommodate.
 *
 * `useReducedMotion()` snapshots a module-level global with `useState` and never updates it, and on
 * the server that global is its default `false`. So the server rendered the `hidden` keyframe inline
 * — `opacity: 0`, `translateY(12px)` — and the hydrating client, now correctly told to reduce
 * motion, dropped the variants that were the only thing that would have animated it to `opacity: 1`.
 * Nothing remained to clear the inline style, so nine widgets stayed at zero opacity indefinitely
 * while holding their full height: invisible without being absent, which no screenshot diff and no
 * height comparison can describe.
 *
 * The preference is now honoured by `MotionConfig reducedMotion="user"` at the root, which is read
 * when an animation runs rather than when a component mounts. Keeping the variants unconditional is
 * what guarantees `opacity` always has something driving it to its resting value.
 */
export function BentoGrid({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      className={`grid grid-cols-1 md:grid-cols-6 xl:grid-cols-12 gap-4 items-stretch ${className}`}
      variants={staggerContainer()}
      initial="hidden"
      animate="visible"
    >
      {children}
    </motion.div>
  )
}

interface BentoTileProps {
  span: keyof typeof SPAN_CLASS
  /** Adds the accent→cyan rim of `.card-glow`. One per screen, at most. */
  glow?: boolean
  /** Drops the bubble chrome — for tiles that embed a component bringing its own. */
  bare?: boolean
  className?: string
  children: React.ReactNode
  /** Surfaced as `data-widget` so specs can target a tile without a CSS class. */
  widgetId?: string
}

/**
 * One bubble: a containment context, and its own height.
 *
 * `@container` is load-bearing. A widget's usable width is set by its span, not
 * by the viewport, so viewport breakpoints cannot describe it: a `twoThirds` tile
 * is 821px on a 1560px screen and a `full` tile is 736px on a 768px one. Widgets
 * therefore use container variants and adapt to the tile they were given.
 *
 * Container-query thresholds are content-box widths. A tile with `p-6` queries
 * 48px narrower than it looks, which is easy to get wrong by exactly one tile.
 */
export function BentoTile({
  span, glow = false, bare = false, className = '', children, widgetId,
}: BentoTileProps) {
  const surface = bare ? '' : glow ? 'card-glow p-6' : 'card card-hover'

  return (
    // Unconditional variants — see `BentoGrid` for what the reduced-motion branch here cost.
    <motion.div
      variants={fadeInUpVariants}
      /**
       * The animation library writes `opacity` and `transform` inline here, and this attribute is how
       * a harness addresses that without guessing at the DOM shape.
       *
       * `tests/regression/test-accessibility.mjs` pins these to their resting values with an
       * `!important` rule, because racing the entrance is what made that gate intermittent: it
       * sampled a fade and reported the composite as a 1.86:1 contrast defect. A stylesheet rule wins
       * over an inline value and applies to tiles that mount later too, which is the half a one-shot
       * "finish all animations" call cannot cover.
       */
      data-bento-tile=""
      className={`${SPAN_CLASS[span]} min-w-0`}
    >
      {/*
        `h-full` so the bubble fills the band rather than floating at the top of a
        row sized by a taller neighbour — the padding belongs inside the card,
        where it reads as breathing room, not between cards, where it reads as a
        rendering fault.
      */}
      <div
        data-widget={widgetId}
        className={`@container ${surface} flex h-full flex-col min-w-0 ${className}`}
      >
        {children}
      </div>
    </motion.div>
  )
}

/** Standard bubble header: title on the left, one action or timestamp right. */
export function BentoTileHeader({
  title, icon: Icon, tone = 'accent', action, id,
}: {
  title: string
  icon?: React.ComponentType<{ className?: string }>
  tone?: 'accent' | 'success' | 'warning' | 'cyan' | 'dim'
  action?: React.ReactNode
  id?: string
}) {
  const TONE: Record<string, string> = {
    accent: 'text-bh-accent',
    success: 'text-bh-success',
    warning: 'text-bh-warning',
    cyan: 'text-bh-cyan',
    dim: 'text-bh-text-dim',
  }
  return (
    <div className="flex items-center justify-between gap-3 mb-4">
      <h3 id={id} className="text-base font-semibold text-bh-text flex items-center gap-2">
        {Icon && <Icon className={`w-4 h-4 ${TONE[tone]}`} aria-hidden="true" />}
        {title}
      </h3>
      {action}
    </div>
  )
}

/**
 * Edge-to-edge list inside a bubble — the negative-margin trick already used in
 * DashboardPage, extracted so every widget bleeds its list by the same amount
 * instead of each one hand-picking `-mx-5` or `-mx-6`.
 */
export function BentoTileList({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`-mx-6 -mb-6 border-t border-bh-border divide-y divide-bh-border ${className}`}>
      {children}
    </div>
  )
}

/**
 * Renders a widget registry.
 *
 * Every widget is resolved against `ctx` first (visibility, empty-collapse), so a
 * widget that hides itself costs nothing here and never leaves a gap.
 */
export function BentoRegion<Ctx>({
  widgets, ctx, density = 'bento', className = '', label,
}: {
  widgets: ReadonlyArray<BentoWidget<Ctx>>
  ctx: Ctx
  density?: BentoDensity
  className?: string
  /** Accessible name for the region wrapping the grid. */
  label?: string
}) {
  const layout = React.useMemo(
    () => resolveBentoLayout(widgets, ctx, density),
    [widgets, ctx, density],
  )

  return (
    <section aria-label={label} className={className}>
      <BentoGrid>
        {layout.map((tile) => {
          // A merged run (`sections` density + `sectionGroup`) becomes one bubble
          // whose members sit side by side, separated by 1px rules rather than by
          // their own borders — the alternative is a full-width bubble per metric,
          // which is what that density exists to avoid.
          if (tile.members.length > 1) {
            return (
              <BentoTile key={tile.key} span={tile.span}>
                <div className="grid grid-cols-2 gap-y-6 md:flex md:gap-0">
                  {tile.members.map(({ widget }, index) => (
                    <div
                      key={widget.id}
                      data-widget={widget.id}
                      // Each member is its own containment context: the merged
                      // tile is full-width, but a member inside it is a quarter of
                      // that, and its widget gates detail on its own width.
                      className={`@container flex min-w-0 flex-1 flex-col px-0 md:px-6 ${
                        index > 0 ? 'md:border-l md:border-bh-border' : 'md:pl-0'
                      }`}
                    >
                      {widget.render(ctx)}
                    </div>
                  ))}
                </div>
              </BentoTile>
            )
          }

          const { widget } = tile.members[0]
          const chrome = widget.chrome ?? 'bubble'
          return (
            <BentoTile
              key={tile.key}
              widgetId={widget.id}
              span={tile.span}
              glow={chrome === 'glow'}
              bare={chrome === 'bare'}
            >
              {widget.render(ctx)}
            </BentoTile>
          )
        })}
      </BentoGrid>
    </section>
  )
}
