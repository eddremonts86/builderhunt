interface GroupRowProps {
  value: string
  /**
   * What to show instead of the raw grouped value.
   *
   * The group value has to be the dimension the *server* counted, or the facet lookup misses and
   * there is no honest total to print. That dimension is sometimes an id: the alerts inbox groups by
   * `alert_id`, because two radars may share a name and grouping by the name would merge them. So
   * the value stays the id and the surface supplies the name.
   */
  label?: string
  /** Rows in this group across the whole filtered set — the server's number. */
  total: number | null
  /** Rows in this group that are currently loaded. */
  loaded: number
  columnCount: number
}

/**
 * A sticky group header showing the server's aggregate, with the loaded count beside it.
 *
 * The tempting version counts the loaded rows and prints that. It is wrong on every table with
 * more than one page — "github (12)" when the group holds 340 — and it looks completely right,
 * which is why it survives review. So the big number is `PageResult.facets[groupBy]`, computed by
 * the server over the entire filtered set, and the loaded count is shown separately and labelled.
 *
 * When the server sent no facet for the grouped dimension there is no honest total to show, so it
 * shows none rather than substituting the loaded count.
 */
export function GroupRow({ value, label, total, loaded, columnCount }: GroupRowProps) {
  return (
    <div
      role="row"
      className="sticky top-[var(--table-header-height,2.75rem)] z-10 border-y border-bh-border bg-bh-surface-2 px-4 py-2"
      data-testid={`table-group-${value}`}
    >
      <div role="gridcell" aria-colindex={1} className="flex items-baseline gap-2" style={{ gridColumn: `span ${columnCount}` }}>
        <span className="text-sm font-semibold text-bh-text">{label ?? value}</span>
        {total !== null && (
          <span className="tabular-nums text-xs text-bh-text-muted" data-testid={`table-group-${value}-total`}>
            {total.toLocaleString()} total
          </span>
        )}
        <span className="tabular-nums text-xs text-bh-text-muted" data-testid={`table-group-${value}-loaded`}>
          {loaded.toLocaleString()} loaded
        </span>
      </div>
    </div>
  )
}
