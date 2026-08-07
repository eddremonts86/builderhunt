import * as React from 'react'

/**
 * One focus stop for the whole grid.
 *
 * A grid with a tab stop per cell makes a 50×8 table 400 presses deep, so the shell uses a roving
 * tabindex: exactly one cell is `tabIndex={0}` and the arrows move it. That is what `role="grid"`
 * promises a screen-reader user, and none of the 19 surfaces this replaces delivered any of it.
 *
 * Cell traversal is the default because the widest surfaces are admin queues where a row does not
 * fit on screen and "the row is focused" tells a keyboard user nothing about which of nine columns
 * they are reading. A table whose rows are narrow can opt into `navigation="row"`.
 */

export type TableNavigationMode = 'cell' | 'row'

export interface GridPosition {
  row: number
  column: number
}

/** ±10 rows, the conventional `PageUp`/`PageDown` jump for a grid. */
export const PAGE_JUMP = 10

export interface TableKeyboardOptions {
  rowCount: number
  columnCount: number
  navigation?: TableNavigationMode
  /** `Enter` on a row. */
  onPrimaryAction?: (rowIndex: number) => void
  /** `Space` on a row. */
  onToggleSelect?: (rowIndex: number) => void
  /** `⇧`+`↑`/`↓`: extend from the anchor to the row moved onto. */
  onExtendSelection?: (fromRow: number, toRow: number) => void
  /** `Esc`. */
  onClearSelection?: () => void
  /** `/` focuses the toolbar's search input. */
  onFocusSearch?: () => void
  /** `⌘K` / `Ctrl+K`. */
  onOpenCommandSheet?: () => void
  /** Reaching the last loaded row asks for the next page. */
  onReachEnd?: () => void
}

export interface TableKeyboardResult {
  position: GridPosition
  setPosition: (position: GridPosition) => void
  /** True for the one cell that carries `tabIndex={0}`. */
  isFocused: (row: number, column: number) => boolean
  onKeyDown: (event: React.KeyboardEvent) => void
  /** Register a cell so focus can be moved to it after a key press. */
  registerCell: (row: number, column: number, element: HTMLElement | null) => void
}

function clamp(value: number, max: number): number {
  if (max < 0) return 0
  return Math.min(Math.max(value, 0), max)
}

