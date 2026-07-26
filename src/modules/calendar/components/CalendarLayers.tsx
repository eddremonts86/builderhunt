import { AlertTriangle, CalendarDays, Cog } from 'lucide-react'

/**
 * Layer toggles for the unified calendar feed (plan:
 * calendar-scheduling-interview-intelligence, Phase 4 "Add calendar layer UI").
 *
 * Each layer carries an icon **and** a text label, and each item kind gets a distinct border style
 * in the grid — never colour alone. Colour-only encoding fails for the ~8% of men with a red/green
 * deficiency and disappears entirely in a high-contrast or greyscale rendering, and the distinction
 * being encoded here is not cosmetic: it is "you can edit this" versus "you cannot".
 */

export type CalendarLayerKey = 'events' | 'jobs' | 'alerts'

export interface CalendarLayerDefinition {
  key: CalendarLayerKey
  label: string
  /** Plain-language description of what the layer contains, used as the toggle's accessible hint. */
  hint: string
}

export const CALENDAR_LAYERS: readonly CalendarLayerDefinition[] = [
  { key: 'events', label: 'Appointments', hint: 'Events you own or were invited to. Editable.' },
  { key: 'jobs', label: 'Background jobs', hint: 'Scheduled and completed automation. Read-only.' },
  { key: 'alerts', label: 'Alerts', hint: 'When your alerts are checked, and what they found. Read-only.' },
]

const LAYER_ICONS: Record<CalendarLayerKey, typeof CalendarDays> = {
  events: CalendarDays,
  jobs: Cog,
  alerts: AlertTriangle,
}

export interface CalendarLayersProps {
  active: CalendarLayerKey[]
  onToggle: (key: CalendarLayerKey) => void
  /** Source keys the feed reported as untrustworthy, rendered as a plain-language warning. */
  staleSources?: string[]
}

export function CalendarLayers({ active, onToggle, staleSources = [] }: CalendarLayersProps) {
  return (
    <div className="mb-4" data-testid="calendar-layers">
      <fieldset>
        <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-bh-text-muted">Layers</legend>
        <div className="flex flex-wrap gap-2">
          {CALENDAR_LAYERS.map((layer) => {
            const Icon = LAYER_ICONS[layer.key]
            const isActive = active.includes(layer.key)
            return (
              <button
                key={layer.key}
                type="button"
                // `aria-pressed` rather than a checkbox role: these are toggle buttons that refetch,
                // and a screen reader needs the pressed state announced on the same control the
                // pointer user clicks.
                aria-pressed={isActive}
                aria-describedby={`layer-hint-${layer.key}`}
                onClick={() => onToggle(layer.key)}
                data-testid={`calendar-layer-${layer.key}`}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bh-accent ${
                  isActive
                    ? 'border-bh-accent bg-bh-accent-soft text-bh-text'
                    : 'border-bh-border bg-bh-surface text-bh-text-muted'
                }`}
              >
                <Icon className="size-4" aria-hidden />
                {layer.label}
                {/* A visible mark, not just a colour change, so the state survives greyscale. */}
                <span aria-hidden className="text-xs">{isActive ? '✓' : '+'}</span>
              </button>
            )
          })}
        </div>
        {CALENDAR_LAYERS.map((layer) => (
          <span key={layer.key} id={`layer-hint-${layer.key}`} className="sr-only">{layer.hint}</span>
        ))}
      </fieldset>

      {staleSources.length > 0 && (
        <p
          role="status"
          className="mt-3 flex items-start gap-2 rounded-md border border-bh-warning/40 bg-bh-warning/10 px-3 py-2 text-xs text-bh-text"
          data-testid="calendar-stale-warning"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {/* Named plainly rather than hidden: a schedule whose next run has already passed means
                nothing is running, and a confident-looking calendar entry would be worse than a
                warning. The raw keys are shown because they are what an operator would search for. */}
            Some sources are behind and their upcoming times may be wrong: {staleSources.join(', ')}.
          </span>
        </p>
      )}
    </div>
  )
}
