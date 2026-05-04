import { z } from 'zod'

const zodEnv = z.object({
  DATABASE_URL: z.string(),
  AUTH_SECRET: z.string().default('dev-secret-change-in-production'),
  APP_URL: z.string().default('http://localhost:3000'),
  VITE_APP_URL: z.string().default('http://localhost:3000'),
  GITHUB_TOKEN: z.string().optional(),
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  HACKERNEWS_API_URL: z.string().default('https://hacker-news.firebaseio.com/v0'),
  DEVTO_API_URL: z.string().default('https://dev.to/api'),
})

export const env = zodEnv.parse(process.env)