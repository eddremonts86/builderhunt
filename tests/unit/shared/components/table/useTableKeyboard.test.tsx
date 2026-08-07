import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { PAGE_JUMP, useTableKeyboard, type TableKeyboardOptions } from '~/shared/components/table/useTableKeyboard'

import { renderHookValue } from './render-hook'

/**
 * The keyboard model, tested as a hook rather than through a rendered grid.
 *
 * Every clamp in here is a real bug someone would otherwise hit exactly once, at an edge: `↑` on
 * the first row scrolling the page, `PageDown` on the last row landing on nothing, `→` on the last
 * column jumping to the next row. None of them are visible in a screenshot.
 */

function keyEvent(key: string, modifiers: Partial<KeyboardEvent> = {}) {
  return {
    key,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    target: { tagName: 'DIV', isContentEditable: false },
    preventDefault: vi.fn(),
    ...modifiers,
  } as unknown as React.KeyboardEvent
}

function setup(options: Partial<TableKeyboardOptions> = {}) {
  return renderHookValue(() => useTableKeyboard({ rowCount: 20, columnCount: 4, ...options }))
}

describe('arrow keys', () => {
  it('moves down a row and right a cell', () => {
    const hook = setup()
    act(() => hook.current.onKeyDown(keyEvent('ArrowDown')))
    expect(hook.current.position).toEqual({ row: 1, column: 0 })
    act(() => hook.current.onKeyDown(keyEvent('ArrowRight')))
    expect(hook.current.position).toEqual({ row: 1, column: 1 })
  })

  it('clamps at the first row instead of wrapping or scrolling the page', () => {
    const hook = setup()
    act(() => hook.current.onKeyDown(keyEvent('ArrowUp')))
    expect(hook.current.position).toEqual({ row: 0, column: 0 })
  })

  it('clamps at the last row and the last column', () => {
    const hook = setup({ rowCount: 3, columnCount: 2 })
    act(() => hook.current.setPosition({ row: 2, column: 1 }))
    act(() => hook.current.onKeyDown(keyEvent('ArrowDown')))
    act(() => hook.current.onKeyDown(keyEvent('ArrowRight')))
    expect(hook.current.position).toEqual({ row: 2, column: 1 })
  })

  /** A table whose rows fit on screen does not need cell traversal, and arrow-left should not trap focus. */
  it('ignores horizontal arrows in row navigation mode', () => {
    const hook = setup({ navigation: 'row' })
    act(() => hook.current.onKeyDown(keyEvent('ArrowRight')))
    expect(hook.current.position).toEqual({ row: 0, column: 0 })
  })
})

describe('Home and End', () => {
  it('go to the first and last cell of the current row', () => {
    const hook = setup({ rowCount: 10, columnCount: 5 })
    act(() => hook.current.setPosition({ row: 4, column: 2 }))
    act(() => hook.current.onKeyDown(keyEvent('End')))
    expect(hook.current.position).toEqual({ row: 4, column: 4 })
    act(() => hook.current.onKeyDown(keyEvent('Home')))
    expect(hook.current.position).toEqual({ row: 4, column: 0 })
  })

  it('go to the first and last cell of the grid with a modifier, as in every spreadsheet', () => {
    const hook = setup({ rowCount: 10, columnCount: 5 })
    act(() => hook.current.onKeyDown(keyEvent('End', { metaKey: true })))
    expect(hook.current.position).toEqual({ row: 9, column: 4 })
    act(() => hook.current.onKeyDown(keyEvent('Home', { ctrlKey: true })))
    expect(hook.current.position).toEqual({ row: 0, column: 0 })
  })
})

describe('PageUp and PageDown', () => {
  it('move ten rows', () => {
    const hook = setup({ rowCount: 50 })
    act(() => hook.current.onKeyDown(keyEvent('PageDown')))
    expect(hook.current.position.row).toBe(PAGE_JUMP)
    act(() => hook.current.onKeyDown(keyEvent('PageUp')))
    expect(hook.current.position.row).toBe(0)
  })

  it('clamp at both ends rather than landing outside the grid', () => {
    const hook = setup({ rowCount: 6 })
    act(() => hook.current.onKeyDown(keyEvent('PageDown')))
    expect(hook.current.position.row).toBe(5)
    act(() => hook.current.onKeyDown(keyEvent('PageUp')))
    expect(hook.current.position.row).toBe(0)
  })
})

