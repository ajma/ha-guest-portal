# Home Assistant Guest Portal

A LAN-only web app that exposes a curated subset of Home Assistant devices to guests via a shared password. Designed for short-term rentals and vacation homes.

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

1. Copy this repository into `/addons/ha-guest-portal/` on your Home Assistant host
2. Refresh the Add-on Store (Settings → Add-ons → ⋮ → Check for updates) or restart the Supervisor
3. Install "Home Assistant Guest Portal" from the Local add-ons section
4. Configure the add-on with `guest_password` and `admin_password` (both ≥8 characters, must differ)
5. Optionally set the `port` (default: 8080)
6. Start the add-on

#### Accessing the Portal

The add-on supports two access methods:

- **Admin access via HA sidebar**: After starting the add-on, click "Home Assistant Guest Portal" in your Home Assistant sidebar. This opens the portal with admin privileges automatically (no password required).

- **Guest access via direct port**: Share the LAN address with guests: `http://homeassistant.local:8080` (or your HA instance IP). Guests log in with the guest password.

No Home Assistant token is needed — the Supervisor provides it automatically. See `DOCS.md` for detailed add-on documentation.

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

   # Passwords must be ≥8 characters and must differ
   GUEST_PASSWORD=your-secure-guest-password
   ADMIN_PASSWORD=your-secure-admin-password

   # Optional settings
   PORT=8080
   DB_PATH=/data/portal.db
   # TRUST_PROXY=loopback
   ```

4. Edit `docker-compose.yml` and replace `192.168.1.10` with your server's actual LAN IP address

5. Start the service:
   ```bash
   docker compose up -d
   ```

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
  -p 192.168.1.10:8080:8080 \
  -v portal-data:/data \
  --env-file .env \
  ha-guest-portal
```

Using a bind mount (requires `mkdir -p ./data && sudo chown 1000:1000 ./data` first):
```bash
docker run -d \
  --name ha-guest-portal \
  --restart unless-stopped \
  -p 192.168.1.10:8080:8080 \
  -v ./data:/data \
  --env-file .env \
  ha-guest-portal
```

Replace `192.168.1.10` with your server's LAN IP address.

## First-Run Setup

1. Navigate to `http://<your-server-ip>:8080` in a web browser
2. Log in using the admin password you configured
3. Click the "Admin" link or navigate to `/admin`
4. Select which devices to expose to guests:
   - Choose entities from your Home Assistant instance
   - Set friendly labels
   - Select which actions are permitted (e.g., unlock but not lock)
5. Click "Save"
6. Share the guest portal URL and guest password with your guests

Guests can now control only the devices you've explicitly allowed.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HA_BASE_URL` | Yes | — | Home Assistant base URL (use LAN IP, not `.local`) |
| `HA_TOKEN` | Yes | — | Long-lived access token from a non-admin HA user |
| `GUEST_PASSWORD` | Yes | — | Guest login password (≥8 characters) |
| `ADMIN_PASSWORD` | Yes | — | Admin login password (≥8 characters, must differ from guest) |
| `PORT` | No | 8080 | HTTP port to listen on |
| `DB_PATH` | No | `/data/portal.db` | SQLite database path |
| `HA_WS_URL` | No | — | Override WebSocket URL (advanced) |
| `TRUST_PROXY` | No | — | Trust proxy headers (e.g., `loopback`) |

## Security Model

This portal is designed for deployment on a trusted home network behind a router with no inbound port forwarding.

- **Two shared passwords**: one for guests (device control), one for admins (device selection)
- **Server-side allowlist**: Only explicitly approved entities and actions are permitted
- **Token isolation**: The Home Assistant access token never reaches a browser
- **Network isolation**: Bind to a LAN interface only; no TLS (relies on physical network boundary)
- **Session cookies**: HttpOnly, SameSite=Lax (no Secure flag — this is plain HTTP on LAN)

## Accepted Risks

- **Shared credentials**: Anyone with the guest password can operate every exposed device, including locks. Do not expose devices you cannot afford to have controlled by any guest.
- **Entity renaming**: If you rename an entity in Home Assistant, the portal's allowlist entry becomes orphaned and the device will appear as unavailable. You must re-add it in the portal's admin UI.
- **No per-entity token scoping**: Home Assistant's long-lived access tokens cannot be scoped to specific entities. The portal enforces the allowlist in application code. Use a non-admin HA user account to limit blast radius.
- **Environment variable exposure**: Anyone with access to the Docker daemon on the host can read the Home Assistant token and both passwords via `docker inspect`. Treat host access as equivalent to full access to the portal and all exposed devices.

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
