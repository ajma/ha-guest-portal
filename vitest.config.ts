import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/unit/**/*.test.tsx', 'test/integration/**/*.test.ts'],
    exclude: ['test/e2e/**/*'],
    environment: 'node',
    environmentMatchGlobs: [['test/unit/**/*.tsx', 'happy-dom']],
  },
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, './src/shared'),
    },
  },
})
