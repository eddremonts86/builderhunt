import type { ReactNode } from 'react'

import { cn } from '~/shared/lib/utils'

interface PrimaryCellProps {
  /** The row's name. The only text in a table that is allowed to ellipsize. */
  title: string
  /** A second line: a slug, an id, an owner, a URL. */
  meta?: ReactNode
  /**
   * Render the metadata line in the monospace face.
   *
   * Off by default. The reference draws this line in mono, and DESIGN.md:221 reserves a monospace
   * face for literal code and keys — the two agree exactly when the metadata *is* an identifier
   * (a slug, a job key, a commit), which is most of the time and not all of it. So it is opt-in
   * rather than automatic: "reviewed by Ana" in mono reads as a value that can be copied and
   * pasted somewhere, which it cannot.
   */
  monoMeta?: boolean
  /** Rendered before the title — a favicon, a source mark. Never a decorative icon. */
  leading?: ReactNode
}

/**
 * The row's identity: a 13.5px/600 title over optional 11px metadata.
 *
 * The only two-line cell by default, and the only cell in the whole vocabulary permitted to
 * truncate — free text is the one kind of content whose tail is expendable. A truncated date is a
 * wrong date and a truncated number is a wrong number, so those kinds take fixed column tracks
 * instead (`grid-roles.ts`).
 *
 * Truncating still costs something, so it is paid for: the full string goes on `title`, which is
 * what a mouse user gets as a tooltip and what a screen reader reads in place of the clipped text.
 * A cell that ellipsizes without that is a cell where the information is simply gone.
 */
export function PrimaryCell({ title, meta, monoMeta, leading }: PrimaryCellProps) {
  return (
    <div className="tbl-primary" data-testid="cell-primary">
      {leading}
      <div className="min-w-0">
        {/* `title` is the escape hatch for the ellipsis, not decoration — see the doc comment. */}
        <div className="tbl-cell-primary" title={title}>{title}</div>
        {meta !== undefined && meta !== null && meta !== '' && (
          <div className={cn('tbl-cell-meta', monoMeta && 'font-mono')} data-testid="cell-primary-meta">{meta}</div>
        )}
      </div>
    </div>
  )
}
