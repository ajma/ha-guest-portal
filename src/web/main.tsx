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
// Production builds only. Under `vite dev` a registered worker serves a stale
// shell over the dev server, which is an hour of confusion for no benefit.
//
// MODE, not PROD. `import.meta.env.PROD` is derived from NODE_ENV, so a build
// run with NODE_ENV set to anything else — `NODE_ENV=test pnpm build`, which is
// what the unit suite's spawned build used to do — evaluates it false and
// dead-code-eliminates this call. The worker then silently never registers, in
// a bundle that looks fine. MODE is the Vite mode, which `vite build` sets to
// production regardless of the ambient environment.
if (import.meta.env.MODE === 'production') {
  registerServiceWorker()
}
