import { EmptyCell } from './EmptyCell'

interface RatioCellProps {
  /** The proportion, 0 to 1. Values outside that are clamped for the bar and printed as given. */
  value: number | null | undefined
  /** Override the printed figure — "12 / 40" rather than "30%", say. */
  label?: string
}

/**
 * A progress bar *and* the number.
 *
 * Both, always. The bar is what makes a column of ratios comparable at a glance; the number is what
 * makes any single one actionable, and it is also what keeps the cell accessible — the bar's fill
 * measures 2.79:1 against its track, under SC 1.4.11's 3:1 for a graphical object, and that is
 * allowed precisely because the value is *also* present as text. Drop the number and the bar
 * becomes the only carrier of the information and the cell fails.
 *
 * `role="img"` with an accessible name rather than `role="progressbar"`: a progressbar describes
 * something in flight that a screen reader may re-announce as it changes. A ratio in a table row
 * is a measurement that already happened.
 */
export function RatioCell({ value, label }: RatioCellProps) {
  if (value === null || value === undefined || Number.isNaN(value)) return <EmptyCell />

  const clamped = Math.min(Math.max(value, 0), 1)
  const text = label ?? `${Math.round(value * 100)}%`

  return (
    <div className="tbl-ratio" data-testid="cell-ratio">
      <div className="tbl-ratio-track" role="img" aria-label={text}>
        <div className="tbl-ratio-fill" style={{ width: `${clamped * 100}%` }} data-testid="cell-ratio-fill" />
      </div>
      <span className="tbl-cell-number" data-testid="cell-ratio-value">{text}</span>
    </div>
  )
}
