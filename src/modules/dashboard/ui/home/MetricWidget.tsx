import * as React from 'react'

/**
 * A single metric.
 *
 * The previous version put five things in a 193px tile: label, icon chip, value,
 * a context badge, and a hint sentence. The badge and the hint both wrapped to
 * three lines and the tile stopped reading as a number.
 *
 * Now the tile earns detail as it gets room, using container variants so the
 * decision is made on the tile's own width rather than the viewport's.
 *
 * Thresholds are in *content-box* pixels, which is the gotcha: a container query
 * measures the container's content box, so a 304px tile with `px-6` queries as
 * 256px. Picking the named `@3xs` (256px) put the boundary exactly on a real
 * tile's width and sub-pixel rounding decided it, so both thresholds sit clear
 * of any tile in use:
 *   - always              value + label
 *   - `@min-[13rem]`      the hint       (208px content: excludes the 145px `sm` span)
 *   - `@min-[18rem]`      the badge      (288px content: excludes the 250px `md` span)
 */

export type MetricTone = 'accent' | 'success' | 'warning' | 'cyan'

const TONE_TEXT: Record<MetricTone, string> = {
  accent: 'text-bh-accent',
  success: 'text-bh-success',
  warning: 'text-bh-warning',
  cyan: 'text-bh-cyan',
}

export interface MetricWidgetProps {
  label: string
  /**
   * The count, or `null` when it is not known yet.
   *
   * Nullable deliberately, and the type is the whole point of it. This was `number`, and the page fed it
   * `stats?.totalBuilders ?? 0` — so a tile with no data yet rendered a confident **0** in 30px type, and there was
   * no way for it to say anything else. That only stayed invisible because a whole-page skeleton hid the tile
   * during the fetch; the moment Wave 1 removes that skeleton to make the shell render independently, three zeros
   * appear on every dashboard load.
   *
   * `?? 0` is the shape to distrust here in general: for a count, "none" and "not read yet" are different
   * sentences, and a coalesce turns the second into the first. The same substitution shipped in the org-admin cards
   * on the same day from the same instinct.
   */
  value: number | null
  hint: string
  icon: React.ComponentType<{ className?: string }>
  tone: MetricTone
  /** Extra context ("16 active now"). Shown only when the tile is wide enough. */
  badge?: string
}

export function MetricWidget({ label, value, hint, icon: Icon, tone, badge }: MetricWidgetProps) {
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-xs font-light text-bh-text-dim">{label}</span>
        <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${TONE_TEXT[tone]}`} aria-hidden="true" />
      </div>

      {/* Tabular figures stop the number jittering as it updates. (A comment here used to claim
          `.text-3xl` was asserted by `dashboard-and-navigation.spec.ts`. It is not — nothing in the
          suite references this component, this class, or these labels, which is how the `?? 0` shipped.) */}
      <p className="mt-1.5 flex items-baseline gap-1.5" data-metric-state={value === null ? 'loading' : 'ready'}>
        {value === null ? (
          /**
           * A skeleton bar, sized to the line it replaces so the tile does not resize when the number lands.
           *
           * `aria-hidden` plus one `sr-only` word rather than `role="status"`: three tiles mount together, and
           * three live regions announcing themselves is worse for a screen-reader user than one quiet label each.
           * The bar is decoration; "Loading" is the content.
           */
          <>
            <span
              aria-hidden="true"
              className="my-1 block h-7 w-16 animate-pulse rounded bg-bh-surface"
            />
            <span className="sr-only">Loading</span>
          </>
        ) : (
          <span className="text-3xl font-bold tracking-tight tabular-nums text-bh-text font-display">
            {value.toLocaleString()}
          </span>
        )}
        {badge && (
          <span className="hidden @min-[18rem]:inline truncate rounded border border-bh-border bg-bh-bg-alt px-1.5 py-0.5 text-[10px] font-medium text-bh-text-dim">
            {badge}
          </span>
        )}
      </p>

      <p className="hidden @min-[13rem]:block pt-2 text-xs text-bh-text-dim">{hint}</p>
    </>
  )
}
