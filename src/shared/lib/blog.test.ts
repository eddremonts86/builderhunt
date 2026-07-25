import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'

/**
 * These previously asserted almost nothing — `expect(post === null || typeof
 * post === 'object')` is true for every possible value, and two more tests
 * had `else { expect(true).toBe(true) }` escape hatches. The fixture was also
 * named `_test-vitest.md`, which the loader now (correctly) skips as
 * authoring scaffolding, so those escape hatches would have fired on every
 * run. Fixtures are named to be loaded, and the assertions are real.
 */
describe('blog loader', () => {
  const postsDir = join(process.cwd(), 'content', 'posts')
  const postFixture = join(postsDir, 'zz-vitest-fixture.md')
  const templateFixture = join(postsDir, '_zz-vitest-template.md')

  beforeAll(() => {
    mkdirSync(postsDir, { recursive: true })
    writeFileSync(
      postFixture,
      `---
title: Test Post
description: A test post for unit tests
slug: zz-vitest-fixture
date: 2026-07-01
tags: [test, vitest]
author: edd
---
This is a test post with some content.

## Subheading

More content here.
`,
    )
    // Same shape, underscore-prefixed: must never be published.
    writeFileSync(
      templateFixture,
      `---
title: Template
description: Authoring scaffold that must not be published
slug: zz-vitest-template
date: 2026-07-02
tags: [test]
author: edd
---
Scaffold body.
`,
    )
  })

  afterAll(() => {
    rmSync(postFixture, { force: true })
    rmSync(templateFixture, { force: true })
  })

  it('loads a post by slug with its parsed frontmatter', async () => {
    const { getPostBySlug } = await import('./blog')
    const post = await getPostBySlug('zz-vitest-fixture')
    expect(post).not.toBeNull()
    expect(post?.title).toBe('Test Post')
    expect(post?.tags).toContain('vitest')
    expect(post?.author).toBe('edd')
  })

  it('lists the post among all posts', async () => {
    const { getAllPosts } = await import('./blog')
    const posts = await getAllPosts()
    expect(posts.length).toBeGreaterThan(0)
    const fixture = posts.find((p) => p.slug === 'zz-vitest-fixture')
    expect(fixture).toBeDefined()
    expect(fixture).toHaveProperty('date')
  })

  it('never publishes an underscore-prefixed authoring scaffold', async () => {
    const { getAllPosts, getPostBySlug } = await import('./blog')
    const posts = await getAllPosts()
    // The real `content/posts/_TEMPLATE.md` must be invisible for the same reason.
    expect(posts.some((p) => p.slug === 'zz-vitest-template')).toBe(false)
    expect(posts.some((p) => p.slug.toUpperCase().includes('TEMPLATE'))).toBe(false)
    expect(await getPostBySlug('zz-vitest-template')).toBeNull()
  })

  it('returns null for a non-existent slug', async () => {
    const { getPostBySlug } = await import('./blog')
    expect(await getPostBySlug('non-existent-slug-99999')).toBeNull()
  })

  it('computes a sane reading time from word count', async () => {
    const { getPostBySlug } = await import('./blog')
    const post = await getPostBySlug('zz-vitest-fixture')
    expect(post?.readingTime).toBeGreaterThanOrEqual(1)
    expect(post?.readingTime).toBeLessThanOrEqual(10)
  })
})
