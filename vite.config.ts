import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, './src/shared'),
    },
  },
  build: {
    outDir: 'dist/web',
  },
  server: {
    proxy: {
      '/api': `http://localhost:${process.env.PORT ?? '9123'}`,
    },
  },
}))
