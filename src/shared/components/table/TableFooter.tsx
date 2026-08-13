import { Button } from '~/components/ui/button'

interface TableFooterProps {
  /** Rows currently in the DOM. */
  loaded: number
  /** Rows matching the query across the whole set, from `PageResult.total`. `null` when unknowable. */
  total: number | null
  /** Whether the server offered a cursor for more. */
  hasMore: boolean
  onLoadMore?: () => void
  loading?: boolean
}

/**
 * `X of Y` on the left, cursor actions on the right. 44px.
 *
 * ## Why there are no page numbers here
 *
 * The reference draws pagination in this slot, and this footer deliberately does not implement it.
 * Phase 3 replaced offset paging with signed keyset cursors because an offset **repeats and drops
 * rows** whenever the underlying set changes between two requests — which for an admin queue being
 * worked by three people is every request. `check-table-surfaces.mjs` fails the build on a route
 * that accepts `?page=`. Drawing "1 2 3 … 64" over a cursor API would mean either lying about what
 * the buttons do or reintroducing the bug the phase exists to remove, so the footer offers the two
 * honest things a cursor can express: how much is loaded, and whether there is more.
 *
 * ## Why it can be absent
 *
 * A ten-row bounded table with no cursor has nothing to say here, and a footer reading "10 of 10"
 * under every settings table is furniture. The reference's own rule: hidden at ten or fewer rows
 * with no pagination.
 */
export function TableFooter({ loaded, total, hasMore, onLoadMore, loading }: TableFooterProps) {
  if (!shouldShowFooter({ loaded, total, hasMore })) return null

  return (
    <div className="tbl-footer" data-testid="table-footer">
      <p data-testid="table-footer-count">
        {total === null
          // The federated search cannot count third-party results without exhausting every
          // upstream, so it says what it knows rather than inventing a denominator.
          ? `${loaded.toLocaleString()} loaded`
          : `${loaded.toLocaleString()} of ${total.toLocaleString()}`}
      </p>
      {hasMore && onLoadMore && (
        <Button variant="ghost" size="sm" onClick={onLoadMore} loading={loading} data-testid="table-footer-more">
          Load more
        </Button>
      )}
    </div>
  )
}

/** Exported for the shell's own tests: the visibility rule is the part worth pinning. */
export function shouldShowFooter({ loaded, total, hasMore }: Pick<TableFooterProps, 'loaded' | 'total' | 'hasMore'>): boolean {
  if (loaded === 0) return false
  if (hasMore) return true
  // An unknown total is itself information — "there may be more" — so the footer stays.
  if (total === null) return true
  // More matching than loaded is the case the count exists for: 50 of 3,204.
  if (total > loaded) return true
  return loaded > 10
}
