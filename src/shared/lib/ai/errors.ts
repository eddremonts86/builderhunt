// Typed errors shared across the AI platform's server-side modules
// (minimax.ts, embeddings.ts, budget.ts, and the /api/ai/* routes).

/** The requested task/feature is disabled — kill switch, missing provider config, etc. */
export class AIDisabledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AIDisabledError'
  }
}

/** The provider's response could not be parsed into the task's output schema after one retry. */
export class AIParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AIParseError'
  }
}

/** The provider returned a non-2xx HTTP response. The provider's message is included; the API key never is. */
export class AIProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AIProviderError'
  }
}

/** The embedding adapter is not configured (missing AI_EMBEDDING_URL/MODEL). */
export class AIEmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AIEmbeddingUnavailableError'
  }
}

/** A returned embedding vector's length did not match the configured AI_EMBEDDING_DIM. */
export class AIDimensionMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AIDimensionMismatchError'
  }
}
