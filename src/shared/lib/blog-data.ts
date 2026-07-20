import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

const blogSlugSchema = z.string().regex(/^[a-z0-9-]{1,160}$/)

export const getBlogPosts = createServerFn({ method: 'GET' }).handler(async () => {
  const { getAllPosts } = await import('./blog')
  return getAllPosts()
})

export const getBlogPostPage = createServerFn({ method: 'GET' })
  .validator(blogSlugSchema)
  .handler(async ({ data: slug }) => {
    const { getPostBySlug, getRelatedPosts } = await import('./blog')
    const post = await getPostBySlug(slug)
    if (!post) return null

    return {
      post,
      related: await getRelatedPosts(slug, 3),
    }
  })
