# GitHub Actions CI and Container Publishing — Design

**Status:** approved in brainstorming, not yet planned
**Date:** 2026-09-20

## Goal

Every push runs the checks that currently only ever run on one laptop, and a
tagged release publishes prebuilt `amd64` and `aarch64` images to ghcr.io so the
Supervisor pulls the add-on instead of compiling it on the user's machine.

## Why

904 unit tests, 10 Playwright tests, a type checker and a linter exist and run
nowhere but here. Several defects this month were found only because something
ran them; one — a stray `NODE_ENV` stripping the service worker out of the
bundle — was misread as a flake twice before being measured.

And a local Supervisor build is minutes of `pnpm install` and `vite build` on
whatever hardware the user owns, which for a Raspberry Pi is a long time to
stare at a spinner for software they have not yet decided they like.

## Precondition, and it blocks everything

**Nothing has ever been pushed to `github.com/ajma/ha-guest-portal`.**
`git ls-remote --heads origin` returns nothing, and there are 201 unpushed
commits on `feat/ha-guest-portal`. These workflows are inert until someone
pushes, and that first push publishes the whole history to a public repository.

The history is safe to publish on the evidence available: `.env` is in
`.gitignore`, `git log --all -- .env` returns zero commits, `.dockerignore`
excludes it, and a scan of tracked files for token-shaped strings finds only a
pnpm integrity hash. Pushing remains the owner's decision, not something this
design authorises.

## Scope

In:

- `ci.yml` — lint, typecheck, unit tests, image build, and the full e2e suite,
  on every push and pull request
- `publish.yml` — multi-arch build and push to ghcr.io on a `v*` tag
- an `image:` key in `config.yaml` so the Supervisor pulls prebuilt images
- regenerating the three theme-preview baselines inside the Playwright
  container, so the comparison means the same thing locally and in CI

Out:

- releasing to the Home Assistant community add-on store, or any repository
  index beyond this one
- signing or attesting images
- caching strategies beyond the obvious pnpm store cache
- deploying anywhere

---

## `ci.yml`

Triggers on `push` and `pull_request`. One job, Ubuntu, in this order:

1. `pnpm install --frozen-lockfile`
2. `pnpm lint` — must be zero errors **and zero warnings**; the repo has held
   that line and CI should too
3. `pnpm typecheck`
4. `pnpm vitest run`
5. `pnpm build`
6. `pnpm test:e2e`

### Node and pnpm are pinned, not inferred

`package.json` declares `engines.node >= 24` and **no `packageManager` field**,
while the Dockerfile pins `pnpm@9.15.4` via corepack and this machine runs pnpm
11. The lockfile is `lockfileVersion: '9.0'`, which both accept, so nothing is
broken today — but nothing stops it drifting, and the failure would appear as a
Docker build breaking long after the change that caused it.

CI pins Node 24 and the same pnpm the Dockerfile uses. Adding a
`packageManager` field to `package.json` is the real fix and belongs in this
work.

### e2e runs inside the Playwright container

The job runs in `mcr.microsoft.com/playwright:v1.63.0-noble`, matching the
installed `@playwright/test` exactly. Two reasons:

- browsers and their system dependencies are already present, so no
  `playwright install --with-deps` step and no download flakiness
- **fonts and the rendering stack are fixed.** Three e2e tests are pixel
  comparisons of the theme previews, deliberately tolerance-tight because what
  they guard — a tile's state colour — is a low-saturation tint that a looser
  threshold provably lets through. Baselines generated on one machine and
  compared on another are a coin toss; both happen to resolve to DejaVu Sans
  today, which is luck rather than design.

**Consequence, accepted:** the three committed baselines are regenerated once,
inside that container, and from then on updating a preview means running it
through the container rather than a bare `--update-snapshots`. That is a real
ongoing cost, taken so the guard runs on every push instead of being a habit.

**The container's bundled Node is not necessarily 24.** The e2e harness spawns
the built server, which imports `node:sqlite` and therefore needs ≥ 22.5; the
repo requires ≥ 24. The job installs Node 24 inside the container rather than
relying on whatever the image ships.

