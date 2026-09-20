import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { THEME_IDS } from '../../src/shared/themes.ts'

describe('theme previews', () => {
  // Phase 1 captures only `classic`; `tiles` and `cards` get their previews in
  // phases 2 and 3, so this cannot hold yet.
  //
  // `it.fails` rather than `it.skip`, for the same reason as the two markers in
  // theme-registry.test.ts: when the last theme is captured this starts
  // passing, and an unexpected pass is itself a failure — which forces whoever
  // finishes Phase 3 to remove the marker. A skip would stay green forever and
  // silently retire the assertion.
  it.fails('every theme has a preview image', () => {
    for (const id of THEME_IDS) {
      // Resolved against this file rather than the working directory: the
      // assertion is about the repository, not about where vitest was invoked.
      const path = fileURLToPath(new URL(`../../src/web/theme-previews/${id}.png`, import.meta.url))
      expect(existsSync(path), `missing ${path} — run: pnpm previews:update`).toBe(true)
    }
  })
})
