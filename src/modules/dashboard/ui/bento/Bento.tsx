import * as React from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { fadeInUpVariants, staggerContainer } from '~/shared/lib/motion/tokens'
import {
  ROWS_CLASS,
  SPAN_CLASS,
  resolveBentoLayout,
  type BentoDensity,
  type BentoRows,
  type BentoWidget,
} from './layout'

/**
 * The bento grid and its bubble.
 *
 * The bubble is `.card` from globals.css — same 24px radius, border and
 * diffusion shadow the dashboard already uses. This file adds no new surface
 * treatment; it only decides how many bubbles there are and how wide each one
 * gets, from the sizes declared in a widget registry.
 *
 * See `layout.ts` for the sizing rules and the two densities.
 */

/**
 * The modular field: 1 column on phones, 6 at `md`, 12 at `xl`.
 *
 * Two things make this a mosaic instead of a stack of bands:
 *
 *  - `auto-rows-[minmax(11rem,auto)]` gives every tile the same base row height,
 *    so a 1-row tile beside a 2-row tile lines up instead of each row sizing
 *    itself to whatever happens to be in it.
 *  - `grid-flow-row-dense` backfills. Without it CSS Grid places sparsely: a
 *    tile too wide for the space left on the current row jumps to the next one
 *    and abandons the gap, which is exactly why the first version looked like
 *    rows of unrelated widths with holes at the end of each.
 *
 * `dense` can place a tile earlier than its DOM position, so visual order and
 * tab order can differ. That is acceptable here because every tile is an
 * independent, separately-labelled region rather than a step in a sequence; it
 * would not be acceptable for a form or a wizard.
 */
export function BentoGrid({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      className={`grid grid-cols-1 md:grid-cols-6 xl:grid-cols-12 grid-flow-row-dense auto-rows-[minmax(11rem,auto)] gap-4 ${className}`}
      variants={staggerContainer()}
      initial={reduceMotion ? false : 'hidden'}
      animate="visible"
    >
      {children}
    </motion.div>
  )
}

interface BentoTileProps {
  span: keyof typeof SPAN_CLASS
  rows?: BentoRows
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
 * One bubble, and a containment context.
 *
 * `@container` is the load-bearing class here. A widget's usable width is set by
 * its span, not by the viewport, so viewport breakpoints cannot describe it: a
 * `wide` tile is 507px on a 1560px screen and a `section` tile is 736px on a
 * 768px one. Widgets therefore style themselves with container variants
 * (`@lg:`, `@4xl:`, `@min-[13rem]:`) and adapt to the tile they were given.
 *
 * Thresholds are content-box widths: a container query measures the container's
 * content box, so a tile with `p-6` queries 48px narrower than it looks.
 *
 * `flex flex-col` so a widget can push a footer down with `mt-auto` regardless
 * of how tall its neighbours make the row.
 */
export function BentoTile({
  span, rows = 1, glow = false, bare = false, className = '', children, widgetId,
}: BentoTileProps) {
  const reduceMotion = useReducedMotion()
  const surface = bare ? '' : glow ? 'card-glow p-6' : 'card card-hover'
  return (
    <motion.div
      data-widget={widgetId}
      variants={reduceMotion ? undefined : fadeInUpVariants}
      className={`@container ${SPAN_CLASS[span]} ${ROWS_CLASS[rows]} ${surface} flex flex-col min-w-0 ${className}`}
    >
      {children}
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
 * Every widget is resolved against `ctx` first (visibility, empty-collapse),
 * so a widget that hides itself costs nothing here and never leaves a gap.
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
          // A merged run (`sections` density + `sectionGroup`) becomes one
          // bubble whose members sit side by side, separated by 1px rules rather
          // than by their own borders — the alternative is a full-width bubble
          // per metric, which is what this density exists to avoid.
          if (tile.members.length > 1) {
            return (
              <BentoTile key={tile.key} span={tile.span} rows={tile.rows}>
                <div className="grid grid-cols-2 gap-y-6 md:flex md:gap-0">
                  {tile.members.map(({ widget }, index) => (
                    <div
                      key={widget.id}
                      data-widget={widget.id}
                      // Each member is its own containment context: the merged
                      // tile is full-width, but a member inside it is only a
                      // quarter of that, and its widget gates detail on its own
                      // width.
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
              rows={tile.rows}
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
