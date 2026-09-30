# Contributing

## Running it locally

You need Node 24 or newer and pnpm (`corepack enable` sets it up from
`package.json`).

```bash
pnpm install
pnpm dev:demo
```

`dev:demo` starts a seeded fake Home Assistant on `:8124`, the portal server
on `:9123`, and Vite on `:5173`. Open **http://localhost:5173** — that's the
one with hot reload. The admin password is `dev-admin-password`.
`pnpm dev:real` does the same against your real Home Assistant, reading
`HA_BASE_URL`, `HA_TOKEN` and `ADMIN_PASSWORD` from `.env`; anything you add
to a portal there operates real devices.

The checks CI runs:

```bash
pnpm lint
pnpm typecheck
pnpm test        # unit and integration (Vitest)
pnpm build       # the end-to-end tests run against the build
pnpm test:e2e    # end to end (Playwright)
```

CI's Python job covers the Home Assistant integration and the shell scripts:

```bash
uv run --locked pytest
uv run --locked ruff check
uv run --locked ruff format --check
git ls-files -z '*.sh' | xargs -0r shellcheck
```

## Theme Previews

The committed theme previews in `src/web/theme-previews/` are Playwright's
visual-regression baselines (the theme picker itself is plain radio buttons,
not thumbnails), and CI compares them inside the Playwright container.
Regenerate them with
`pnpm previews:update:ci`, which runs in that same container.
`pnpm previews:update` regenerates them with whatever fonts this machine has,
which is useful for looking at a change and wrong for committing one.

`previews:update:ci` is the authoritative command. It pulls
`mcr.microsoft.com/playwright:v1.63.0-noble` (~2 GB the first time), which must
stay in step with both `@playwright/test` in `package.json` and the `container:`
image in `.github/workflows/ci.yml`; if those three ever disagree, CI compares
baselines against a different browser build and the comparison means nothing.

Its `docker run` flags are load-bearing, so do not trim them:

- `--user "$(id -u):$(id -g)"` with `-e HOME=/tmp` — without these the container
  runs as root and every file it writes into the bind mount (the PNGs, `dist/`,
  anything pnpm touches) comes back root-owned and unremovable.
- `corepack enable --install-directory /tmp/bin` — a plain `corepack enable`
  writes its shims next to the `node` binary, which is `/usr/bin` in that image
  and not writable by a non-root user.
- `--ipc=host` — Playwright's own recommendation for running Chromium in
  Docker; the default 64 MB `/dev/shm` can crash the browser mid-run.
- `-e CI=true` — the bind-mounted `node_modules/` was installed by the host, so
  the container's `pnpm install` wants to purge and rebuild it. Interactively
  pnpm asks first; with no TTY it instead aborts with
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` and the whole command fails
  before Playwright starts. `CI=true` is pnpm's own documented answer.

After this command runs, your host `node_modules/` is the one the container
installed. Run `CI=true pnpm install --frozen-lockfile` to put it back —
without `CI=true` that reinstall hits the same no-TTY abort.

If the three `preview:` tests fail in CI but pass locally, the container is the
authority: run `pnpm previews:update:ci` and commit the regenerated PNGs. Do
**not** raise the tolerances in `test/e2e/theme-previews.spec.ts`. They are tight
on purpose — what they guard is a low-saturation tint, and a looser threshold
was measured to let a green-to-purple repaint of a lock tile's icon through
undetected.

The same PNGs illustrate the themes in `README.md`, so regenerating them
updates the README's pictures too.

## Publishing a Release

`.github/workflows/publish.yml` builds and pushes per-architecture images to
ghcr.io whenever a `v*` tag is pushed, and `.github/workflows/ci.yml` runs
lint, typecheck, unit and end-to-end tests on every push. Neither workflow
touches `config.yaml`'s `image:` key — that key does not exist yet, and it is
added by hand, in the last step below, only after a real pull has succeeded.

**Do this in order.** Steps 4 and 6 are the two a skim will miss, and skipping
either produces a release that looks green and installs for nobody:

1. Bump `version:` in `config.yaml` (currently `0.0.1`).
2. Commit the bump, then tag the commit `v<version>`, matching `config.yaml`
   exactly:
   ```bash
   git commit -am "chore: bump version to 0.3.0"
   git tag v0.3.0
   ```
   `publish.yml` checks the tag against `config.yaml` and refuses to build on
   a mismatch.
3. Push the tag **by name** and wait for **both** matrix legs — `amd64` and
   `aarch64` — to go green in the Actions tab. A half-published release is
   one architecture short, not broken-looking: nothing about it says the
   other image is missing.
   ```bash
   git push origin v0.3.0
   ```
   Push the one tag, not `git push --tags`. `--tags` publishes every local
   tag you have, including any housekeeping tag pointing at history you never
   meant to publish, and republishing history is not something a later commit
   can undo.
4. **Make the ghcr package public.** A package first pushed by `GITHUB_TOKEN`
   is **private by default, even from a public repository.** Until this is
   done once, by hand, in the repository's package settings, every pull
   — including the Supervisor's — fails with an authentication error that
   looks nothing like the cause. This is the most common way this kind of
   pipeline looks green and ships something nobody can install. Do not skip
   it.
5. Confirm it worked, from a machine that is not the runner:
   ```bash
   docker pull ghcr.io/ajma/ha-guest-portal/amd64-ha-guest-portal:0.3.0
   docker pull ghcr.io/ajma/ha-guest-portal/aarch64-ha-guest-portal:0.3.0
   ```
6. **Only after both pulls succeed**, add to `config.yaml`:
   ```yaml
   image: ghcr.io/ajma/ha-guest-portal/{arch}-ha-guest-portal
   ```
   `{arch}` is literal — the Supervisor substitutes it at pull time. The
   moment this key exists, the Supervisor stops building the add-on locally
   and only pulls; adding it before a real pull has succeeded turns a failed
   publish from an inconvenience into an uninstallable add-on with a manifest
   error the user can do nothing about.
