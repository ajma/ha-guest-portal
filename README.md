# Home Assistant Guest Portal

A LAN-only web app that exposes a curated subset of Home Assistant devices to guests, behind a password. Each portal has its own password, and you can run more than one. Designed for short-term rentals and vacation homes.

## Prerequisites

### 1. Create a Non-Admin Home Assistant User

**Important**: Do not use an admin or owner account. Home Assistant cannot scope long-lived access tokens to specific entities. This portal enforces the allowlist server-side, but using a non-admin account provides defense in depth if the portal is compromised.

1. In Home Assistant, go to Settings → People
2. Create a new user (e.g., "Guest Portal Service")
3. Do not grant Administrator or Owner privileges
4. Create a long-lived access token for this user
5. Save the token securely — you will need it for `HA_TOKEN`

### 2. Use a LAN IP Address for Home Assistant

**Do not use `homeassistant.local`** or other mDNS hostnames. mDNS does not resolve inside Docker containers. The application will reject `.local` hostnames with an explanatory error.

Use your Home Assistant server's LAN IP address (e.g., `http://192.168.1.100:8123`) for `HA_BASE_URL`.

## Installation

### Home Assistant Add-On

**For HA OS or HA Supervised installations only** (HA Container does not support add-ons).

1. Copy this repository into `/addons/ha-guest-portal/` on your Home Assistant host — either manually over the Samba share add-on, or with `scripts/deploy-to-ha.sh` (copy `scripts/.env.deploy.example` to `scripts/.env.deploy` first)
2. Refresh the Add-on Store (Settings → Add-ons → ⋮ → Check for updates) or restart the Supervisor
3. Install "Home Assistant Guest Portal" from the Local add-ons section
4. Optionally set `admin_password` (≥8 characters) — only needed for admin access from outside the Home Assistant sidebar. Guest passwords are not configured here: each portal carries its own, set when you create it in the UI
5. Start the add-on

#### Accessing the Portal

The add-on supports two access methods:

- **Admin access via HA sidebar**: After starting the add-on, click "Home Assistant Guest Portal" in your Home Assistant sidebar. This opens the portal with admin privileges automatically (no password required).

- **Guest access via direct port**: Share the LAN address with guests: `http://homeassistant.local:9123` (or your HA instance IP). Guests log in with their own portal's password, which is what decides the portal they land on.

- **Add to home screen**: guests can keep the portal as an icon that opens without browser chrome, and it explains itself instead of showing a browser error when it cannot be reached — browsers require an `https://` address for this, so on a plain LAN address only iOS adds the icon. See `DOCS.md`.

To change the published port, use the add-on's **Configuration → Network** panel in the Home Assistant UI. The container port must remain 9123.

No Home Assistant token is needed — the Supervisor provides it automatically. See `DOCS.md` for detailed add-on documentation.

### Home Assistant Integration (optional)

A companion custom integration exposes **each portal** to Home Assistant as
its own device, grouped under one "Guest Portal" hub device, with two
entities:

- a **switch**, to turn that portal's guest side on and off from HA, a
  dashboard, or an automation
- a **sensor**, a timestamp updated whenever a guest of that portal logs in or
  operates a device

Entity IDs are derived from each portal's name, not fixed: a portal named
"Barn" gets `switch.barn` and `sensor.barn_last_interaction`. That derivation
happens once, when the portal's entities are first created — renaming the
portal afterward does not update the entity IDs (or the device name shown in
Home Assistant) to match.

#### Install

Via HACS: add `https://github.com/ajma/ha-guest-portal` as a custom repository
of type *Integration*, install "Home Assistant Guest Portal", and restart Home
Assistant.

Manually: copy `custom_components/ha_guest_portal/` into your Home Assistant
`config/custom_components/` directory and restart.

#### Set up

**Add-on installations:** the add-on announces itself to the Supervisor, so after
restarting Home Assistant you will find "Home Assistant Guest Portal" waiting
under Settings → Devices & Services. Click **Configure**. No credentials needed.

**Docker Compose installations:** go to Settings → Devices & Services → Add
Integration → Home Assistant Guest Portal, and enter the host, port, and the
integration token shown in the portal's **Settings** panel under "Show token".

The integration requires **Python 3.14.2+**, which is satisfied by Home Assistant
2026.9 and newer.

#### Notification automation

The sensor's attributes describe what happened, using the same shape for both
kinds of interaction. Substitute your portal's own entity ID — below,
"Barn" — for `sensor.barn_last_interaction`:

```yaml
automation:
  - alias: Notify when a guest uses the Barn portal
    triggers:
      - trigger: state
        entity_id: sensor.barn_last_interaction
    conditions:
      - condition: template
        value_template: "{{ state_attr('sensor.barn_last_interaction', 'kind') == 'action' }}"
    actions:
      - action: notify.mobile_app_my_phone
        data:
          message: >-
            Guest used {{ state_attr('sensor.barn_last_interaction', 'label') }}
            ({{ state_attr('sensor.barn_last_interaction', 'action') }})
```

