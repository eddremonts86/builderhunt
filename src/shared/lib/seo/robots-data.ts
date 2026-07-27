/**
 * Server functions for reading a surface's robots directives from a route
 * loader, so the `<meta name="robots">` tag is in the SERVER-RENDERED head.
 *
 * That placement is the whole point: a crawler reads the initial HTML response.
 * A directive added by client-side JavaScript after hydration is not reliably
 * honoured, so a `noindex` that only exists post-hydration is not a `noindex`.
 *
 * Same lazy-import shape as `blog-data.ts` — the repository pulls in `publicDb`,
 * which opens a real `postgres()` client at module scope, and that must not be
 * reachable from a client bundle.
 */
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { DEFAULT_DIRECTIVES, SEO_SURFACES, type RobotsDirectives } from './surfaces'

const surfaceSchema = z.enum(SEO_SURFACES)

/** One surface's directives. Falls back to the fail-closed defaults on any error. */
export const getSurfaceRobotsFn = createServerFn({ method: 'GET' })
  .validator(surfaceSchema)
  .handler(async ({ data: surface }): Promise<RobotsDirectives> => {
    try {
      const { getSurfaceRobots } = await import('../repositories/public-surface-indexing')
      return await getSurfaceRobots(surface)
    } catch (error) {
      console.error(`robots lookup failed for "${surface}" — applying noindex defaults:`, error)
      return { ...DEFAULT_DIRECTIVES }
    }
  })
