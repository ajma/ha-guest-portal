import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { registerServiceWorker } from './registerServiceWorker.js'
import './index.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element not found')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// After the render, never before: the worker exists to make a *later* visit
// explain itself, and nothing about this first paint should wait on it.
//
// Production only. Under `vite dev` a registered worker serves a stale shell
// over the dev server, which is an hour of confusion for no benefit.
if (import.meta.env.PROD) {
  registerServiceWorker()
}
