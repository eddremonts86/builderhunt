// Server-only blog helpers: load markdown posts from content/posts/.
// Lazy-imports fs/path/fs/promises so the client bundle doesn't pull Node modules.

import matter from 'gray-matter'

export interface BlogPost {
  slug: string
  title: string
  description: string
  date: string
  tags: string[]
  author: string
  content: string
  html: string
  readingTime: number
}

export interface BlogPostSummary {
  slug: string
  title: string
  description: string
  date: string
  tags: string[]
  author: string
  readingTime: number
}

async function loadPosts(): Promise<BlogPost[]> {
  // Lazy imports to keep client bundle clean
  const { readdir, readFile } = await import('fs/promises')
  const { join } = await import('path')
  const { marked } = await import('marked')

  const postsDir = join(process.cwd(), 'content', 'posts')
  let files: string[]
  try {
    files = await readdir(postsDir)
  } catch {
    return []
  }
  const mdFiles = files.filter((f) => f.endsWith('.md'))

  const posts = await Promise.all(
    mdFiles.map(async (file) => {
      const raw = await readFile(join(postsDir, file), 'utf-8')
      const { data, content } = matter(raw)
      const slug = (data.slug as string) ?? file.replace(/\.md$/, '')
      const title = (data.title as string) ?? slug
      const description = (data.description as string) ?? ''
      // gray-matter parses YAML dates to Date objects; normalize to ISO date
      let dateStr: string
      if (data.date instanceof Date) {
        dateStr = data.date.toISOString().slice(0, 10)
      } else if (typeof data.date === 'string') {
        dateStr = data.date.slice(0, 10)
      } else {
        dateStr = new Date().toISOString().slice(0, 10)
      }
      const tags = (data.tags as string[]) ?? []
      const author = (data.author as string) ?? 'edd'
      const html = await marked.parse(content)
      const words = content.trim().split(/\s+/).length
      const readingTime = Math.max(1, Math.round(words / 200))
      return {
        slug,
        title,
        description,
        date: dateStr,
        tags,
        author,
        content,
        html,
        readingTime,
      }
    }),
  )

  // Newest first
  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return posts
}

let cache: { posts: BlogPost[]; ts: number } | null = null
const TTL = 5 * 60 * 1000

export async function getAllPosts(): Promise<BlogPostSummary[]> {
  const now = Date.now()
  if (!cache || now - cache.ts > TTL) {
    const posts = await loadPosts()
    cache = { posts, ts: now }
  }
  return cache.posts.map((p) => ({
    slug: p.slug,
    title: p.title,
    description: p.description,
    date: p.date,
    tags: p.tags,
    author: p.author,
    readingTime: p.readingTime,
  }))
}

export async function getPostBySlug(slug: string): Promise<BlogPost | null> {
  const now = Date.now()
  if (!cache || now - cache.ts > TTL) {
    const posts = await loadPosts()
    cache = { posts, ts: now }
  }
  return cache.posts.find((p) => p.slug === slug) ?? null
}

export async function getRelatedPosts(
  slug: string,
  limit = 3,
): Promise<BlogPostSummary[]> {
  const all = await getAllPosts()
  const target = all.find((p) => p.slug === slug)
  if (!target) return []
  const others = all.filter((p) => p.slug !== slug)
  const scored = others.map((p) => {
    const overlap = p.tags.filter((t) => target.tags.includes(t)).length
    return { post: p, score: overlap }
  })
  scored.sort((a, b) => b.score - a.score || (a.post.date < b.post.date ? 1 : -1))
  return scored.slice(0, limit).map((s) => s.post)
}
