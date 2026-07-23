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
  // @resvg/resvg-js ships a native .node binary (used server-side only, to
  // rasterize the OG image to PNG). Vite's dep optimizer tries to parse it
  // as JS and crashes — keep it out of pre-bundling entirely.
  optimizeDeps: {
    exclude: ['@resvg/resvg-js'],
  },
  ssr: {
    external: ['@resvg/resvg-js'],
  },
}))