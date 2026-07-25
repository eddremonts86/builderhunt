/**
 * Curated hackathon-relevant search terms the worker rotates through, one
 * per run (advancing to the next page of the same keyword until results run
 * dry, then moving on) — same rotating-cursor idea as
 * src/lib/discovery/matrix.ts, scoped down to a plain string list since
 * Devpost search takes a single query string, not source groupings.
 */
export const DEVPOST_KEYWORDS: string[] = [
  'ai agent',
  'developer tools',
  'open source',
  'machine learning',
  'web3',
  'climate tech',
  'health tech',
  'fintech',
  'accessibility',
  'ar vr',
  'robotics',
  'developer productivity',
]
