import { z } from 'zod'

const zodEnv = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // BETTER_AUTH_SECRET is the canonical name
  BETTER_AUTH_SECRET: z.string().optional(),
  APP_URL: z.string().min(1, 'APP_URL is required'),
  VITE_APP_URL: z.string().min(1, 'VITE_APP_URL is required'),
  GITHUB_TOKEN: z.string().optional(),
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  HACKERNEWS_API_URL: z.string().default('https://hn.algolia.com/api/v1'),
  DEVTO_API_URL: z.string().default('https://dev.to/api'),
  STACKOVERFLOW_API_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
}).refine(
  (data) => !!data.BETTER_AUTH_SECRET,
  { message: 'BETTER_AUTH_SECRET is required — generate with: openssl rand -hex 32' },
)

export const env = zodEnv.parse(process.env)