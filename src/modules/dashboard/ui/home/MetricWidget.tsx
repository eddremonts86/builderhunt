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
  value: number
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

      {/* `.text-3xl` is asserted by e2e/dashboard-and-navigation.spec.ts; tabular
          figures stop the number jittering as it updates. */}
      <p className="mt-1.5 flex items-baseline gap-1.5">
        <span className="text-3xl font-bold tracking-tight tabular-nums text-bh-text font-display">
          {value.toLocaleString()}
        </span>
        {badge && (
          <span className="hidden @min-[18rem]:inline truncate rounded border border-bh-border bg-bh-bg-alt px-1.5 py-0.5 text-[10px] font-medium text-bh-text-dim">
            {badge}
          </span>
        )}
      </p>

      <p className="mt-auto hidden @min-[13rem]:block pt-2 text-xs text-bh-text-dim">{hint}</p>
    </>
  )
}
