// Single source of truth for the embedding vector dimension. Every place that
// needs the dimension (the builder_embeddings schema, the generated pgvector
// migration's literal `vector(N)`, and any future embedding consumer) reads
// it from here — never hardcode 1536 (or any other value) a second time.
import { env } from '~/shared/lib/env'

export const EMBEDDING_DIM = env.AI_EMBEDDING_DIM
