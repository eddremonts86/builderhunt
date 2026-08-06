import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { getBlogPosts } from '~/shared/lib/blog-data'
import {
  CONTENT_TABS,
  ContentStudioPage,
  type ContentTab,
} from '~/modules/admin/content/ContentStudioPage'

function parseTab(value: unknown): ContentTab {
  return CONTENT_TABS.includes(value as ContentTab) ? (value as ContentTab) : 'blog'
}

export const Route = createFileRoute('/_dashboard/admin/content')({
  // The open tab lives in the URL so /admin/content?tab=roadmap is linkable and
  // survives a reload — the same reason the other admin consoles keep their
  // filters in search params rather than in component state.
  validateSearch: (search: Record<string, unknown>): { tab: ContentTab } => ({
    tab: parseTab(search.tab),
  }),
  beforeLoad: async () => {
    await requirePlatformAdminPage()
  },
  // Changelog and roadmap load from their own admin APIs inside their
  // components; posts come from the filesystem, which only the server can read.
  loader: async () => ({ posts: await getBlogPosts() }),
  component: AdminContentPage,
})

function AdminContentPage() {
  const { posts } = Route.useLoaderData()
  const { tab } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  return (
    <ContentStudioPage
      posts={posts}
      tab={tab}
      onTabChange={(next) => navigate({ search: { tab: next } })}
    />
  )
}