---

## `publish.yml`

Triggers on a `v*` tag. A matrix over the two architectures `config.yaml`
declares:

| arch | runner |
|---|---|
| `amd64` | `ubuntu-24.04` |
| `aarch64` | `ubuntu-24.04-arm` |

**Native runners, not QEMU.** GitHub provides arm64 runners free to public
repositories. Emulating aarch64 for a Node build costs minutes of CPU per run
and is the usual reason add-on pipelines are slow.

Each job builds the existing `Dockerfile` and pushes:

```
ghcr.io/ajma/ha-guest-portal/{arch}-ha-guest-portal:<version>
```

Authentication is `GITHUB_TOKEN` with `permissions: { contents: read, packages: write }`.
No additional secrets.

### The version must match the tag, and the job must refuse if it does not

`config.yaml` carries `version:`, and the Supervisor uses it to decide what to
pull. A tag of `v0.3.0` against a `config.yaml` still reading `0.2.0` publishes
images nobody will ever fetch, and the add-on appears not to update for reasons
that are invisible from the outside.

The publish job asserts the two agree and fails loudly otherwise, before
building anything.

---

## The `image:` key, and the trap in it

`config.yaml` gains:

```yaml
image: ghcr.io/ajma/ha-guest-portal/{arch}-ha-guest-portal
```

`{arch}` is substituted by the Supervisor; it is literal in the file.

**The moment this key exists, the Supervisor stops building locally and only
pulls.** If a version's images are missing or private, the add-on is not
degraded — it is uninstallable, with an error about a manifest rather than
anything a user can act on.

Two consequences the implementation must respect:

1. **Ordering.** The `image:` key lands in the same release as the first
   successful publish, never before it.
2. **Package visibility.** A package first pushed by `GITHUB_TOKEN` is **private
   by default**, even from a public repository. It must be made public once, by
   hand, in the repository's package settings. This is the single most common
   way an add-on pipeline looks green and produces something nobody can install,
   so it belongs in the README as a step rather than in someone's memory.

---

## Error handling

- **Any check fails** → the job fails. No `continue-on-error`, no soft warnings.
  A green tick that means "it compiled" is worse than no tick.
- **A tag whose `config.yaml` version disagrees** → the publish job fails before
  building, with both values in the message.
- **One architecture fails to build** → that matrix leg fails. The other still
  publishes, which is deliberate: a half-published release is visible and
  fixable, whereas `fail-fast` cancelling a good build wastes the one that
  worked. The release is not complete until both are green, and the README says
  so.
- **The e2e suite fails in CI but not locally** → treat the container as the
  authority for the preview comparisons, since that is where the baselines come
  from.

## Testing

CI cannot be unit-tested; it is verified by running. What that means concretely:

- the first push runs `ci.yml` and must be green without amendment — if the
  preview comparisons fail, the baselines were not regenerated in the container
  and that is the bug
- the first `v*` tag must produce two pullable images, confirmed by
  `docker pull` of both arch tags from a machine that is not the runner
- the version-mismatch guard is confirmed by tagging a deliberately wrong
  version once, on a throwaway tag, and watching it refuse

The `image:` key is not added until that `docker pull` has succeeded.

## Risks

- **The `image:` key makes a failed publish fatal rather than inconvenient.**
  Mitigated by ordering and the version assertion; not eliminated.
- **Package visibility defaults to private.** Mitigated by documenting it as a
  step; it cannot be automated with `GITHUB_TOKEN` alone.
- **Baselines become container-bound.** Accepted, and the reason is recorded so
  the next person does not "fix" it by regenerating locally.
- **The first push publishes 201 commits of history.** Checked for secrets as
  described above; still a one-way door.
- **Native arm64 runners are a GitHub feature, not a guarantee.** If they are
  unavailable to this repository, the fallback is QEMU via
  `docker/setup-qemu-action`, which is slower but works. Worth knowing before
  concluding the pipeline is broken.
