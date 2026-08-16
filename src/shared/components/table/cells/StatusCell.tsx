/**
 * The five semantic tones a status may take, and the complete list.
 *
 * Deliberately five, matching the reference's "at most five states per table". The constraint is
 * not about the palette — it is that a reader can hold five meanings at once and not nine. A
 * surface with eleven job states groups them into these five and puts the exact state in the
 * label, which is the thing that scales.
 *
 * `neutral` is not "no status". It is the resting, unremarkable state — queued, draft, inactive —
 * and it is the default so that a colour is something a column author chooses on purpose.
 */
export type StatusTone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral'

interface StatusCellProps {
  /** The exact state, in the surface's own words. Never truncated: the column track is 116px. */
  label: string
  tone?: StatusTone
}

/**
 * A 22px semantic chip.
 *
 * Colour carries meaning here and only here. `category` is plain text on purpose — a grey chip
 * around every category is decoration wearing a status chip's clothes, and once every cell is a
 * chip none of them signals anything.
 *
 * The tone is never the only carrier: the label says the state in words, so the cell survives
 * greyscale, a colour-blind reader and a screen reader alike (WCAG 1.4.1).
 */
export function StatusCell({ label, tone = 'neutral' }: StatusCellProps) {
  return (
    <span className="tbl-chip" data-tone={tone} data-testid="cell-status">
      {label}
    </span>
  )
}
