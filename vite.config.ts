import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig(() => ({
  plugins: [
    tanstackStart({ router: { routeToken: 'route' } }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    tsconfigPaths: true,
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: { port: process.env.PORT ? Number(process.env.PORT) : 3000 },
  build: {
    rollupOptions: {
      output: {
        // Tailwind's client build pass and the TanStack Start SSR build pass
        // can content-hash the global stylesheet DIFFERENTLY on Linux CI, so
        // the SSR-rendered <link> points at a hash the client build never
        // emitted -> 404 -> the whole site loads unstyled after a deploy.
        // Pin the stylesheet to a stable, unhashed name so both passes always
        // reference the same URL. server.prod.mjs gives unhashed assets a
        // short cache (not immutable), so updates are still picked up.
        assetFileNames: (assetInfo) => {
          const name = assetInfo.names?.[0] ?? assetInfo.name ?? ''
          if (name.endsWith('.css')) return 'assets/[name][extname]'
          return 'assets/[name]-[hash][extname]'
        },
      },
    },
  },
  // @resvg/resvg-js ships a native .node binary (used server-side only, to
  // rasterize the OG image to PNG). Vite's dep optimizer tries to parse it
  // as JS and crashes — keep it out of pre-bundling entirely.
  //
  // playwright (devpost-integration's headless-browser worker, server-only)
  // hits the exact same failure via its own optional `fsevents` native
  // binary transitively pulled in once playwright moved from devDependencies
  // to dependencies.
  optimizeDeps: {
    exclude: ['@resvg/resvg-js', 'playwright'],
  },
  ssr: {
    external: ['@resvg/resvg-js', 'playwright'],
  },
}))