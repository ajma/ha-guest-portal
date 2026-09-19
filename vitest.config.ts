import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const sharedAlias = {
  '@shared': resolve(import.meta.dirname, './src/shared'),
}

export default defineConfig({
  test: {
    exclude: ['test/e2e/**/*'],
    projects: [
      {
        test: {
          name: 'node',
          include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
          environment: 'node',
        },
        resolve: {
          alias: sharedAlias,
        },
      },
      {
        test: {
          name: 'happy-dom',
          include: ['test/unit/**/*.test.tsx'],
          environment: 'happy-dom',
        },
        resolve: {
          alias: sharedAlias,
        },
      },
    ],
  },
  resolve: {
    alias: sharedAlias,
  },
})
