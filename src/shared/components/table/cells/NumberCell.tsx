import { EmptyCell } from './EmptyCell'

interface NumberCellProps {
  value: number | null | undefined
  /**
   * The unit, rendered beside the figure rather than only in the header.
   *
   * A column headed "Duration" full of bare `1,240`s is a column somebody will read as
   * milliseconds and act on as seconds. The header names the quantity; the cell says what it is
   * measured in.
   */
  unit?: string
  /** Decimal places. Defaults to none — a count of 1,204.00 is a count nobody counted. */
  fractionDigits?: number
}

/**
 * A right-aligned figure in tabular numerals.
 *
 * Right alignment is not a preference: it is what lets a column of numbers be compared by their
 * shape, because the ones, tens and hundreds line up. Tabular figures are the second half of that
 * — a proportional `1` is narrower than a `7`, so in a proportional face a column of numbers is
 * ragged even when it is right-aligned.
 *
 * `tabular-nums`, never a monospace face. DESIGN.md:221 reserves mono for literal code and keys,
 * and aligning digits is not that; Inter's tabular figures do the job inside the body face.
 *
 * The column track is a fixed 88px (`--tbl-col-number`) and the cell never truncates. A number
 * missing its last digit is not an approximate number, it is a different one.
 */
export function NumberCell({ value, unit, fractionDigits = 0 }: NumberCellProps) {
  if (value === null || value === undefined || Number.isNaN(value)) return <EmptyCell />

  const formatted = value.toLocaleString('en-GB', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })

  return (
    <span className="tbl-cell-number" data-testid="cell-number">
      {formatted}
      {unit !== undefined && <span className="tbl-cell-unit">{unit}</span>}
    </span>
  )
}
