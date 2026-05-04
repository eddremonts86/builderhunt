import type {} from '@tanstack/react-start'
import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export const getRouter = () =>
  createTanStackRouter({ routeTree, context: {}, scrollRestoration: true, defaultPreloadStaleTime: 0 })

export const createRouter = getRouter