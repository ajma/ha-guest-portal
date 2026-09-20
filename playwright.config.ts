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
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