describe('selection keys', () => {
  it('Space toggles the focused row', () => {
    const onToggleSelect = vi.fn()
    const hook = setup({ onToggleSelect })
    act(() => hook.current.setPosition({ row: 3, column: 1 }))
    act(() => hook.current.onKeyDown(keyEvent(' ')))
    expect(onToggleSelect).toHaveBeenCalledWith(3)
  })

  /** The anchor is where the range started, not where it is now — otherwise shift-arrow selects two rows forever. */
  it('shift-arrow extends from the anchor, which does not move as the range grows', () => {
    const onExtendSelection = vi.fn()
    const hook = setup({ onExtendSelection })
    act(() => hook.current.setPosition({ row: 2, column: 0 }))
    act(() => hook.current.onKeyDown(keyEvent('ArrowDown', { shiftKey: true })))
    act(() => hook.current.onKeyDown(keyEvent('ArrowDown', { shiftKey: true })))
    expect(onExtendSelection).toHaveBeenNthCalledWith(1, 2, 3)
    expect(onExtendSelection).toHaveBeenNthCalledWith(2, 2, 4)
  })

  it('an unshifted move drops the anchor, the way a file list behaves', () => {
    const onExtendSelection = vi.fn()
    const hook = setup({ onExtendSelection })
    act(() => hook.current.onKeyDown(keyEvent('ArrowDown', { shiftKey: true })))
    act(() => hook.current.onKeyDown(keyEvent('ArrowDown')))
    act(() => hook.current.onKeyDown(keyEvent('ArrowDown', { shiftKey: true })))
    expect(onExtendSelection).toHaveBeenLastCalledWith(2, 3)
  })

  it('Escape clears', () => {
    const onClearSelection = vi.fn()
    const hook = setup({ onClearSelection })
    act(() => hook.current.onKeyDown(keyEvent('Escape')))
    expect(onClearSelection).toHaveBeenCalled()
  })

  it('Enter runs the row action', () => {
    const onPrimaryAction = vi.fn()
    const hook = setup({ onPrimaryAction })
    act(() => hook.current.setPosition({ row: 7, column: 0 }))
    act(() => hook.current.onKeyDown(keyEvent('Enter')))
    expect(onPrimaryAction).toHaveBeenCalledWith(7)
  })
})

describe('grid-level verbs', () => {
  it('/ focuses the toolbar search', () => {
    const onFocusSearch = vi.fn()
    const hook = setup({ onFocusSearch })
    act(() => hook.current.onKeyDown(keyEvent('/')))
    expect(onFocusSearch).toHaveBeenCalled()
  })

  /** Otherwise typing a URL into a filter box silently jumps focus out of it. */
  it('/ is left alone while the user is typing in an input', () => {
    const onFocusSearch = vi.fn()
    const hook = setup({ onFocusSearch })
    act(() => hook.current.onKeyDown(keyEvent('/', { target: { tagName: 'INPUT' } } as never)))
    expect(onFocusSearch).not.toHaveBeenCalled()
  })

  it('⌘K and Ctrl+K open the command sheet', () => {
    const onOpenCommandSheet = vi.fn()
    const hook = setup({ onOpenCommandSheet })
    act(() => hook.current.onKeyDown(keyEvent('k', { metaKey: true })))
    act(() => hook.current.onKeyDown(keyEvent('K', { ctrlKey: true })))
    expect(onOpenCommandSheet).toHaveBeenCalledTimes(2)
  })

  it('does not steal arrow keys from a cell that is being typed into', () => {
    const hook = setup()
    act(() => hook.current.onKeyDown(keyEvent('ArrowDown', { target: { tagName: 'TEXTAREA' } } as never)))
    expect(hook.current.position).toEqual({ row: 0, column: 0 })
  })
})

describe('asking for the next page', () => {
  /** On arrival at the last loaded row, not on the key press — a held arrow requests once, not once per repeat. */
  it('fires when a move lands on the last loaded row', () => {
    const onReachEnd = vi.fn()
    const hook = setup({ rowCount: 3, onReachEnd })
    act(() => hook.current.onKeyDown(keyEvent('ArrowDown')))
    expect(onReachEnd).not.toHaveBeenCalled()
    act(() => hook.current.onKeyDown(keyEvent('ArrowDown')))
    expect(onReachEnd).toHaveBeenCalledTimes(1)
  })
})

describe('the focused cell when rows disappear under it', () => {
  /**
   * A filter narrowing 50 rows to 3 leaves the focus coordinate at row 40. Left alone, no cell in
   * the grid carries `tabIndex={0}` and the next Tab press leaves the table entirely.
   */
  it('is clamped back into the grid', () => {
    const hook = renderHookValue(
      (props: { rowCount: number }) => useTableKeyboard({ rowCount: props.rowCount, columnCount: 4 }),
      { rowCount: 50 },
    )
    act(() => hook.current.setPosition({ row: 40, column: 2 }))
    expect(hook.current.position.row).toBe(40)

    act(() => hook.rerender({ rowCount: 3 }))
    expect(hook.current.position).toEqual({ row: 2, column: 2 })
    expect(hook.current.isFocused(2, 2)).toBe(true)
  })
})