Attributes: `kind` (`action` or `login`), `target_entity_id`, `label`, `action`,
and `ok`. The three device attributes are `null` when `kind` is `login`.

Home Assistant learns about an interaction within about 10 seconds.

### Docker Compose (Recommended)

1. Clone this repository or download the files
2. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

3. Edit `.env` with your configuration:
   ```bash
   # Home Assistant connection - use LAN IP, not .local hostname
   HA_BASE_URL=http://192.168.1.100:8123
   HA_TOKEN=your-long-lived-access-token

   # Required outside the add-on: with no Home Assistant sidebar to authenticate
   # through, this is the only way to reach admin and create the first portal.
   # ≥8 characters, and must differ from every portal's password.
   ADMIN_PASSWORD=your-secure-admin-password

   # Optional settings
   PORT=9123
   DB_PATH=/data/portal.db
   # TRUST_PROXY=loopback
   ```

4. Edit `docker-compose.yml` and replace `192.168.1.10` with your server's actual LAN IP address

5. Start the service:
   ```bash
   docker compose up -d
   ```

6. Open the portal and log in with `ADMIN_PASSWORD`. A fresh database has no
   portals, so you land on the create-portal screen; each portal you create
   gets its own guest password there.

The database is stored in a Docker named volume (`portal-data`). Named volumes are initialized with the image's ownership (uid 1000), so they work on any host regardless of your user's uid.

To locate the volume's path on the host (for backups):
```bash
docker volume inspect portal-data --format '{{ .Mountpoint }}'
```

#### Using a Bind Mount Instead (Optional)

If you prefer the database in a specific host directory, replace `portal-data:/data` in `docker-compose.yml` with `./data:/data`. The container runs as uid 1000, so you must prepare the directory first:

```bash
mkdir -p ./data
sudo chown 1000:1000 ./data
```

A bind mount carries the host directory's ownership into the container. If the host directory is not owned by uid 1000, SQLite will fail with "unable to open database file".

### Docker (Standalone)

Using a named volume (recommended):
```bash
docker build -t ha-guest-portal .

docker volume create portal-data

docker run -d \
  --name ha-guest-portal \
  --restart unless-stopped \
  -p 192.168.1.10:9123:9123 \
  -v portal-data:/data \
  --env-file .env \
  ha-guest-portal
```

Using a bind mount (requires `mkdir -p ./data && sudo chown 1000:1000 ./data` first):
```bash
docker run -d \
  --name ha-guest-portal \
  --restart unless-stopped \
  -p 192.168.1.10:9123:9123 \
  -v ./data:/data \
  --env-file .env \
  ha-guest-portal
```

Replace `192.168.1.10` with your server's LAN IP address.

## Upgrading from a single-portal version

**The database is not compatible with earlier versions, and shipping a
migration is a deliberate non-goal.** This version changed the database from
one shared portal to many independently-passworded ones, and the schema
changed incompatibly to match.

If you start this version against an old database without deleting it
first, **it will not fail loudly.** It boots normally, your existing portal's
name, theme, and entire device allowlist silently disappear from the UI
(you land on the create-portal screen, as on a fresh install), and creating
a new portal succeeds — right up until you view its device list or a guest
tries to log in, at which point you get a raw `no such column: portal_id`
server error on every device read and write.

**To upgrade correctly:**

1. Stop the add-on or container.
2. Delete the database file — `/data/portal.db` for an add-on install, or the
   equivalent file in your Docker volume or bind mount.
3. Start it again. You land on the create-portal screen, exactly as on a
   fresh install, and re-create each portal you had before with a new
   password — passwords are not recoverable from the deleted database.
4. **Re-pair the Home Assistant integration.** Deleting the database also
   regenerates the deployment id and the integration token, so the existing
   integration entry no longer matches. Add-on installs rediscover
   themselves automatically after a restart; Docker Compose installs must
   remove and re-add the integration with the new token (see `DOCS.md`).

See `DOCS.md`'s "Upgrading from a single-portal version" section for the
full walkthrough.

### If it won't start after upgrading

Two configuration states now make the server refuse to start rather than run
broken, and an upgrade is the most likely time to hit either:

- **`ADMIN_PASSWORD` shorter than 8 characters** — logs `Invalid
  configuration: ✖ Too small: expected string to have >=8 characters → at
  ADMIN_PASSWORD`. Set it to at least 8 characters (in the add-on's
  `admin_password` option, or your `.env`).
- **`ADMIN_PASSWORD` equal to some portal's password** — logs `ADMIN_PASSWORD
  is also the guest password for "<portal name>" (<portal id>). A guest of
  that portal would be logged in as admin over every portal. Change
  ADMIN_PASSWORD, or change that portal's password.` This is deliberate: were
  the server to start anyway, a guest logging into that one portal would get
  an admin session over every portal, not just the one their password was
  for. Change `admin_password`, or that portal's password, and restart.

