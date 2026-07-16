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
  HUGGINGFACE_TOKEN: z.string().optional(),
  GITLAB_TOKEN: z.string().optional(),
  CODEBERG_API_URL: z.string().optional(),
  CODEBERG_TOKEN: z.string().optional(),
  HASHNODE_API_KEY: z.string().optional(),
  SOURCEHUT_TOKEN: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
}).refine(
  (data) => !!data.BETTER_AUTH_SECRET,
  { message: 'BETTER_AUTH_SECRET is required — generate with: openssl rand -hex 32' },
)

// In the browser, the server-only env vars aren't available. Provide safe
// defaults so importing this module on the client doesn't crash. The actual
// server runtime always has these set (see .env).
const isBrowser = typeof window !== 'undefined'

const safeProcessEnv = isBrowser
  ? {
      // Non-empty placeholders so zod's .min(1) check passes. The real values
      // are never read on the client; server functions go over the wire.
      DATABASE_URL: 'postgres://placeholder:placeholder@localhost:5432/placeholder',
      APP_URL: window.location.origin,
      VITE_APP_URL: window.location.origin,
      BETTER_AUTH_SECRET: 'browser-stub-not-used',
    }
  : process.env

export const env = zodEnv.parse(safeProcessEnv)