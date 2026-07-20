import { describe, expect, it } from 'vitest'
import {
  createSprintSchema,
  extractedCriteriaSchema,
  manualCriteriaToVariant,
  queryVariantSchema,
  sprintFilterSchema,
  updateSprintSchema,
} from './sprints-shared'

const validCriteria = {
  skills: ['rust', 'webgl'],
  roles: ['backend'],
  seniority: 'senior' as const,
  locations: ['remote'],
  mustHaves: ['open source'],
}

describe('extractedCriteriaSchema', () => {
  it('accepts a valid payload', () => {
    expect(extractedCriteriaSchema.safeParse(validCriteria).success).toBe(true)
  })

  it('rejects empty skills', () => {
    expect(extractedCriteriaSchema.safeParse({ ...validCriteria, skills: [] }).success).toBe(false)
  })

  it('rejects an unknown seniority value', () => {
    expect(extractedCriteriaSchema.safeParse({ ...validCriteria, seniority: 'staff' }).success).toBe(false)
  })
})

describe('queryVariantSchema', () => {
  it('accepts a valid variant with a known source', () => {
    const result = queryVariantSchema.safeParse({
      name: 'Rust backend',
      keywords: ['rust', 'tokio'],
      sources: ['github', 'hn'],
      rationale: 'Matches the reviewed skills.',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an invalid source name', () => {
    const result = queryVariantSchema.safeParse({
      name: 'Bad',
      keywords: ['rust'],
      sources: ['linkedin'],
      rationale: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('rejects more than 4 variants at the create-sprint level', () => {
    const variant = { name: 'v', keywords: ['x'], rationale: 'x' }
    const result = createSprintSchema.safeParse({
      name: 'Sprint',
      criteria: validCriteria,
      variants: [variant, variant, variant, variant, variant],
    })
    expect(result.success).toBe(false)
  })
})

describe('createSprintSchema', () => {
  const variant = { name: 'v', keywords: ['x'], rationale: 'x' }

  it('accepts a minimal valid payload', () => {
    const result = createSprintSchema.safeParse({
      name: 'Sprint',
      criteria: validCriteria,
      variants: [variant],
    })
    expect(result.success).toBe(true)
  })

  it('rejects unknown top-level keys (strict)', () => {
    const result = createSprintSchema.safeParse({
      name: 'Sprint',
      criteria: validCriteria,
      variants: [variant],
      userId: 'forged-user-id',
    })
    expect(result.success).toBe(false)
  })
})

describe('updateSprintSchema', () => {
  it('accepts a pause action', () => {
    expect(updateSprintSchema.safeParse({ action: 'pause' }).success).toBe(true)
  })

  it('accepts a name-only update', () => {
    expect(updateSprintSchema.safeParse({ name: 'Renamed' }).success).toBe(true)
  })

  it('rejects an invalid action value', () => {
    expect(updateSprintSchema.safeParse({ action: 'archive' }).success).toBe(false)
  })

  it('rejects mixing action with other fields (strict union)', () => {
    expect(updateSprintSchema.safeParse({ action: 'pause', name: 'x' }).success).toBe(false)
  })
})

describe('sprintFilterSchema', () => {
  it('accepts an empty filter', () => {
    expect(sprintFilterSchema.safeParse({ keywords: [] }).success).toBe(true)
  })

  it('rejects an invalid source in the filter', () => {
    expect(sprintFilterSchema.safeParse({ keywords: [], sources: ['not-a-source'] }).success).toBe(false)
  })
})

describe('manualCriteriaToVariant', () => {
  it('builds a deterministic variant from up to 4 skills', () => {
    const variant = manualCriteriaToVariant({
      ...validCriteria,
      skills: ['a', 'b', 'c', 'd', 'e'],
    })
    expect(variant.keywords).toEqual(['a', 'b', 'c', 'd'])
    expect(variant.name).toBe('Manual')
    expect(queryVariantSchema.safeParse(variant).success).toBe(true)
  })
})
