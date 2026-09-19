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
  // Dev only. In production the Node server serves the built SPA itself, so
  // there is no proxy — the SPA and the API share an origin. Under `vite dev`
  // they do not, so /api has to be forwarded to the portal process.
  //
  // `/api/stream` is Server-Sent Events: Vite's proxy must not buffer it, or
  // the guest UI never receives a state update. Disabling compression on the
  // proxied response is what keeps the stream flowing.
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.PORT ?? 9123}`,
        changeOrigin: false,
        compress: false,
      },
    },
  },
}))