export function useTableKeyboard(options: TableKeyboardOptions): TableKeyboardResult {
  const {
    rowCount,
    columnCount,
    navigation = 'cell',
    onPrimaryAction,
    onToggleSelect,
    onExtendSelection,
    onClearSelection,
    onFocusSearch,
    onOpenCommandSheet,
    onReachEnd,
  } = options

  const [position, setPositionState] = React.useState<GridPosition>({ row: 0, column: 0 })
  const cells = React.useRef(new Map<string, HTMLElement>())
  const pending = React.useRef<GridPosition | null>(null)
  // Where a shift-range started. Cleared by any unshifted move, the way a file list behaves.
  const anchor = React.useRef<number | null>(null)

  const registerCell = React.useCallback((row: number, column: number, element: HTMLElement | null) => {
    const key = `${row}:${column}`
    if (element) cells.current.set(key, element)
    else cells.current.delete(key)
  }, [])

  // Focus is moved in an effect rather than in the handler because the cell may not exist yet:
  // `PageDown` past the loaded window asks for more rows, and the element arrives a render later.
  React.useEffect(() => {
    const target = pending.current
    if (!target) return
    const element = cells.current.get(`${target.row}:${target.column}`)
    if (element) {
      element.focus()
      pending.current = null
    }
  })

  const setPosition = React.useCallback((next: GridPosition) => {
    setPositionState(next)
    pending.current = next
  }, [])

  /**
   * `from` is where the move started, passed in rather than read back out of state.
   *
   * The tidy-looking version puts this inside a functional `setState` updater so it can see the
   * current position — but extending a selection and asking for the next page are side effects,
   * and React is free to call an updater twice. Every caller already knows where it is.
   */
  const move = React.useCallback((from: GridPosition, next: GridPosition, extend: boolean) => {
    const current = from
    const target = {
      row: clamp(next.row, rowCount - 1),
      column: clamp(next.column, columnCount - 1),
    }
    if (extend && onExtendSelection) {
      if (anchor.current === null) anchor.current = current.row
      onExtendSelection(anchor.current, target.row)
    } else {
      anchor.current = null
    }
    pending.current = target
    // Asking for the next page on arrival at the last loaded row, not on the key press, means a
    // held-down arrow requests once rather than once per repeat.
    if (target.row >= rowCount - 1) onReachEnd?.()
    setPositionState(target)
  }, [rowCount, columnCount, onExtendSelection, onReachEnd])

  const onKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    const { row, column } = position

    // `⌘K` and `/` are grid-level verbs, so they are handled before anything positional — but not
    // while the user is typing into a cell's own input, which owns its keystrokes.
    const target = event.target as HTMLElement | null
    const isTextEntry = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      if (!onOpenCommandSheet) return
      event.preventDefault()
      onOpenCommandSheet()
      return
    }
    if (event.key === '/' && !isTextEntry && onFocusSearch) {
      event.preventDefault()
      onFocusSearch()
      return
    }
    if (isTextEntry) return

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(position, { row: row + 1, column }, event.shiftKey)
        return
      case 'ArrowUp':
        event.preventDefault()
        move(position, { row: row - 1, column }, event.shiftKey)
        return
      case 'ArrowRight':
        if (navigation === 'row') return
        event.preventDefault()
        move(position, { row, column: column + 1 }, false)
        return
      case 'ArrowLeft':
        if (navigation === 'row') return
        event.preventDefault()
        move(position, { row, column: column - 1 }, false)
        return
      case 'Home':
        event.preventDefault()
        // `⌘`/`Ctrl` widens Home/End from the row to the grid, as in every spreadsheet.
        move(position, event.metaKey || event.ctrlKey ? { row: 0, column: 0 } : { row, column: 0 }, false)
        return
      case 'End':
        event.preventDefault()
        move(
          position,
          event.metaKey || event.ctrlKey
            ? { row: rowCount - 1, column: columnCount - 1 }
            : { row, column: columnCount - 1 },
          false,
        )
        return
      case 'PageDown':
        event.preventDefault()
        move(position, { row: row + PAGE_JUMP, column }, event.shiftKey)
        return
      case 'PageUp':
        event.preventDefault()
        move(position, { row: row - PAGE_JUMP, column }, event.shiftKey)
        return
      case ' ':
      case 'Spacebar':
        if (!onToggleSelect) return
        event.preventDefault()
        onToggleSelect(row)
        anchor.current = row
        return
      case 'Enter':
        if (!onPrimaryAction) return
        event.preventDefault()
        onPrimaryAction(row)
        return
      case 'Escape':
        if (!onClearSelection) return
        event.preventDefault()
        onClearSelection()
        anchor.current = null
        return
      default:
    }
  }, [
    position, navigation, move, rowCount, columnCount,
    onToggleSelect, onPrimaryAction, onClearSelection, onFocusSearch, onOpenCommandSheet,
  ])

  // The focused cell can fall outside the grid when rows disappear under it — a filter narrowing
  // the set, or an error replacing the page. Clamping keeps exactly one cell focusable.
  //
  // Adjusted during render rather than in an effect: an effect would let one frame render with a
  // `tabIndex={0}` cell that no longer exists, and a Tab press in that frame leaves the grid.
  const clampedRow = clamp(position.row, rowCount - 1)
  const clampedColumn = clamp(position.column, columnCount - 1)
  if (clampedRow !== position.row || clampedColumn !== position.column) {
    setPositionState({ row: clampedRow, column: clampedColumn })
  }

  const isFocused = React.useCallback(
    (row: number, column: number) => position.row === row && (navigation === 'row' || position.column === column),
    [position, navigation],
  )

  return { position, setPosition, isFocused, onKeyDown, registerCell }
}
