import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { useTableSelection } from '~/shared/components/table/useTableSelection'
import { TABLE_PAGE_SIZE } from '~/shared/lib/table/constants'
import type { TableQuery } from '~/shared/lib/table/types'

import { renderHookValue } from './render-hook'

/**
 * Selection at 50 rows a page.
 *
 * The bug this file guards is not a crash either: it is a header checkbox labelled "select all"
 * that selected 50 of 3,204, followed by a bulk action that quietly applied to the 50. Every
 * assertion here is about the two meanings staying distinguishable.
 */

const query: TableQuery = { search: '', filters: {}, sort: [], groupBy: null }
const rowIds = ['a', 'b', 'c']

function setup(options: Partial<Parameters<typeof useTableSelection>[0]> = {}) {
  return renderHookValue(
    (props: { rowIds: string[]; query: TableQuery }) =>
      useTableSelection({ rowIds: props.rowIds, query: props.query, ...options }),
    { rowIds, query },
  )
}

describe('the header checkbox', () => {
  it('is tri-state over the loaded rows', () => {
    const hook = setup()
    expect(hook.current.headerState).toBe(false)

    act(() => hook.current.toggle('a'))
    expect(hook.current.headerState).toBe('indeterminate')

    act(() => hook.current.toggleLoaded())
    expect(hook.current.headerState).toBe(true)
    expect(hook.current.loadedSelectedCount).toBe(3)
  })

  it('reports the loaded count, not the matching count', () => {
    const hook = setup()
    act(() => hook.current.toggleLoaded())
    // Three loaded of a hypothetical 3,204 matching. The number says three.
    expect(hook.current.loadedSelectedCount).toBe(3)
    expect(hook.current.matching).toBeNull()
  })

  it('deselects every loaded row when they are all selected', () => {
    const hook = setup()
    act(() => hook.current.toggleLoaded())
    act(() => hook.current.toggleLoaded())
    expect(hook.current.selectedIds).toEqual([])
  })
})

describe('range extension', () => {
  it('selects everything between two indices, inclusive, in either direction', () => {
    const hook = renderHookValue(
      (props: { rowIds: string[]; query: TableQuery }) => useTableSelection(props),
      { rowIds: ['a', 'b', 'c', 'd', 'e'], query },
    )
    act(() => hook.current.extend(3, 1))
    expect(hook.current.selectedIds.sort()).toEqual(['b', 'c', 'd'])
  })

  it('clamps a range that runs past the loaded rows', () => {
    const hook = setup()
    act(() => hook.current.extend(1, 99))
    expect(hook.current.selectedIds.sort()).toEqual(['b', 'c'])
  })
})

describe('select all matching', () => {
  /** A table that cannot answer "how many match?" must not offer an action that implies it can. */
  it('is unavailable when the table did not implement it', () => {
    const hook = setup()
    expect(hook.current.canSelectAllMatching).toBe(false)
  })

  it('is available when it was provided, and reports the server\'s count and token', async () => {
    const selectAllMatching = vi.fn().mockResolvedValue({ count: 3204, token: 'predicate-token' })
    const hook = setup({ selectAllMatching })
    expect(hook.current.canSelectAllMatching).toBe(true)

    await act(async () => { await hook.current.requestSelectAllMatching() })
    expect(selectAllMatching).toHaveBeenCalledWith(query)
    expect(hook.current.matching).toEqual({ count: 3204, token: 'predicate-token' })
  })

  /**
   * The predicate selection deliberately does not check 3,204 boxes: those rows were never loaded,
   * and pretending otherwise would mean rendering state for rows that do not exist.
   */
  it('does not touch the per-row selection', async () => {
    const selectAllMatching = vi.fn().mockResolvedValue({ count: 3204, token: 't' })
    const hook = setup({ selectAllMatching })
    await act(async () => { await hook.current.requestSelectAllMatching() })
    expect(hook.current.selectedIds).toEqual([])
  })

  it('is retired the moment the user touches a row checkbox', async () => {
    const selectAllMatching = vi.fn().mockResolvedValue({ count: 3204, token: 't' })
    const hook = setup({ selectAllMatching })
    await act(async () => { await hook.current.requestSelectAllMatching() })
    act(() => hook.current.toggle('a'))
    expect(hook.current.matching).toBeNull()
  })

  /** A token minted for "status=open" must not survive a switch to "status=closed". */
  it('is retired when the query changes', async () => {
    const selectAllMatching = vi.fn().mockResolvedValue({ count: 3204, token: 't' })
    const hook = renderHookValue(
      (props: { rowIds: string[]; query: TableQuery }) => useTableSelection({ ...props, selectAllMatching }),
      { rowIds, query },
    )
    await act(async () => { await hook.current.requestSelectAllMatching() })
    expect(hook.current.matching).not.toBeNull()

    act(() => hook.rerender({ rowIds, query: { ...query, filters: { status: ['closed'] } } }))
    expect(hook.current.matching).toBeNull()
  })
})

describe('the change callback', () => {
  it('reports the selected ids to the surface', () => {
    const onChange = vi.fn()
    const hook = setup({ onChange })
    act(() => hook.current.toggle('b'))
    expect(onChange).toHaveBeenLastCalledWith(['b'])
    act(() => hook.current.clear())
    expect(onChange).toHaveBeenLastCalledWith([])
  })
})

describe('the page size this is all about', () => {
  it('is the shared constant, so the "loaded versus matching" gap is one number wide', () => {
    expect(TABLE_PAGE_SIZE).toBe(50)
  })
})
