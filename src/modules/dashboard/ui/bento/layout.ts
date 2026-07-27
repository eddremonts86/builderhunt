import type { ReactNode } from 'react'

/**
 * Bento layout resolution — the pure half of the widget system.
 *
 * The grid is a 12-column modular field with a common row unit. Two decisions
 * make it read as a mosaic rather than a stack of bands:
 *
 *  1. **Spans are divisors of 12 only.** A vocabulary of 3 / 4 / 6 / 8 / 12 means
 *     any combination of tiles lands on the same vertical rhythm. The earlier
 *     vocabulary included 2 and 5, so rows added up to 11 or 13 and left ragged
 *     gaps that no amount of reordering could close.
 *  2. **Placement is dense** (`grid-auto-flow: dense`, see `Bento.tsx`). A tile
 *     that does not fit the remaining space no longer pushes itself to a new row
 *     and leaves the hole behind; the next tile that *does* fit backfills it.
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

/** Height in row units. The unit is set by `auto-rows-*` in `Bento.tsx`. */
export type BentoRows = 1 | 2 | 3

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
  rows?: BentoRows
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
  rows: BentoRows
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

/** Row classes. Rows only apply from `md` up, where the field is multi-column. */
export const ROWS_CLASS: Record<BentoRows, string> = {
  1: '',
  2: 'md:row-span-2',
  3: 'md:row-span-3',
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
        rows: 1,
        members: [{ widget, isEmpty }],
      })
      continue
    }

    tiles.push({
      key: widget.id,
      span: density === 'sections' ? 'full' : declared,
      rows: density === 'sections' ? 1 : (widget.rows ?? 1),
      members: [{ widget, isEmpty }],
    })
  }

  return tiles
}

/**
 * Total column-rows a resolved layout occupies at `xl`. With dense placement the
 * grid backfills holes, so this is no longer a correctness requirement — but a
 * total that is a multiple of 12 still means the field can tile with no leftover,
 * which is the difference between a mosaic and a mosaic with one notch missing.
 */
export function xlColumnsUsed<Ctx>(layout: ReadonlyArray<ResolvedTile<Ctx>>): number {
  return layout.reduce((total, { span, rows }) => total + SPAN_COLUMNS[span] * rows, 0)
}
