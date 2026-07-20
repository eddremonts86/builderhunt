import { describe, expect, it } from 'vitest'
import { SOURCE_NAMES } from '~/lib/sources/types'
import { cellAt, DISCOVERY_MATRIX } from './matrix'

describe('DISCOVERY_MATRIX', () => {
  it('has at least 40 cells', () => {
    expect(DISCOVERY_MATRIX.length).toBeGreaterThanOrEqual(40)
  })

  it('has unique keys', () => {
    const keys = DISCOVERY_MATRIX.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every cell has 1-3 keywords', () => {
    for (const cell of DISCOVERY_MATRIX) {
      expect(cell.keywords.length).toBeGreaterThanOrEqual(1)
      expect(cell.keywords.length).toBeLessThanOrEqual(3)
    }
  })

  it('every cell has 1-4 valid sources', () => {
    for (const cell of DISCOVERY_MATRIX) {
      expect(cell.sources.length).toBeGreaterThanOrEqual(1)
      expect(cell.sources.length).toBeLessThanOrEqual(4)
      for (const source of cell.sources) {
        expect(SOURCE_NAMES).toContain(source)
      }
    }
  })
})

describe('cellAt', () => {
  it('wraps around the matrix length', () => {
    expect(cellAt(DISCOVERY_MATRIX.length)).toEqual(cellAt(0))
    expect(cellAt(DISCOVERY_MATRIX.length + 1)).toEqual(cellAt(1))
  })

  it('handles negative cursors without throwing', () => {
    expect(() => cellAt(-1)).not.toThrow()
    expect(cellAt(-1)).toEqual(cellAt(DISCOVERY_MATRIX.length - 1))
  })
})
