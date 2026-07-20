import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('public Explore experience', () => {
  it('shows useful discovery content before the first search', async () => {
    const source = await readFile('src/routes/_landing/explore/index.tsx', 'utf8')

    expect(source).toContain('data-testid="explore-intents"')
    expect(source).toContain('data-testid="explore-featured"')
    expect(source).toContain('data-testid="explore-sources"')
  })

  it('loads featured builders independently from search results', async () => {
    const source = await readFile('src/routes/_landing/explore/index.tsx', 'utf8')

    expect(source).toContain('featured: featuredBuilders')
    expect(source).toContain('results: searchResults')
  })

  it('keeps People and Resources as URL-backed result views', async () => {
    const source = await readFile('src/routes/_landing/explore/index.tsx', 'utf8')

    expect(source).toContain("type: z.enum(['people', 'resources'])")
    expect(source).toContain('data-testid="explore-tab-people"')
    expect(source).toContain('data-testid="explore-tab-resources"')
    expect(source).toContain('<ResourceResultCard')
  })

  it('preserves the search result kind in the public DTO', async () => {
    const source = await readFile('src/shared/lib/public-data.ts', 'utf8')

    expect(source).toContain("kind: 'person' | 'repo'")
    expect(source).toContain('kind: builder.kind')
  })
})
