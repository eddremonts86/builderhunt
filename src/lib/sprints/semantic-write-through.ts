// Optional semantic write-through for sprint results. `upsertEmbeddingStubs`
// (semantic-search) already exists unconditionally in this codebase — no
// runtime feature-detection is needed — but this thin wrapper keeps the
// worker decoupled via dependency injection (spec.md's "never dynamically
// import an absent module") and gives failures a sprint-specific log event.
import { upsertEmbeddingStubs } from '~/lib/semantic/index-writer'
import { log } from '~/shared/lib/log'
import type { ScoredBuilder } from '~/lib/search'

export async function writeThroughSprintResults(people: ScoredBuilder[]): Promise<void> {
  if (people.length === 0) return
  try {
    await upsertEmbeddingStubs(people)
  } catch (error) {
    log.error('sprint_semantic_write_through_error', {
      error: error instanceof Error ? error.message : String(error),
      count: people.length,
    })
  }
}
