// Pure contracts for the ai-sourcing-sprints plan — safe to import on both
// client and server. No I/O here; see src/lib/sprints/* for the service,
// worker, and result helpers that consume these types.
import { z } from 'zod'
import { SOURCE_NAMES } from '~/lib/sources/types'

export const extractedCriteriaSchema = z.object({
  skills: z.array(z.string().min(1)).min(1).max(20),
  roles: z.array(z.string()).max(5),
  seniority: z.enum(['junior', 'mid', 'senior', 'unknown']),
  locations: z.array(z.string()).max(5),
  mustHaves: z.array(z.string()).max(8),
})
export type ExtractedCriteria = z.infer<typeof extractedCriteriaSchema>

export const queryVariantSchema = z.object({
  name: z.string().min(1).max(60),
  keywords: z.array(z.string().min(1)).min(1).max(8),
  sources: z.array(z.enum(SOURCE_NAMES)).optional(),
  language: z.string().optional(),
  country: z.string().optional(),
  rationale: z.string().max(300),
})
export type QueryVariant = z.infer<typeof queryVariantSchema>

export const sprintFilterSchema = z.object({
  keywords: z.array(z.string()).max(8),
  sources: z.array(z.enum(SOURCE_NAMES)).optional(),
  country: z.string().optional(),
  minFollowers: z.number().int().optional(),
  types: z.array(z.string()).optional(),
})
export type SprintFilter = z.infer<typeof sprintFilterSchema>

export const sprintProfileSnapshotSchema = z.object({
  username: z.string(),
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
  bio: z.string().optional(),
  profileUrl: z.string(),
  followersCount: z.number().optional(),
  language: z.string().optional(),
  country: z.string().optional(),
  topics: z.array(z.string()),
})
export type SprintProfileSnapshot = z.infer<typeof sprintProfileSnapshotSchema>

export const SPRINT_STATUS_VALUES = ['active', 'paused', 'completed'] as const
export type SprintStatus = (typeof SPRINT_STATUS_VALUES)[number]

export const sprintCursorSchema = z.object({
  variantIndex: z.number().int().min(0),
  page: z.number().int().min(1),
})
export type SprintCursor = z.infer<typeof sprintCursorSchema>

export const createSprintSchema = z.object({
  name: z.string().min(1).max(120),
  criteria: extractedCriteriaSchema,
  variants: z.array(queryVariantSchema).min(1).max(4),
  quota: z.number().int().min(10).max(1000).optional(),
}).strict()
export type CreateSprintInput = z.infer<typeof createSprintSchema>

export const updateSprintSchema = z.union([
  z.object({ action: z.enum(['pause', 'resume']) }).strict(),
  z.object({ name: z.string().min(1).max(120) }).strict(),
  z.object({ quota: z.number().int().min(10).max(1000) }).strict(),
])
export type UpdateSprintInput = z.infer<typeof updateSprintSchema>

export const DEFAULT_SPRINT_QUOTA = 200
export const MAX_VARIANTS_PER_CELL_PAGE = 3
export const SPRINT_PAGE_SIZE = 30

/**
 * Deterministic fallback for Step 2 (`criteria-decompose`) when AI is
 * unavailable: a single variant built directly from the reviewed skills,
 * per spec.md's "the wizard never dead-ends" guarantee.
 */
export function manualCriteriaToVariant(criteria: ExtractedCriteria): QueryVariant {
  return {
    name: 'Manual',
    keywords: criteria.skills.slice(0, 4),
    rationale: 'Deterministic fallback built directly from the reviewed skills list.',
  }
}
