# Home Assistant Guest Portal Add-On

A LAN-only web app that exposes a curated subset of Home Assistant devices to guests via a shared password. Designed for short-term rentals and vacation homes.

## Installation

1. Copy this repository into your Home Assistant add-ons folder:
   ```
   /addons/ha-guest-portal/
   ```

2. Refresh the Add-on Store (or restart the Supervisor)

3. Install the "Home Assistant Guest Portal" add-on from the "Local add-ons" section

4. Configure the add-on options (see below)

5. Start the add-on

**Note**: This add-on requires Home Assistant OS or Home Assistant Supervised. It cannot run on Home Assistant Container installations.

## Configuration

The add-on requires three options:

### `guest_password` (required)
Password for guests to access the portal and control exposed devices.
- Must be at least 8 characters
- Must differ from `admin_password`

### `admin_password` (required)
Password for administrators to configure which devices are exposed.
- Must be at least 8 characters
- Must differ from `guest_password`

### `port` (optional, default: 8080)
HTTP port the portal will listen on.

Example configuration:
```yaml
guest_password: your-secure-guest-password
admin_password: your-secure-admin-password
port: 8080
```

**No Home Assistant token is needed** — the Supervisor automatically provides it.

## First-Run Setup

1. Start the add-on
2. Navigate to the portal (default: `http://homeassistant.local:8080`)
3. Log in using the admin password
4. Click "Admin" or navigate to `/admin`
5. Select which devices to expose to guests:
   - Choose entities from your Home Assistant instance
   - Set friendly labels
   - Select which actions are permitted (e.g., unlock but not lock)
6. Click "Save"
7. Share the guest portal URL and guest password with your guests

## Security Model

This portal is designed for deployment on a trusted home network.

- **Two shared passwords**: one for guests (device control), one for admins (device selection)
- **Server-side allowlist**: Only explicitly approved entities and actions are permitted
- **Network isolation**: LAN-only; no TLS (relies on physical network boundary)
- **Direct port exposure**: Does not use Home Assistant ingress (by design — guests should not need HA accounts)

## Accepted Risks

- **Shared credentials**: Anyone with the guest password can operate every exposed device, including locks. Do not expose devices you cannot afford to have controlled by any guest.
- **Entity renaming**: If you rename an entity in Home Assistant, the portal's allowlist entry becomes orphaned and the device will appear as unavailable. You must re-add it in the portal's admin UI.
- **Environment variable exposure**: The Supervisor provides full Core API access to the add-on. Treat add-on configuration access as equivalent to full access to all exposed devices.

## Support

This software is provided as-is. For Home Assistant issues, consult the [Home Assistant documentation](https://www.home-assistant.io/docs/).
