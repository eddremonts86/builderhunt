import * as React from 'react'
import { Lock } from 'lucide-react'
import { Button } from '~/components/ui'
import { Dialog } from '~/components/ui/dialog'
import { Switch } from '~/components/ui/switch'
import type { BentoDensity } from '~/modules/dashboard/ui/bento/layout'
import type { WidgetCriticality } from '~/modules/dashboard/lib/contracts'

/**
 * The dashboard's layout controls (plans/ui-dashboard Wave 6, "Build accessible dashboard
 * customization controls").
 *
 * ## Why a dialog of switches and not drag-and-drop
 *
 * The spec's verify line is "keyboard/touch/screen-reader flows pass" and its instruction is that
 * drag, *if present*, invokes the same commands and is never required. Building the commands first
 * makes that ordering real: a list of labelled switches is complete on a keyboard, on a phone, and to
 * a screen reader on the day it ships, and a drag affordance can be added later as a shortcut to the
 * same operations. Built the other way round, the accessible path is always the thing still to do.
 *
 * ## Critical widgets are shown, disabled, and explained
 *
 * Not hidden from the list. A user who cannot find "Needs your attention" among the toggles will
 * assume the dialog is incomplete; one who finds it disabled with a reason learns the rule. The rule
 * itself lives in `orderedWidgets`, which ignores a hide on a `critical` widget — this control only
 * needs to avoid *offering* an action that would silently do nothing.
 *
 * ## Nothing here is a form
 *
 * Every switch applies immediately through the optimistic store. There is no Save, so there is no
 * unsaved state to lose, no dirty-close warning, and no way for the dialog and the page behind it to
 * disagree about what the layout is. "Reset" is the same operation with the defaults.
 */

export interface CustomizableWidget {
  id: string
  title: string
  criticality: WidgetCriticality
}

export interface DashboardCustomizeDialogProps {
  open: boolean
  onClose: () => void
  /** Focused on close. Required in practice: this dialog is opened by state, not by a Radix trigger. */
  returnFocusRef?: React.RefObject<HTMLElement | null>
  widgets: readonly CustomizableWidget[]
  hiddenWidgetIds: readonly string[]
  density: BentoDensity
  onToggleHidden: (widgetId: string) => void
  onDensityChange: (density: BentoDensity) => void
  onReset: () => void
}

const DENSITY_LABEL: Record<BentoDensity, string> = {
  bento: 'Mosaic — each widget at its own width',
  sections: 'Sections — every widget full width',
}

export function DashboardCustomizeDialog({
  open, onClose, returnFocusRef, widgets, hiddenWidgetIds, density, onToggleHidden, onDensityChange, onReset,
}: DashboardCustomizeDialogProps) {
  const hidden = React.useMemo(() => new Set(hiddenWidgetIds), [hiddenWidgetIds])
  const densityGroupId = React.useId()

  return (
    <Dialog open={open} onClose={onClose} returnFocusRef={returnFocusRef} title="Customize dashboard" className="max-w-lg">
      <fieldset className="mb-6">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-bh-text-dim">
          Density
        </legend>
        {/*
          Radios, not a segmented button pair. Two mutually exclusive options with a shared name are
          what a screen reader announces as "1 of 2" and what arrow keys move between; a pair of
          buttons is two unrelated controls that happen to look like a choice.
        */}
        <div role="radiogroup" aria-labelledby={densityGroupId} className="flex flex-col gap-2">
          <span id={densityGroupId} className="sr-only">Dashboard density</span>
          {(['bento', 'sections'] as const).map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-bh-border px-3 py-2 text-sm text-bh-text hover:border-bh-accent/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-bh-accent"
            >
              <input
                type="radio"
                name="dashboard-density"
                value={option}
                checked={density === option}
                onChange={() => onDensityChange(option)}
                className="h-4 w-4 accent-bh-accent"
              />
              <span>{DENSITY_LABEL[option]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-bh-text-dim">
          Widgets
        </legend>
        <ul className="flex flex-col divide-y divide-bh-border rounded-lg border border-bh-border">
          {widgets.map((widget) => {
            const isCritical = widget.criticality === 'critical'
            const isVisible = !hidden.has(widget.id)
            return (
              <li key={widget.id} className="flex items-center gap-3 px-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm text-bh-text">{widget.title}</span>
                {isCritical ? (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-bh-text-dim">
                    <Lock className="h-3 w-3" aria-hidden="true" />
                    {/* The reason, not just the lock. A disabled control with no explanation reads
                        as a bug. */}
                    Always shown
                  </span>
                ) : (
                  <Switch
                    checked={isVisible}
                    onCheckedChange={() => onToggleHidden(widget.id)}
                    // The widget's name, because "Switch" repeated fourteen times is not a list
                    // anyone can navigate.
                    aria-label={`Show ${widget.title}`}
                  />
                )}
              </li>
            )
          })}
        </ul>
      </fieldset>

      <div className="mt-6 flex items-center justify-between gap-3">
        <Button variant="secondary" size="sm" onClick={onReset}>
          Reset to defaults
        </Button>
        {/* "Done" rather than "Save": every change already applied. Naming it Save would imply the
            switches above had been provisional. */}
        <Button variant="primary" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </Dialog>
  )
}
