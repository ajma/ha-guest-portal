import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  // The screenshot baseline IS the preview image the admin picker imports, so
  // it is written into the source tree rather than a __snapshots__ sibling.
  // No {projectName} or {platform} segment: there is exactly one preview per
  // theme and the picker imports it by a fixed path.
  snapshotPathTemplate: '{testDir}/../../src/web/theme-previews/{arg}{ext}',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // The theme previews are pixel-compared at a deliberately tight
          // tolerance, because what they guard — a tile's state colour — is a
          // small, low-saturation tint rather than a solid fill. Subpixel
          // antialiasing and font hinting varied between runs by more than that
          // tolerance allowed, so the comparison flaked about one run in five.
          // Making text rendering deterministic removes the noise, rather than
          // widening the tolerance past the signal it exists to catch:
          // measured, 0.003 lets a green-to-purple repaint through undetected.
          args: ['--font-render-hinting=none', '--disable-lcd-text'],
        },
      },
    },
  ],
})
