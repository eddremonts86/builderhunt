import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { config } from 'dotenv'

// Load .env so env-validating modules don't crash on import
config({ path: '.env' })

// Provide test defaults for required env vars (real values, but isolated)
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test'
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test'
process.env.APP_URL = process.env.APP_URL ?? 'http://localhost:3000'
process.env.VITE_APP_URL = process.env.VITE_APP_URL ?? 'http://localhost:3000'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? 'test-secret-must-be-at-least-32-chars-long'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'test/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist', '.vinxi', '.output'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      include: ['src/lib/**/*.{ts,tsx}', 'src/shared/**/*.{ts,tsx}'],
    },
  },
  resolve: {
    alias: {
      '~': resolve(__dirname, './src'),
    },
  },
})
