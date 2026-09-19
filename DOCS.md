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

## Turning the guest portal on and off

The add-on's admin page (click the add-on in your Home Assistant sidebar) has a
**Guest Portal** toggle at the top. Turning it off:

- refuses guest logins, even with the correct password
- blocks guests who are already signed in, and drops their live updates
- leaves this admin page, and the allowlist, fully usable

Guest sessions are blocked, not destroyed. When you turn the portal back on,
anyone who kept their tab open returns automatically without signing in again.

The setting survives add-on restarts and updates.

## Access Methods

The portal supports two ways to access it:

### Admin Access via Home Assistant Sidebar

After installing the add-on, a "Home Assistant Guest Portal" entry appears in your Home Assistant sidebar. Click it to open the portal **with admin privileges, no password required**. This uses Home Assistant's ingress feature and authenticates you automatically.

From there, click "Admin" to configure which devices guests can access.

### Guest Access via Direct Port

Share the LAN address with your guests: `http://homeassistant.local:8080` (or your configured port). Guests log in with the **guest password** and can control only the devices you've exposed.

**Admins can also use the direct port** by logging in with the admin password instead of the guest password.

## First-Run Setup

1. Start the add-on
2. Open the portal from the Home Assistant sidebar (admin access, no password)
3. Click "Admin" to configure exposed devices:
   - Choose entities from your Home Assistant instance
   - Set friendly labels
   - Select which actions are permitted (e.g., unlock but not lock)
4. Click "Save"
5. Share the direct port URL and guest password with your guests:
   - URL: `http://homeassistant.local:8080` (or your LAN IP)
   - Password: The guest password you configured

## Security Model

This portal is designed for deployment on a trusted home network.

- **Hybrid ingress**: Admins use the HA sidebar (ingress, no password); guests use the direct port with password authentication
- **Two shared passwords**: one for guests (device control), one for admins (device selection) — both apply only to the direct port
- **Server-side allowlist**: Only explicitly approved entities and actions are permitted
- **Network isolation**: LAN-only; no TLS (relies on physical network boundary)
- **Source address enforcement**: The ingress port only accepts connections from the Home Assistant Supervisor

## Accepted Risks

- **Shared credentials**: Anyone with the guest password can operate every exposed device, including locks. Do not expose devices you cannot afford to have controlled by any guest.
- **Entity renaming**: If you rename an entity in Home Assistant, the portal's allowlist entry becomes orphaned and the device will appear as unavailable. You must re-add it in the portal's admin UI.
- **Environment variable exposure**: The Supervisor provides full Core API access to the add-on. Treat add-on configuration access as equivalent to full access to all exposed devices.

## Support

This software is provided as-is. For Home Assistant issues, consult the [Home Assistant documentation](https://www.home-assistant.io/docs/).
