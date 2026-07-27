import type { ReactNode } from 'react'

/**
 * Bento layout resolution — the pure half of the widget system.
 *
 * A widget declares **width only**. Height is whatever its content needs, and
 * `Bento.tsx` measures it (see the masonry span there).
 *
 * That split is deliberate and was learned the hard way. An earlier version let
 * widgets declare `rows: 2 | 3` against a `minmax(11rem, auto)` row unit, which
 * padded every tile out to a multiple of 176px whether or not it had content to
 * fill it. Worse, CSS Grid makes items in the same row share that row's height,
 * so the reserved space could not be reclaimed by a neighbour either: the gaps
 * were structural, not cosmetic.
 *
 * Widths are divisors of 12 only (3 / 4 / 6 / 8 / 12), so any combination of
 * tiles tiles the field with no leftover column.
 *
 * Two display densities share one registry:
 *   - `bento`    — every widget at its declared size (the default)
 *   - `sections` — every widget forced full-width, so the page reads as a few
 *                  large bubbles stacked instead of many small ones
 *
 * Kept free of React so the sizing rules can be unit-tested directly; the
 * rendering half lives in `Bento.tsx`.
 */

/**
 * Declared widget width, as a fraction of the 12-column field. Every value
 * divides 12, which is what keeps the grid symmetric.
 */
export type BentoSpan = 'quarter' | 'third' | 'half' | 'twoThirds' | 'full'

export type BentoDensity = 'bento' | 'sections'

/**
 * What to do with a widget that has nothing to show. Defaults to keeping its
 * declared span, which in a `bento` density leaves a visible hole — so widgets
 * whose empty state is a one-liner should shrink, and widgets with no empty
 * state worth rendering should say `'hide'`.
 */
export type WhenEmpty = 'hide' | BentoSpan

/**
 * Who paints the bubble. `bubble` is the default and the right answer for new
 * widgets; `bare` exists for widgets embedding a component that already renders
 * its own `.card`.
 */
export type BentoChrome = 'bubble' | 'glow' | 'bare'

export interface BentoWidget<Ctx> {
  /** Stable identity — also the React key and the `data-widget` attribute. */
  id: string
  span: BentoSpan
  /**
   * Narrowest span at which this widget is still readable. The resolver clamps
   * to it, so neither a hand-edited `span` nor a `whenEmpty` collapse can squeeze
   * a widget below the width its content needs.
   */
  minSpan?: BentoSpan
  chrome?: BentoChrome
  /** Omitted from the page entirely when this returns false (e.g. admin-only). */
  isVisible?: (ctx: Ctx) => boolean
  /** Drives `whenEmpty`. A widget with no `isEmpty` is never treated as empty. */
  isEmpty?: (ctx: Ctx) => boolean
  whenEmpty?: WhenEmpty
  /**
   * Widgets sharing a group are merged into a single full-width bubble in
   * `sections` density, laid out side by side with 1px dividers, so a one-number
   * metric never gets a 1300px bubble of its own.
   */
  sectionGroup?: string
  render: (ctx: Ctx) => ReactNode
}

/**
 * One bubble to render. Usually a single widget; in `sections` density a run of
 * widgets sharing a `sectionGroup` becomes one tile with several members.
 */
export interface ResolvedTile<Ctx> {
  /** React key — the single widget's id, or `group:<name>` for a merged run. */
  key: string
  span: BentoSpan
  members: Array<{ widget: BentoWidget<Ctx>; isEmpty: boolean }>
}

/** How many of the 12 columns each span occupies. */
export const SPAN_COLUMNS: Record<BentoSpan, number> = {
  quarter: 3,
  third: 4,
  half: 6,
  twoThirds: 8,
  full: 12,
}

/**
 * Column classes per span. Static strings on purpose — Tailwind's scanner cannot
 * see interpolated class names, so every class the grid can emit has to appear
 * here literally.
 *
 * At `md` the field is 6 columns, so quarter and third both become a half-width
 * tile and twoThirds becomes full: a 4-of-12 tile at tablet width would be
 * ~230px, which is narrower than any widget here reads well at.
 */
export const SPAN_CLASS: Record<BentoSpan, string> = {
  quarter: 'md:col-span-3 xl:col-span-3',
  third: 'md:col-span-3 xl:col-span-4',
  half: 'md:col-span-6 xl:col-span-6',
  twoThirds: 'md:col-span-6 xl:col-span-8',
  full: 'md:col-span-6 xl:col-span-12',
}

/** Narrow to wide. Used to clamp a span up to a widget's `minSpan`. */
const SPAN_ORDER: readonly BentoSpan[] = ['quarter', 'third', 'half', 'twoThirds', 'full']

function atLeast(span: BentoSpan, min: BentoSpan | undefined): BentoSpan {
  if (!min) return span
  return SPAN_ORDER.indexOf(span) < SPAN_ORDER.indexOf(min) ? min : span
}

/**
 * Resolve a registry against the current data.
 *
 * `sections` density collapses every widget to full width and drops `rows`,
 * because a full-width tile spanning extra rows would leave the space beside it
 * empty — there is no space beside it.
 */
export function resolveBentoLayout<Ctx>(
  widgets: ReadonlyArray<BentoWidget<Ctx>>,
  ctx: Ctx,
  density: BentoDensity = 'bento',
): Array<ResolvedTile<Ctx>> {
  const tiles: Array<ResolvedTile<Ctx>> = []

  for (const widget of widgets) {
    if (widget.isVisible && !widget.isVisible(ctx)) continue

    const isEmpty = widget.isEmpty?.(ctx) ?? false
    const whenEmpty = widget.whenEmpty
    if (isEmpty && whenEmpty === 'hide') continue

    // Narrowed via the local rather than `widget.whenEmpty`: the `continue`
    // above only rules out `'hide'` when `isEmpty` is also true, which the
    // compiler can't carry back to a property access.
    const collapsed = isEmpty && whenEmpty && whenEmpty !== 'hide' ? whenEmpty : widget.span
    const declared = atLeast(collapsed, widget.minSpan)

    if (density === 'sections' && widget.sectionGroup) {
      const previous = tiles[tiles.length - 1]
      // Merge only into an immediately preceding run of the same group, so a
      // widget declared between two grouped ones still breaks the run.
      if (previous?.key === `group:${widget.sectionGroup}`) {
        previous.members.push({ widget, isEmpty })
        continue
      }
      tiles.push({
        key: `group:${widget.sectionGroup}`,
        span: 'full',
        members: [{ widget, isEmpty }],
      })
      continue
    }

    tiles.push({
      key: widget.id,
      span: density === 'sections' ? 'full' : declared,
      members: [{ widget, isEmpty }],
    })
  }

  return tiles
}

/**
 * Total columns a resolved layout occupies at `xl`. Heights are decided by
 * content (see the masonry span measurement in `Bento.tsx`), so this counts width
 * only: a total that is a multiple of 12 means each band of widths tiles with no
 * leftover column.
 */
export function xlColumnsUsed<Ctx>(layout: ReadonlyArray<ResolvedTile<Ctx>>): number {
  return layout.reduce((total, { span }) => total + SPAN_COLUMNS[span], 0)
}
