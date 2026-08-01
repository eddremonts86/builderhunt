/**
 * Rebuilds retrieval projections for the whole catalog (`pnpm solutions:project`).
 *
 * Safe to run at any time and as often as wanted: an unchanged projection writes nothing, because the
 * projection's own content hash decides. That is what makes this a cron job rather than a migration — a
 * document-builder change is rolled out by bumping `PROJECTION_VERSION` and running this.
 *
 * Never calls an embedding provider. Changed components are left as pending rows in `builder_embeddings`
 * for the embed worker to claim, so rebuilding the catalog after a wording change costs no tokens.
 */
import { countStaleProjections, projectComponents } from '~/lib/solutions/indexing/project-components'

const limit = Number(process.argv[2] ?? 500)
if (!Number.isFinite(limit) || limit <= 0) {
  console.error('Usage: pnpm solutions:project [limit]')
  process.exit(1)
}

const result = await projectComponents({ limit })
console.log(JSON.stringify({ ...result, staleRemaining: await countStaleProjections() }))
process.exit(0)
