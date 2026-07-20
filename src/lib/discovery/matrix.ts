/**
 * Proactive Discovery matrix (plan: proactive-discovery).
 *
 * A static, curated set of "cells" — each cell is one federated search unit
 * (keywords + a handful of sources) that the discovery worker walks through
 * on a cron cadence to warm the global semantic-search index
 * (`builder_embeddings`) before real users search those topics.
 *
 * Pure module: no I/O, no env access, so it can be unit-tested in isolation
 * and imported by both the worker and its tests.
 */
import type { SourceName } from '~/lib/sources/types'

export interface DiscoveryCell {
  /** Stable id surviving matrix edits — an unknown cursor key resets to 0. */
  key: string
  /** 1-3 keywords fed to `searchBuilders({ keywords, sources })`. */
  keywords: string[]
  /** ≤ 4 sources per cell (per-source politeness — see spec's pacing math). */
  sources: SourceName[]
}

/** Source groupings per spec §1 — rotated across topics so every group gets exercised. */
const SOURCE_GROUPS: Record<string, SourceName[]> = {
  code: ['github', 'gitlab', 'codeberg'],
  community: ['hn', 'reddit', 'lobsters'],
  content: ['devto', 'stackoverflow'],
  registries: ['npm', 'huggingface'],
}

const GROUP_KEYS = Object.keys(SOURCE_GROUPS)

/** Curated topics spanning languages, domains, and developer communities. */
const TOPICS: Array<{ slug: string; keywords: string[] }> = [
  { slug: 'rust', keywords: ['rust'] },
  { slug: 'go', keywords: ['go', 'golang'] },
  { slug: 'react', keywords: ['react'] },
  { slug: 'vue', keywords: ['vue'] },
  { slug: 'python', keywords: ['python'] },
  { slug: 'machine-learning', keywords: ['machine learning', 'ml'] },
  { slug: 'llm', keywords: ['llm', 'large language model'] },
  { slug: 'devops', keywords: ['devops'] },
  { slug: 'embedded', keywords: ['embedded systems', 'firmware'] },
  { slug: 'security', keywords: ['security', 'appsec'] },
  { slug: 'data-engineering', keywords: ['data engineering', 'etl'] },
  { slug: 'design-systems', keywords: ['design systems'] },
  { slug: 'indie-saas', keywords: ['indie hacker', 'saas'] },
  { slug: 'mobile', keywords: ['mobile development'] },
  { slug: 'ios', keywords: ['ios', 'swift'] },
  { slug: 'android', keywords: ['android', 'kotlin'] },
  { slug: 'kubernetes', keywords: ['kubernetes', 'k8s'] },
  { slug: 'databases', keywords: ['database', 'postgres'] },
  { slug: 'frontend-performance', keywords: ['frontend performance', 'web vitals'] },
  { slug: 'typescript', keywords: ['typescript'] },
  { slug: 'webassembly', keywords: ['webassembly', 'wasm'] },
  { slug: 'blockchain', keywords: ['blockchain', 'web3'] },
  { slug: 'game-development', keywords: ['game development', 'gamedev'] },
  { slug: 'cli-tools', keywords: ['cli tools', 'terminal'] },
  { slug: 'open-source-maintainers', keywords: ['open source maintainer'] },
  { slug: 'api-design', keywords: ['api design', 'rest api'] },
  { slug: 'testing', keywords: ['testing', 'test automation'] },
  { slug: 'distributed-systems', keywords: ['distributed systems'] },
  { slug: 'compilers', keywords: ['compilers', 'programming languages'] },
  { slug: 'networking', keywords: ['networking', 'protocols'] },
]

/**
 * Builds the matrix deterministically: each topic contributes two cells
 * (adjacent source groups, rotated per topic index so no topic repeats a
 * group and every group is exercised roughly evenly across the matrix).
 */
function buildMatrix(): DiscoveryCell[] {
  const cells: DiscoveryCell[] = []
  TOPICS.forEach((topic, index) => {
    const groupA = GROUP_KEYS[index % GROUP_KEYS.length]
    const groupB = GROUP_KEYS[(index + 1) % GROUP_KEYS.length]
    cells.push({ key: `${topic.slug}@${groupA}`, keywords: topic.keywords, sources: SOURCE_GROUPS[groupA] })
    cells.push({ key: `${topic.slug}@${groupB}`, keywords: topic.keywords, sources: SOURCE_GROUPS[groupB] })
  })
  return cells
}

export const DISCOVERY_MATRIX: DiscoveryCell[] = buildMatrix()

/** Returns the cell at `cursor`, wrapping modulo the matrix length. */
export function cellAt(cursor: number): DiscoveryCell {
  const length = DISCOVERY_MATRIX.length
  const index = ((cursor % length) + length) % length
  return DISCOVERY_MATRIX[index]
}
