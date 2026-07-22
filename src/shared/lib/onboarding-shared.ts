/**
 * Client-safe onboarding constants — split out from `onboarding.ts` because
 * that file also pulls in drizzle-orm/db schema for its server-only
 * functions, and importing anything from it (even a plain constant) drags
 * that whole server module graph into the client bundle, which fails at
 * runtime ("crypto has been externalized for browser compatibility").
 */
export const STARTER_QUERIES = [
  'rust async runtime',
  'indie hackers in EU',
  'AI agents in production',
  'react performance',
  'python ML engineers',
] as const

export const TOTAL_STEPS = 3
