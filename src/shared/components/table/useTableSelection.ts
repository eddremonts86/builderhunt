import * as React from 'react'

import type { TableQuery } from '~/shared/lib/table/types'

/**
 * Selection that is honest about only holding one page.
 *
 * At 50 rows a page the header checkbox cannot mean "all 3,204 matching rows" — it can only mean
 * the ones that are loaded. Most tables paper over this by labelling it "select all", and then a
 * bulk action quietly applies to 50 of 3,204. So the two meanings are two controls:
 *
 * - **Select loaded** — the tri-state header checkbox, which says how many it selected.
 * - **Select all N matching** — sends the `TableQuery` predicate to the server, which answers with
 *   a count and a token. Bulk actions take the token instead of an id list, because an id list is
 *   the thing that cannot represent "everything matching".
 *
 * A table that does not implement the second **hides it**. Rendering a disabled or absent-but-implied
 * "select all" is how the narrower meaning sneaks back in.
 */

export interface MatchingSelection {
  count: number
  /** Server-issued, carries the predicate. Bulk actions take this instead of ids. */
  token: string
}

export type SelectAllMatching = (query: TableQuery) => Promise<MatchingSelection>

export interface TableSelectionOptions {
  rowIds: string[]
  query: TableQuery
  onChange?: (ids: string[]) => void
  selectAllMatching?: SelectAllMatching
}

export interface TableSelectionResult {
  selectedIds: string[]
  isSelected: (id: string) => boolean
  toggle: (id: string) => void
  /** `⇧`+arrow, and `⇧`+click: everything between two row indices, inclusive. */
  extend: (fromIndex: number, toIndex: number) => void
  clear: () => void
  /** `false` | `true` | `'indeterminate'`, over the loaded rows only. */
  headerState: boolean | 'indeterminate'
  toggleLoaded: () => void
  /** "50 selected", never "all selected". */
  loadedSelectedCount: number
  /** `null` until the user asks for it; present only when `selectAllMatching` was provided. */
  matching: MatchingSelection | null
  canSelectAllMatching: boolean
  requestSelectAllMatching: () => Promise<void>
  isRequestingMatching: boolean
}

export function useTableSelection(options: TableSelectionOptions): TableSelectionResult {
  const { rowIds, query, onChange, selectAllMatching } = options

  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set())
  const [matching, setMatching] = React.useState<MatchingSelection | null>(null)
  const [isRequestingMatching, setRequesting] = React.useState(false)

  const update = React.useCallback((next: ReadonlySet<string>) => {
    setSelected(next)
    // Any change to the explicit selection retires the predicate selection: they are two different
    // answers to "what did the user pick", and keeping both would let a bulk action use the wrong one.
    setMatching(null)
    onChange?.([...next])
  }, [onChange])

  const toggle = React.useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setMatching(null)
      onChange?.([...next])
      return next
    })
  }, [onChange])

  const extend = React.useCallback((fromIndex: number, toIndex: number) => {
    const start = Math.max(0, Math.min(fromIndex, toIndex))
    const end = Math.min(rowIds.length - 1, Math.max(fromIndex, toIndex))
    setSelected((current) => {
      const next = new Set(current)
      for (let index = start; index <= end; index += 1) {
        const id = rowIds[index]
        if (id) next.add(id)
      }
      setMatching(null)
      onChange?.([...next])
      return next
    })
  }, [rowIds, onChange])

  const clear = React.useCallback(() => update(new Set()), [update])

  const loadedSelectedCount = React.useMemo(
    () => rowIds.reduce((count, id) => (selected.has(id) ? count + 1 : count), 0),
    [rowIds, selected],
  )

  const headerState: boolean | 'indeterminate' = loadedSelectedCount === 0
    ? false
    : loadedSelectedCount === rowIds.length && rowIds.length > 0
      ? true
      : 'indeterminate'

  const toggleLoaded = React.useCallback(() => {
    const allLoadedSelected = rowIds.length > 0 && rowIds.every((id) => selected.has(id))
    const next = new Set(selected)
    for (const id of rowIds) {
      if (allLoadedSelected) next.delete(id)
      else next.add(id)
    }
    update(next)
  }, [rowIds, selected, update])

  const requestSelectAllMatching = React.useCallback(async () => {
    if (!selectAllMatching) return
    setRequesting(true)
    try {
      const result = await selectAllMatching(query)
      // Deliberately does not touch `selected`: the predicate selection is a *different* thing, and
      // pretending it is 3,204 checked boxes would mean re-rendering rows that were never loaded.
      setMatching(result)
    } finally {
      setRequesting(false)
    }
  }, [selectAllMatching, query])

  // A new filter invalidates a predicate token minted for the previous one. Adjusted during render
  // rather than in an effect, so no frame ever shows "all 3,204 matching selected" beside rows the
  // new filter just narrowed to eleven.
  const queryKey = JSON.stringify(query)
  const [lastQueryKey, setLastQueryKey] = React.useState(queryKey)
  if (queryKey !== lastQueryKey) {
    setLastQueryKey(queryKey)
    if (matching !== null) setMatching(null)
  }

  return {
    selectedIds: React.useMemo(() => [...selected], [selected]),
    isSelected: React.useCallback((id: string) => selected.has(id), [selected]),
    toggle,
    extend,
    clear,
    headerState,
    toggleLoaded,
    loadedSelectedCount,
    matching,
    canSelectAllMatching: typeof selectAllMatching === 'function',
    requestSelectAllMatching,
    isRequestingMatching,
  }
}
