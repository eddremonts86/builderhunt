import { describe, expect, it } from 'vitest'
import { nextSprintCursor } from '~/lib/sprints/worker'

describe('nextSprintCursor', () => {
  it('advances the page within the same variant while under the page cap', () => {
    const result = nextSprintCursor({ variantIndex: 0, page: 1 }, 2)
    expect(result).toEqual({ cursor: { variantIndex: 0, page: 2 }, exhausted: false })
  })

  it('rolls over to the next variant at page 1 once the page cap is reached', () => {
    const result = nextSprintCursor({ variantIndex: 0, page: 3 }, 2)
    expect(result).toEqual({ cursor: { variantIndex: 1, page: 1 }, exhausted: false })
  })

  it('reports exhausted once the last variant also hits the page cap', () => {
    const result = nextSprintCursor({ variantIndex: 1, page: 3 }, 2)
    expect(result).toEqual({ cursor: { variantIndex: 1, page: 3 }, exhausted: true })
  })

  it('reports exhausted immediately for a sprint with zero variants', () => {
    const cursor = { variantIndex: 0, page: 1 }
    expect(nextSprintCursor(cursor, 0)).toEqual({ cursor, exhausted: true })
  })
})
