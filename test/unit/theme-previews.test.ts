import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { THEME_IDS } from '../../src/shared/themes.ts'

describe('theme previews', () => {
  // All three themes are captured, so this holds on its own merits now. It was
  // marked expected-fail through phases 1 and 2: an unexpected pass is itself
  // a failure, which is what forced the marker to be removed here rather than
  // left to stay green forever and silently retire the assertion.
  it('every theme has a preview image', () => {
    for (const id of THEME_IDS) {
      // Resolved against this file rather than the working directory: the
      // assertion is about the repository, not about where vitest was invoked.
      const path = fileURLToPath(new URL(`../../src/web/theme-previews/${id}.png`, import.meta.url))
      expect(existsSync(path), `missing ${path} — run: pnpm previews:update`).toBe(true)
    }
  })
})
