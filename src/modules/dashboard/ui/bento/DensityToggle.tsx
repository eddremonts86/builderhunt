import * as React from 'react'
import { LayoutGrid, Rows3 } from 'lucide-react'
import { ICON_TRANSITION } from '~/shared/lib/useSlidingIndicator'
import type { BentoDensity } from './layout'

const OPTIONS: Array<{
  value: BentoDensity
  label: string
  icon: React.ComponentType<{ className?: string }>
}> = [
  { value: 'bento', label: 'Bento', icon: LayoutGrid },
  { value: 'sections', label: 'Sections', icon: Rows3 },
]

/**
 * Switches the dashboard between the asymmetric bento and the full-width
 * section stack. A real control rather than a build-time flag, because the two
 * densities suit different screens: bento wants width, sections read better on
 * a laptop half-screen or when a widget's table needs the full measure.
 */
export function DensityToggle({
  density, onChange,
}: {
  density: BentoDensity
  onChange: (next: BentoDensity) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Panel density"
      className="inline-flex items-center gap-0.5 rounded-full border border-bh-border bg-bh-bg-alt p-0.5"
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = density === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => onChange(value)}
            className={`grid h-7 w-8 place-items-center rounded-full ${ICON_TRANSITION} ${
              active
                ? 'bg-bh-surface text-bh-text shadow-sm'
                : 'text-bh-text-dim hover:text-bh-text'
            }`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}
