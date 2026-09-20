# GitHub Actions CI and Container Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every push runs the checks that currently run only on one laptop, and a tagged release publishes prebuilt `amd64` and `aarch64` images to ghcr.io.

**Architecture:** Two workflows with different triggers and permissions. `ci.yml` runs the whole suite inside the Playwright container, which fixes the fonts the theme-preview pixel comparisons depend on. `publish.yml` builds the existing Dockerfile on native runners per architecture and pushes per-arch tags the Supervisor can pull. The `config.yaml` `image:` key lands last, only after a real pull has been proven.

**Tech Stack:** GitHub Actions, Docker, ghcr.io, pnpm, Node 24, Playwright 1.63.0, Biome, vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-github-actions-ci-design.md`

## Global Constraints

- **Nothing has ever been pushed to `github.com/ajma/ha-guest-portal`.** `git ls-remote --heads origin` returns nothing and there are 201 unpushed commits. **Do not push, do not create a tag, do not create a remote branch.** Every task here is local. Pushing publishes the whole history to a public repository and is the owner's decision.
- Local verification only. You cannot run GitHub Actions from here; where a task says "verify", it means verifying the thing the workflow will run, by running it yourself.
- `pnpm lint` must stay at **zero errors and zero warnings**. `pnpm typecheck` clean. `pnpm format` must leave the tree unchanged.
- Baseline: **904 unit tests / 56 files, 10 e2e**, tree clean.
- Biome lints the repo; check whether it covers `.yml` before assuming a workflow file is unchecked.
- Plain author commits only. **Never** add a `Co-Authored-By` trailer, a "Generated with Claude" footer, a 🤖 line, or any AI-attribution anywhere.
- Do not run `pnpm dev`, `pnpm dev:real`, or `sudo`. A dev stack is live on ports 9123/5173.
- **Do not `docker run` anything, and do not pull the Playwright image** (~2 GB, on someone else's disk). A previous agent's stray container cost an hour and left 7,637 root-owned files. `docker build` IS allowed — it starts no persistent container and leaves nothing behind once the tag is removed. Docker is available here without sudo, and **three unrelated containers belonging to the owner are running** (`lantern-db-1`, `syncthing`, `bookorbit-dev-db`): do not stop, restart or prune anything.
- `test/e2e/screenshots/*.png` are rewritten by every e2e run — restore them (`git checkout --`) or commit them separately.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `.github/workflows/ci.yml` | Lint, typecheck, unit, build, e2e on every push and PR. |
| `.github/workflows/publish.yml` | Multi-arch build and push to ghcr.io on a `v*` tag. |

**Modified**

| File | Change |
|---|---|
| `package.json` | Add `packageManager` so Node, CI and Docker agree on one pnpm. |
| `src/web/theme-previews/{classic,tiles,cards}.png` | Regenerated inside the Playwright container (Task 3). |
| `README.md` | The two manual steps CI cannot do: making the ghcr package public, and the release sequence. |
| `config.yaml` | The `image:` key — **last task, and only after a real pull succeeds.** |

---

## Task 1: Pin the package manager

**Files:**
- Modify: `package.json`, `.dockerignore`
- Test: `test/unit/package-manifest.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: a `packageManager` field CI keys off.

**Read this before writing anything. The obvious version to pin is wrong, and I verified it the hard way.**

`package.json` has no `packageManager`, this machine runs pnpm 11.26.0, and the Dockerfile pins `pnpm@9.15.4` in both stages. The tempting move is to make them equal. Pinning 9.15.4 **breaks the working tree immediately**: pnpm self-switches to it, then dies with `ERROR packages field missing or empty`.

The reason is a chain worth having in front of you:

- `pnpm-workspace.yaml` carries `allowBuilds` and `minimumReleaseAgeExclude`. Both are pnpm 10+ keys, and the file has no `packages:` key, which pnpm 9 requires. So **the repo genuinely needs pnpm ≥ 10.**
- `.dockerignore:8` excludes `pnpm-workspace.yaml`, with the comment *"only used for allowBuilds in development"*. **That comment is now stale** — the file also carries the `minimumReleaseAgeExclude` for `tsx@4.23.14`, added when tsx became a dependency.
- So the image installs with no workspace file at all. Under pnpm 9 that is harmless. Under pnpm 11 it is not: the default release-age policy applies *without* the repo's exclusions, and the build fails with `The lockfile contains entries that the active policies reject`.

I confirmed each step: pinning 9.15.4 locally errors; raising the Dockerfile to 11 fails at `pnpm install`; adding `pnpm-workspace.yaml` to the `COPY` fails with `not found` because of `.dockerignore`; and the Dockerfile exactly as it stands today builds clean.

**So the two are pinned differently, deliberately, and that is written down rather than left to be rediscovered.** Development and CI get 11.26.0 because the workspace file requires it. The image stays on 9.15.4 because it installs from the lockfile alone and raising it would mean shipping a time-based install policy into a release build — a policy that can fail a publish because a dependency was published too recently, which is a bad property for a release pipeline and a separate decision from this one.

- [ ] **Step 1: Write the failing test**

Create `test/unit/package-manifest.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
  packageManager?: string
  engines?: { node?: string }
}
const dockerignore = readFileSync('.dockerignore', 'utf-8')
const workspace = readFileSync('pnpm-workspace.yaml', 'utf-8')

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
    const major = Number.parseInt(pkg.packageManager?.replace('pnpm@', '') ?? '0', 10)
    expect(major).toBeGreaterThanOrEqual(10)
    expect(workspace).toMatch(/allowBuilds|minimumReleaseAgeExclude/)
  })

  it('still requires Node 24, which node:sqlite depends on', () => {
    expect(pkg.engines?.node).toBe('>=24')
  })

  it('keeps the workspace file out of the image, and says why accurately', () => {
    // The image deliberately installs without the workspace policy. If someone
    // un-ignores this file, the release-age policy starts applying inside the
    // build and a publish can fail because a dependency is too new. That is a
    // decision, not an oversight, so the comment has to state the real reason.
    expect(dockerignore).toContain('pnpm-workspace.yaml')
    expect(dockerignore).not.toContain('only used for allowBuilds in development')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/package-manifest.test.ts`
Expected: FAIL — `packageManager` is undefined, and the `.dockerignore` comment still reads the old way.

- [ ] **Step 3: Add the pin**

In `package.json`, immediately before `"engines"`:

```json
  "packageManager": "pnpm@11.26.0",
```

**Do not change the Dockerfile.** Verify the pin did not disturb anything: `pnpm --version` should still report `11.26.0` and print no corepack download, and `pnpm install --frozen-lockfile` should leave `pnpm-lock.yaml` untouched (`git diff --stat pnpm-lock.yaml` empty).

- [ ] **Step 4: Correct the stale `.dockerignore` comment**

Replace the comment above `pnpm-workspace.yaml` in `.dockerignore` with the real reason:

```
# Kept out of the image on purpose. It carries allowBuilds and
# minimumReleaseAgeExclude, and the image installs from the lockfile alone with
# pnpm 9 — which predates both keys. Un-ignoring it means raising the image's
# pnpm to 11 as well, and accepting that the release-age policy can then fail a
# publish because a dependency was published too recently.
pnpm-workspace.yaml
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run test/unit/package-manifest.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Confirm the image still builds**

Docker is available here without sudo. A build starts no persistent container:

```bash
docker build -t hagp-task1-check . && docker image rm hagp-task1-check
```

Expected: success. **Do not `docker run` it**, and do not stop, prune or otherwise touch the owner's unrelated running containers (`lantern-db-1`, `syncthing`, `bookorbit-dev-db`).

- [ ] **Step 7: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
pnpm format
git add package.json .dockerignore test/unit/package-manifest.test.ts
git commit -m "build: pin pnpm for development and CI, and say why the image differs"
```

---

## Task 2: `ci.yml`

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `packageManager` (Task 1).
- Produces: the workflow Task 3's baselines must match.

**You cannot run this.** Do not attempt to. What you *can* do is verify every command it invokes, in the order it invokes them, on this machine — and that is required before committing.

- [ ] **Step 1: Verify the command sequence locally**

Run each, in order, and record the result:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm vitest run
pnpm build
pnpm test:e2e
```

All must pass. Restore `test/e2e/screenshots/` afterwards. If any fails, stop and report — the workflow cannot be more correct than the commands it runs.

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
  pull_request:

# Superseded runs are wasted minutes and a confusing queue.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-24.04

    # The whole job runs in the Playwright image, matched to the installed
    # @playwright/test. Browsers and their system libraries are already there,
    # and — the reason that matters here — so are a fixed set of fonts. Three
    # e2e tests are pixel comparisons of the theme previews, tight enough to
    # catch a tile's state colour changing, which is a low-saturation tint. A
    # baseline generated on one font stack and compared against another is a
    # coin toss.
    container:
      image: mcr.microsoft.com/playwright:v1.63.0-noble

    steps:
      - uses: actions/checkout@v4

      # The image's bundled Node is not necessarily 24, and the e2e harness
      # spawns the built server, which imports node:sqlite. Pin it rather than
      # inherit it.
      - uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Enable corepack
        run: corepack enable

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Lint
        # Zero warnings, not just zero errors. The repo has held that line and
        # a warning here is how it stops being held.
        run: pnpm lint

      - name: Typecheck
        run: pnpm typecheck

      - name: Unit tests
        run: pnpm vitest run

      - name: Build
        run: pnpm build

      - name: End-to-end tests
        run: pnpm test:e2e

      - name: Upload Playwright report on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: |
            playwright-report/
            test-results/
          retention-days: 7
```

The failure artifact matters more than it looks: a screenshot comparison that fails in CI is unreadable without the diff image, and without it the temptation is to loosen the tolerance rather than look.

- [ ] **Step 3: Check the linter covers it**

Run: `pnpm lint && pnpm format`
If Biome does not check `.yml` in this repo, say so in your report — it means nothing machine-checks these files and they need reading carefully.

Validate the YAML parses:

```bash
node -e "
const { readFileSync } = require('node:fs')
const text = readFileSync('.github/workflows/ci.yml', 'utf-8')
if (!text.includes('mcr.microsoft.com/playwright:v1.63.0-noble')) throw new Error('container tag missing')
if (text.includes('continue-on-error')) throw new Error('a soft failure defeats the point')
console.log('ci.yml sanity checks passed')
"
```

- [ ] **Step 4: Confirm the container tag matches the installed Playwright**

Run: `node -p "require('./node_modules/@playwright/test/package.json').version"`
Expected: `1.63.0`, matching `v1.63.0-noble` in the workflow. A mismatch means CI downloads a different browser build than the baselines were made with, which is the whole problem this design exists to avoid.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run lint, typecheck, unit and e2e on every push"
```

---

## Task 3: Regenerate the preview baselines in the container

**Files:**
- Modify: `src/web/theme-previews/{classic,tiles,cards}.png`, `package.json`, `README.md`

**Interfaces:**
- Consumes: `ci.yml` (Task 2) — the baselines must match the container it names.
- Produces: baselines CI can compare against.

**The problem.** The three baselines were generated on this machine. CI compares them inside `mcr.microsoft.com/playwright:v1.63.0-noble`. Both resolve to DejaVu Sans today, so they may match — but that is luck, and the spec chose not to rely on it.

**The constraint.** You must not start Docker containers. So you cannot regenerate them here.

**Therefore this task does not regenerate them.** It makes the regeneration reproducible and hands the one command that needs a container to the owner, who can run it or let CI tell them. Concretely:

- [ ] **Step 1: Add the script that does it**

In `package.json`, beside the existing `previews:update`, add:

```json
    "previews:update:ci": "docker run --rm --user \"$(id -u):$(id -g)\" -e HOME=/tmp -v \"$PWD\":/w -w /w mcr.microsoft.com/playwright:v1.63.0-noble sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm build && pnpm exec playwright test -g \"preview:\" --update-snapshots'",
```

`--user` and `HOME=/tmp` are not incidental. Without them the container runs as root and every file it writes into the bind mount — the three PNGs, and anything pnpm touches — comes back owned by root, which is exactly how an earlier agent left 7,637 unremovable files in this repository.

Keep the existing `previews:update` — it is still the right command when you only want to look at a preview locally. Add a note in `README.md` saying which is authoritative.

- [ ] **Step 2: Document which one is authoritative**

In `README.md`, near the theme documentation, state plainly:

> The committed theme previews double as the admin picker's thumbnails **and** as
> Playwright's visual-regression baselines, and CI compares them inside the
> Playwright container. Regenerate them with `pnpm previews:update:ci`, which
> runs in that same container. `pnpm previews:update` regenerates them with
> whatever fonts this machine has, which is useful for looking at a change and
> wrong for committing one.

- [ ] **Step 3: Verify the script is well-formed without running it**

Run: `node -p "require('./package.json').scripts['previews:update:ci']"` and read it back. Confirm the image tag matches `ci.yml` and the installed Playwright version.

**Do not run the script.** It starts a container.

- [ ] **Step 4: State the consequence in your report**

Say explicitly that the committed baselines are still the locally-generated ones, so **the first CI run may fail on the three preview tests**, and that the fix is `pnpm previews:update:ci` followed by committing the three PNGs — not loosening the tolerance. The spec's testing section already says the first run must be green without amendment; this is the one known way it might not be, and it is better named than discovered.

- [ ] **Step 5: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
pnpm format
git add package.json README.md
git commit -m "build: make preview baselines reproducible in the CI container"
```

---

## Task 4: `publish.yml`

**Files:**
- Create: `.github/workflows/publish.yml`

**Interfaces:**
- Consumes: the existing `Dockerfile`; `config.yaml`'s `version` and `arch`.
- Produces: `ghcr.io/ajma/ha-guest-portal/{arch}-ha-guest-portal:<version>` — the exact path Task 5's `image:` key must match.

- [ ] **Step 1: Confirm the inputs**

Run:

```bash
grep -E "^(version|slug):" config.yaml
sed -n '/^arch:/,/^[a-z]/p' config.yaml
```

Expected: `version: 0.2.0`, `slug: ha_guest_portal`, and `amd64` + `aarch64`. The image path uses the repository name, not the slug — record both so Task 5 cannot drift.

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/publish.yml`:

```yaml
name: Publish

on:
  push:
    tags:
      - 'v*'

jobs:
  publish:
    # fail-fast off deliberately: if one architecture breaks, the other should
    # still publish. A half-published release is visible and fixable; cancelling
    # a good build to report a bad one wastes the good one.
    strategy:
      fail-fast: false
      matrix:
        include:
          - arch: amd64
            runner: ubuntu-24.04
          # Native arm64 rather than QEMU. Emulating aarch64 for a Node build is
          # minutes of CPU per run, and is the usual reason add-on pipelines are
          # slow. If this runner label is ever unavailable to this repository,
          # the fallback is docker/setup-qemu-action, not a broken pipeline.
          - arch: aarch64
            runner: ubuntu-24.04-arm

    runs-on: ${{ matrix.runner }}

    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      - name: Check the tag matches config.yaml
        # The Supervisor pulls the tag named by config.yaml's `version`. A tag of
        # v0.3.0 against a config.yaml still reading 0.2.0 publishes images
        # nothing will ever fetch, and the add-on silently appears not to update.
        # Refuse before building rather than produce that.
        run: |
          set -euo pipefail
          tag_version="${GITHUB_REF_NAME#v}"
          config_version="$(grep -E '^version:' config.yaml | awk '{print $2}' | tr -d '\"')"
          if [ "$tag_version" != "$config_version" ]; then
            echo "Tag is ${GITHUB_REF_NAME} (version ${tag_version}) but config.yaml says ${config_version}." >&2
            echo "The Supervisor pulls the config.yaml version, so these must agree." >&2
            exit 1
          fi
          echo "version=${config_version}" >> "$GITHUB_OUTPUT"
        id: version

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          # Per-arch tags, not a multi-arch manifest: the Supervisor substitutes
          # {arch} into config.yaml's image key and pulls that name directly.
          tags: |
            ghcr.io/ajma/ha-guest-portal/${{ matrix.arch }}-ha-guest-portal:${{ steps.version.outputs.version }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 3: Verify the version check logic locally**

The shell in that step is the only real logic in the file, and a bug in it either blocks every release or lets a mismatched one through. Test it directly:

```bash
config_version="$(grep -E '^version:' config.yaml | awk '{print $2}' | tr -d '"')"
echo "parsed: '${config_version}'  (expected '0.2.0')"

for tag in v0.2.0 v0.3.0 0.2.0; do
  tag_version="${tag#v}"
  if [ "$tag_version" != "$config_version" ]; then echo "  ${tag} -> REJECT"; else echo "  ${tag} -> accept"; fi
done
```

Expected: `v0.2.0 -> accept`, `v0.3.0 -> REJECT`, `0.2.0 -> accept` (a tag without the `v` prefix will not trigger the workflow at all, so accepting it here is harmless).

Confirm the parse yields exactly `0.2.0` with no quotes or trailing whitespace. If `config.yaml` ever quotes the version, this breaks — check and report.

- [ ] **Step 4: Verify the image builds at all**

You cannot push, and you must not run a container — but a build is not a run. Confirm the Dockerfile still builds:

```bash
docker build -t ha-guest-portal-ci-check . && docker image rm ha-guest-portal-ci-check
```

This is the single most valuable check in the task: `publish.yml` does nothing but build this Dockerfile, so if it does not build here it will not build there, and the first tagged release would be the place you found out.

**Build only. Do not `docker run` the image**, and do not touch the owner's running containers.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: publish per-arch images to ghcr.io on a version tag"
```

---

## Task 5: The `image:` key and the release runbook

**Files:**
- Modify: `README.md`, `docs/DECISIONS.md`
- **Not** `config.yaml` — see below

**This task deliberately does not add the `image:` key.**

The moment that key exists, the Supervisor stops building locally and only pulls. If the images for that version are missing or private, the add-on is not degraded — it is uninstallable, with a manifest error a user can do nothing about. The images do not exist yet and cannot until someone pushes and tags.

So this task writes down the sequence and leaves the key for the owner to add once a real pull has succeeded. Documenting a trapdoor is worth more than walking through it.

- [ ] **Step 1: Write the release runbook in `README.md`**

Add a section covering, in order:

1. Bump `version:` in `config.yaml`.
2. Commit, then tag `v<version>` matching it exactly. The publish workflow refuses a mismatch.
3. Push the tag. Wait for both matrix legs to be green — a half-published release is one architecture short, not broken-looking.
4. **Make the ghcr package public.** A package first pushed by `GITHUB_TOKEN` is **private by default, even from a public repository.** Until this is done once, by hand, in the repository's package settings, every user's pull fails with an authentication error that looks nothing like the cause. This is the most common way an add-on pipeline looks green and produces something nobody can install.
5. Confirm from a machine that is not the runner:
   ```bash
   docker pull ghcr.io/ajma/ha-guest-portal/amd64-ha-guest-portal:<version>
   docker pull ghcr.io/ajma/ha-guest-portal/aarch64-ha-guest-portal:<version>
   ```
6. **Only then** add to `config.yaml`:
   ```yaml
   image: ghcr.io/ajma/ha-guest-portal/{arch}-ha-guest-portal
   ```
   `{arch}` is literal — the Supervisor substitutes it.

- [ ] **Step 2: Record the decisions**

Append to `docs/DECISIONS.md`, matching its voice (bolded claim, reasoning, cost of reversal):

- **CI runs the end-to-end suite inside the Playwright container.** Three of those tests are pixel comparisons tight enough to catch a tile's state colour changing, and a baseline generated on one font stack and compared on another is a coin toss. The cost is that updating a preview means `pnpm previews:update:ci` rather than a bare `--update-snapshots`.
- **Images are published per-architecture, on native runners.** The Supervisor substitutes `{arch}` and pulls that name, so a multi-arch manifest is not what it wants; and emulating aarch64 under QEMU for a Node build is minutes of CPU per release.
- **The publish job refuses a tag that disagrees with `config.yaml`.** The Supervisor pulls the version named in `config.yaml`, so a mismatch publishes images nothing will ever fetch and the add-on silently appears not to update.
- **The `image:` key is added by hand, after a real pull succeeds.** It converts a failed publish from an inconvenience into an uninstallable add-on, so it is not something a pipeline should be able to enable on its own.
- Under known gaps: **the ghcr package must be made public manually.** `GITHUB_TOKEN` cannot do it, and until it is done every pull fails with an authentication error that does not resemble the cause.
- Under known gaps: **nothing runs these workflows yet.** The repository has never been pushed to.

- [ ] **Step 3: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
pnpm format
git add README.md docs/DECISIONS.md
git commit -m "docs: release runbook for the published add-on images"
```

---

## Verification Checklist

```bash
pnpm lint                      # zero errors AND zero warnings
pnpm typecheck
pnpm vitest run
pnpm build && pnpm test:e2e
pnpm format                    # must report no fixes
git status --short             # must be empty
git ls-remote --heads origin   # must STILL be empty — nothing was pushed
```

What only the owner can do, in order:

- [ ] Decide to push 201 commits of history to a public repository.
- [ ] Watch the first `ci.yml` run. If the three preview tests fail, run `pnpm previews:update:ci` and commit the PNGs — do not loosen the tolerance.
- [ ] Tag a release and confirm both matrix legs publish.
- [ ] Make the ghcr package public.
- [ ] `docker pull` both arch tags from a machine that is not the runner.
- [ ] Add the `image:` key to `config.yaml` and confirm the add-on installs from the prebuilt image.
