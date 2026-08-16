interface EmptyCellProps {
  /**
   * What the absence means, for a screen reader.
   *
   * Defaults to "None". Worth overriding when the column's absence is specific — "Never signed in"
   * says more than "None" in a Last seen column, and it is the same number of characters to write.
   */
  label?: string
}

/**
 * A muted em dash.
 *
 * The alternative is an empty cell, and an empty cell is ambiguous in a way that matters: it reads
 * as "the table failed to render this" rather than "there is no value". The dash is the difference
 * between a gap and a fact.
 *
 * It is `aria-hidden` with the meaning carried in text beside it, because a screen reader
 * announcing "em dash" is noise — one per empty cell, on a table where the reference itself
 * observes that a column more than 70% empty should start hidden entirely.
 */
export function EmptyCell({ label = 'None' }: EmptyCellProps) {
  return (
    <span className="tbl-cell-empty" data-testid="cell-empty">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
