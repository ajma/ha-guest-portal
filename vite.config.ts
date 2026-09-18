import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, './src/shared'),
    },
  },
  build: {
    outDir: 'dist/web',
  },
})
