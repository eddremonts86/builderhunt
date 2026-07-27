import * as React from 'react'
import { motion, useReducedMotion } from 'motion/react'
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
 * Vertical resolution of the masonry field, in pixels. Tiles span a whole number
 * of these, so a smaller number means a tighter fit and more rows for the browser
 * to lay out. 4px is under one line of leading, which is close enough to exact.
 */
const ROW_UNIT = 4

/** Gutter between tiles, in pixels. Must match the `gap-4` used horizontally. */
const GUTTER = 16

/**
 * Makes a tile span exactly as many row units as its content occupies.
 *
 * Plain CSS Grid cannot do this. Items sharing a grid row share that row's
 * height, so a short tile beside a tall one is padded to match and the padding
 * belongs to the row, not the item: no neighbour can move up into it. That is why
 * the earlier `rows: 2 | 3` version reserved visible dead space inside almost
 * every tile.
 *
 * The fix is the standard grid-masonry technique: rows of `ROW_UNIT` with no row
 * gap, and each tile spanning `ceil((its height + gutter) / unit)` of them. The
 * gutter is part of the span rather than a `row-gap`, because a row gap would be
 * applied between every one of the hundreds of implicit rows.
 *
 * `useLayoutEffect` writes the span before paint, so the first frame the user
 * sees is already packed. Content that changes height afterwards (a list loading,
 * a widget switching to its empty state, a font finishing swap) is picked up by
 * the ResizeObserver.
 */
function useMasonrySpan<T extends HTMLElement>(ref: React.RefObject<T | null>) {
  const [span, setSpan] = React.useState<number | null>(null)

  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const measure = () => {
      // `getBoundingClientRect` rather than offsetHeight: the tile is inside a
      // motion component whose enter animation writes a transform, and a
      // transformed box still reports its untransformed layout height here only
      // because scale is not animated. Height comes from the border box.
      const height = element.getBoundingClientRect().height
      if (height > 0) setSpan(Math.ceil((height + GUTTER) / ROW_UNIT))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return span
}

/**
 * The field: 1 column on phones, 6 at `md`, 12 at `xl`.
 *
 * `grid-flow-row-dense` backfills. Without it, a tile too wide for the space left
 * on the current row jumps past the gap and abandons it; with it, the next tile
 * that fits moves up. Combined with content-sized heights, that is what makes the
 * result a mosaic rather than a set of bands.
 *
 * `dense` can place a tile earlier than its DOM position, so visual order and tab
 * order can differ. Acceptable here because every tile is an independent,
 * separately-labelled region rather than a step in a sequence.
 */
export function BentoGrid({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      className={`grid grid-cols-1 md:grid-cols-6 xl:grid-cols-12 grid-flow-row-dense gap-x-4 ${className}`}
      // Row height and the absence of a row gap are the two halves of the
      // masonry maths in `useMasonrySpan`; they belong together, and inline is
      // the only place that stays next to the constants they mirror.
      style={{ gridAutoRows: `${ROW_UNIT}px`, rowGap: 0 }}
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
  const reduceMotion = useReducedMotion()
  const innerRef = React.useRef<HTMLDivElement>(null)
  const rowSpan = useMasonrySpan(innerRef)
  const surface = bare ? '' : glow ? 'card-glow p-6' : 'card card-hover'

  return (
    <motion.div
      variants={reduceMotion ? undefined : fadeInUpVariants}
      className={`${SPAN_CLASS[span]} min-w-0`}
      // Until the first measurement lands the tile spans nothing, which would
      // collapse it; `auto` lets the browser size it normally for that one frame.
      style={{ gridRowEnd: rowSpan ? `span ${rowSpan}` : 'auto' }}
    >
      <div
        ref={innerRef}
        data-widget={widgetId}
        className={`@container ${surface} flex flex-col min-w-0 ${className}`}
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
