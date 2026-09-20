import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
  packageManager?: string
  engines?: { node?: string }
}
const dockerignore = readFileSync('.dockerignore', 'utf-8')
const dockerfile = readFileSync('Dockerfile', 'utf-8')
const workspace = readFileSync('pnpm-workspace.yaml', 'utf-8')

const majorOf = (spec: string) => Number.parseInt(spec.replace(/^pnpm@/, ''), 10)

// .dockerignore is line-oriented, so a commented-out entry excludes nothing and
// a substring match would not notice the difference.
const ignoreLines = dockerignore.split('\n').map((line) => line.trim())
const workspaceEntryIndex = ignoreLines.indexOf('pnpm-workspace.yaml')
const imageExcludesWorkspaceFile = workspaceEntryIndex !== -1

// The contiguous run of comment lines immediately above that entry — the only
// place a reader looks for the reason.
const reasonAboveEntry = (() => {
  if (!imageExcludesWorkspaceFile) return ''
  const comment: string[] = []
  for (let i = workspaceEntryIndex - 1; i >= 0; i--) {
    const line = ignoreLines[i]
    if (!line?.startsWith('#')) break
    comment.unshift(line)
  }
  return comment.join('\n')
})()

describe('package manifest', () => {
  it('pins a package manager', () => {
    // Without this, corepack has nothing to activate and CI can silently
    // resolve a different pnpm than development does.
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/)
  })

  it('pins a pnpm new enough for the workspace file', () => {
    // pnpm-workspace.yaml uses `allowBuilds` and `minimumReleaseAgeExclude`,
    // both pnpm 10+, and has no `packages:` key, which pnpm 9 requires. Pinning
    // 9.x makes every pnpm command in this repo fail with "packages field
    // missing or empty" — verified, not assumed.
    expect(majorOf(pkg.packageManager ?? '')).toBeGreaterThanOrEqual(10)
    expect(workspace).toMatch(/^allowBuilds:/m)
    expect(workspace).toMatch(/^minimumReleaseAgeExclude:/m)
    expect(workspace).not.toMatch(/^packages:/m)
  })

  it('still requires Node 24, which node:sqlite depends on', () => {
    expect(pkg.engines?.node).toBe('>=24')
  })

  it('keeps the workspace file out of the image, and says why accurately', () => {
    // The image deliberately installs without the workspace policy. If someone
    // un-ignores this file, the release-age policy starts applying inside the
    // build and a publish can fail because a dependency is too new. That is a
    // decision, not an oversight, so the comment has to state the real reason —
    // and the real reason is not the one it used to give, which mentioned only
    // allowBuilds and predates the tsx release-age exclusion.
    expect(imageExcludesWorkspaceFile).toBe(true)
    expect(reasonAboveEntry).toContain('minimumReleaseAgeExclude')
    expect(reasonAboveEntry).not.toContain('only used for allowBuilds in development')
  })

  it('declares an image pnpm and a workspace exclusion that agree', () => {
    // Both halves verified by building: with pnpm 9 and the file present the
    // build dies "packages field missing or empty" (pnpm 9 wants `packages:`);
    // with pnpm 10+ and the file absent `pnpm install` dies "the lockfile
    // contains entries that the active policies reject", because the default
    // release-age policy applies without this repo's exclusions. So the image's
    // pnpm and the exclusion are one decision, not two.
    //
    // This checks what the Dockerfile *declares*. It cannot yet check what the
    // image *runs*: corepack reads `packageManager` out of the copied
    // package.json and overrides `corepack prepare --activate`, so the image
    // currently downloads pnpm 11 despite the line below, and `docker build`
    // fails on exactly the release-age rejection described above. Neutralising
    // that needs COREPACK_ENABLE_PROJECT_SPEC=0 in the Dockerfile, which is out
    // of this task's scope; the effective-version assertion belongs with it.
    const pins = [...dockerfile.matchAll(/corepack prepare pnpm@(\d+\.\d+\.\d+)/g)].map(
      (match) => match[1] ?? '',
    )
    expect(pins.length).toBeGreaterThan(0)
    // The builder and runtime stages install from the same lockfile; a stage
    // that disagrees resolves dependencies differently than the one that built.
    expect(new Set(pins).size).toBe(1)

    const imagePin = pins[0] ?? ''
    const imageMajor = majorOf(imagePin)
    expect(
      imageExcludesWorkspaceFile,
      `the image declares pnpm ${imagePin}, so the workspace file must ${
        imageMajor < 10 ? 'stay out of' : 'reach'
      } the build`,
    ).toBe(imageMajor < 10)

    if (imageMajor >= 10) {
      // .dockerignore alone is not enough: install runs before `COPY . .`, so
      // the file has to be copied explicitly or the policy applies unexcluded.
      expect(dockerfile).toMatch(/^COPY[^\n]*pnpm-workspace\.yaml/m)
    }
  })
})
