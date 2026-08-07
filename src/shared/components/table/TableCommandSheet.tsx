import * as React from 'react'

import { Dialog } from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult, TableQuery } from '~/shared/lib/table/types'
import { cn } from '~/shared/lib/utils'

interface TableCommandSheetProps<Row> {
  open: boolean
  onClose: () => void
  columns: ColumnDef<Row>[]
  query: TableQuery
  onQueryChange: (next: TableQuery) => void
  facets: PageResult<Row>['facets']
  labels?: Record<string, string>
  /** Turns a stored dimension value into a readable one, same as the chips. */
  valueLabel?: (dimension: string, value: string) => string
}

interface Verb {
  id: string
  label: string
  /** The facet count, when the verb is a filter. A verb that would return nothing says so. */
  count?: number
  run: () => void
}

/**
 * `⌘K`: every filter, sort and group verb in one list.
 *
 * The toolbar shows the facets that fit. On an admin queue with nine filterable dimensions that is
 * most of them hidden behind a scroll, so the sheet is the complete set — and each filter verb
 * carries its facet count, which is the difference between choosing a filter and guessing at one.
 */
export function TableCommandSheet<Row>(props: TableCommandSheetProps<Row>) {
  const { open, onClose, columns, query, onQueryChange, facets, labels = {}, valueLabel } = props
  const [term, setTerm] = React.useState('')
  const searchRef = React.useRef<HTMLInputElement>(null)

  // Reset on open, adjusted during render rather than in an effect: an effect would render the
  // sheet once with the previous term still in the box before clearing it.
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setTerm('')
  }

  const verbs = React.useMemo<Verb[]>(() => {
    const list: Verb[] = []

    for (const column of columns) {
      if (!column.sortable) continue
      for (const dir of ['asc', 'desc'] as const) {
        list.push({
          id: `sort:${column.id}:${dir}`,
          label: `Sort by ${column.header} ${dir === 'asc' ? 'ascending' : 'descending'}`,
          run: () => onQueryChange({ ...query, sort: [{ id: column.id, dir }] }),
        })
      }
    }

    for (const [id, values] of Object.entries(facets)) {
      for (const facet of values) {
        const active = (query.filters[id] ?? []).includes(facet.value)
        list.push({
          id: `filter:${id}:${facet.value}`,
          label: `${active ? 'Remove' : 'Filter'} ${labels[id] ?? id}: ${valueLabel?.(id, facet.value) ?? facet.value}`,
          count: facet.count,
          run: () => {
            const current = query.filters[id] ?? []
            const next = active ? current.filter((entry) => entry !== facet.value) : [...current, facet.value]
            const filters = { ...query.filters }
            if (next.length === 0) delete filters[id]
            else filters[id] = next
            onQueryChange({ ...query, filters })
          },
        })
      }
    }

    for (const column of columns) {
      if (!column.groupable) continue
      list.push({
        id: `group:${column.id}`,
        label: `Group by ${column.header}`,
        run: () => onQueryChange({ ...query, groupBy: column.id }),
      })
    }
    if (query.groupBy) {
      list.push({ id: 'group:none', label: 'Remove grouping', run: () => onQueryChange({ ...query, groupBy: null }) })
    }

    return list
  }, [columns, facets, query, onQueryChange, labels])

  const filtered = term.trim() === ''
    ? verbs
    : verbs.filter((verb) => verb.label.toLowerCase().includes(term.trim().toLowerCase()))

  return (
    <Dialog open={open} onClose={onClose} title="Table commands" initialFocusRef={searchRef}>
      <Input
        ref={searchRef}
        type="search"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Filter, sort, group…"
        aria-label="Filter commands"
        data-testid="table-command-search"
      />
      <ul className="mt-3 max-h-80 overflow-y-auto" data-testid="table-command-list">
        {filtered.map((verb) => (
          <li key={verb.id}>
            <button
              type="button"
              onClick={() => { verb.run(); onClose() }}
              data-testid={`table-command-${verb.id}`}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-bh-text',
                'hover:bg-bh-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{verb.label}</span>
              {verb.count !== undefined && (
                <span className="tabular-nums text-xs text-bh-text-muted">{verb.count.toLocaleString()}</span>
              )}
            </button>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="px-3 py-6 text-center text-sm text-bh-text-muted">No matching command</li>
        )}
      </ul>
    </Dialog>
  )
}