## First-Run Setup

1. Navigate to `http://<your-server-ip>:9123` in a web browser
2. Log in using the admin password you configured. A fresh database has no
   portals yet, so you land straight on a create-portal screen — there is no
   separate admin page
3. Give the portal a name and set its password (at least 8 characters), then
   create it
4. Click **Edit** in the header, then the **+ Add device** tile at the end of
   the grid, and choose an entity from your Home Assistant instance
5. Tap the new device's tile to set a friendly label and tick which actions are
   permitted (e.g., unlock but not lock). A device with nothing ticked is
   visible to guests but inert
6. Click **Done**. Every change saved as you made it; there is no Save button
   and no undo
7. Optionally expand **▸ Portal settings** below the header to rename the
   portal or pick one of the three guest portal themes (see `DOCS.md`)
8. Share the portal's URL and its password with your guests:
   - URL: `http://<your-server-ip>:9123`
   - Password: the password you set when you created the portal

Guests can now control only the devices you've explicitly allowed. To add a
second portal, use **+ Add portal** at the bottom of the portal switcher in
the header (see `DOCS.md`).

## Theme Previews (development)

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

If the three `preview:` tests fail in CI but pass locally, the container is the
authority: run `pnpm previews:update:ci` and commit the regenerated PNGs. Do
**not** raise the tolerances in `test/e2e/theme-previews.spec.ts`. They are tight
on purpose — what they guard is a low-saturation tint, and a looser threshold
was measured to let a green-to-purple repaint of a lock tile's icon through
undetected.

## Publishing a Release (maintainers)

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
   Push the one tag, not `git push --tags`. This repository carries local
   housekeeping tags (`pre-trailer-rewrite`) that point at pre-rewrite
   history; `--tags` would publish that history alongside the release, and
   republishing it is not something a later commit can undo.
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

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HA_BASE_URL` | Yes | — | Home Assistant base URL (use LAN IP, not `.local`) |
| `HA_TOKEN` | Yes | — | Long-lived access token from a non-admin HA user |
| `ADMIN_PASSWORD` | Outside the add-on | — | Admin login password (≥8 characters, must differ from every portal's password). Optional in add-on mode, where the Home Assistant sidebar already authenticates admins; without either, the server refuses to start, since no one could create a portal |
| `PORT` | No | 9123 | HTTP port to listen on |
| `DB_PATH` | No | `/data/portal.db` | SQLite database path |
| `HA_WS_URL` | No | — | Override WebSocket URL (advanced) |
| `TRUST_PROXY` | No | — | Trust proxy headers (e.g., `loopback`) |

## Security Model

This portal is designed for deployment on a trusted home network behind a router with no inbound port forwarding.

- **Shared passwords**: one per portal for its guests (device control), and one deployment-wide for admins (portal and device management)
- **Server-side allowlist**: Only explicitly approved entities and actions are permitted
- **Kill-switch**: each portal's guest surface can be disabled from its own
  **▸ Portal settings** accordion or from Home Assistant, without affecting
  an owner's own access
- **Token isolation**: The Home Assistant access token never reaches a browser
- **Network isolation**: Bind to a LAN interface only; no TLS (relies on physical network boundary)
- **Session cookies**: HttpOnly, SameSite=Lax (no Secure flag — this is plain HTTP on LAN)

## Accepted Risks

- **Shared credentials**: Anyone with a portal's guest password can operate every device that portal exposes, including locks. Do not expose devices you cannot afford to have controlled by any guest of that portal.
- **Entity renaming**: If you rename an entity in Home Assistant, the portal's allowlist entry becomes orphaned and the device will appear as unavailable. Edit mode flags the orphaned tile; remove it there and add the device again.
- **No per-entity token scoping**: Home Assistant's long-lived access tokens cannot be scoped to specific entities. The portal enforces the allowlist in application code. Use a non-admin HA user account to limit blast radius.
- **Environment variable exposure**: Anyone with access to the Docker daemon on the host can read the Home Assistant token and the admin password via `docker inspect`, and the database holds every portal's password. Treat host access as equivalent to full access to the portal and all exposed devices.

## Monitoring

The service exposes a healthcheck endpoint at `GET /api/health` (no authentication required). It returns:
```json
{
  "ok": true,
  "haStale": false
}
```

- `ok: true` means the process is running
- `haStale: true` means the WebSocket to Home Assistant is disconnected (devices can still be controlled via REST)

The Docker `HEALTHCHECK` uses this endpoint. A stale HA connection does not fail the healthcheck because restarting the container does not fix HA connectivity.

## Support

This software is provided as-is. For Home Assistant issues, consult the [Home Assistant documentation](https://www.home-assistant.io/docs/).
