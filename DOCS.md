# Home Assistant Guest Portal Add-On

A LAN-only web app that exposes a curated subset of Home Assistant devices to guests, behind a password. Each portal has its own password, and you can run more than one. Designed for short-term rentals and vacation homes.

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

The add-on has one option, and it is optional:

### `admin_password` (optional)
Password for administrators to configure portals from outside Home Assistant.
- Must be at least 8 characters if set
- Must differ from every portal's password — if it collides with one, the
  add-on refuses to start rather than silently handing that portal's guests
  an admin session (see **If the add-on won't start** below)
- Leave it empty to allow admin access only through the Home Assistant sidebar

Example configuration:
```yaml
admin_password: your-secure-admin-password
```

**No Home Assistant token is needed** — the Supervisor automatically provides it.

### Guest passwords

There is no deployment-wide guest password. Each portal has its own, and which
portal a guest sees is decided entirely by the password they log in with. You
create the first portal — and every later one — from the portal page in the
Home Assistant sidebar; each portal's password is set there and can be changed
at any time from that portal's settings. A password must be unique across every
portal, and must differ from `admin_password`.

## Changing the Port

The add-on listens on port 9123 inside the container. To change the port exposed on your Home Assistant host:

1. Open the add-on's page in Home Assistant
2. Go to **Configuration → Network**
3. Change the host port (the number on the left of the colon in `9123/tcp`)

The container port (right side) must remain 9123 and should not be modified.

**Upgrade note:** If your saved configuration still contains a `port:` line
from an earlier version, remove it — the option no longer exists. The same
goes for a leftover `guest_password:` line: it no longer exists either, and
the Supervisor will accept and then silently ignore it (with a log warning)
rather than fail, so it is easy to miss.

## Upgrading from a single-portal version

**The database is not compatible with earlier versions, and there is no
migration.** This is deliberate, not an oversight: this release changed the
database from one shared portal to many independently-passworded ones, and
the schema changed incompatibly to match. Upgrading in place does not fail
loudly — it fails quietly, later, and that is the actual problem this section
exists to prevent.

If you upgrade without deleting the database, here is exactly what happens:

1. The add-on **starts normally**. No warning, no error — the log looks
   healthy.
2. Your existing portal's name, theme, on/off state, and **entire device
   allowlist silently disappear** from the UI. You land on the create-portal
   screen, as if this were a fresh install. The old data is still in the
   file, it is just unreachable by the new schema.
3. You create a portal. **This succeeds.**
4. The moment you view its device list, add a device, or a guest tries to log
   in, you get a raw server error (`no such column: portal_id`). Every device
   read and write on that portal fails the same way.

**To upgrade correctly:**

1. Stop the add-on.
2. Delete the database file: `/data/portal.db` inside the add-on (delete it
   over the Samba share, or with a one-off `rm` in the add-on's Terminal if
   you have that add-on installed), or the equivalent file in your Docker
   volume/bind mount for a Docker install.
3. Start the add-on. You will land on the create-portal screen, exactly as on
   a fresh install.
4. Re-create each portal you had before, with a new password for each —
   passwords are not recoverable from the deleted database.
5. **Re-pair the Home Assistant integration.** Deleting the database also
   regenerates the deployment id and the integration token, so the existing
   integration entry no longer matches. Add-on installations rediscover
   themselves automatically after a restart; Docker Compose installations
   must remove and re-add the integration with the new token (shown under the
   gear icon's **Settings** panel — see below).

There is nothing to back up and restore: this is a clean re-creation of every
portal, not a data migration.

## If the add-on won't start

Two configuration mistakes make the add-on refuse to start rather than run
in a broken state. Both are deliberate fail-fast checks, and both are fixed
from the add-on's own **Configuration** page — you do not need to touch the
database for either of these.

**`admin_password` is too short.** Outside the add-on (Docker/Compose) this
surfaces as a startup log naming the environment variable rather than the
option you set:
```
Fatal error: Error: Invalid configuration:
✖ Too small: expected string to have >=8 characters
  → at ADMIN_PASSWORD
```
Fix: set `ADMIN_PASSWORD` (or the add-on's `admin_password` option) to at
least 8 characters.

**`admin_password` collides with a portal's password.** The add-on refuses to
start with:
```
Fatal error: Error: ADMIN_PASSWORD is also the guest password for "<portal
name>" (<portal id>). A guest of that portal would be logged in as admin
over every portal. Change ADMIN_PASSWORD, or change that portal's password.
```
This is not cosmetic: if the two passwords matched and the add-on started
anyway, a guest logging into that one portal would be logged in as an admin
with full control over every portal, not just the one they were given a
password for. Fix: change `admin_password` in the add-on's options, or
change that portal's password from its **▸ Portal settings** accordion (see
below) — either one clears the collision.

## Editing the portal

Open the portal from your Home Assistant sidebar and you land on the same page
your guests see, with two extra buttons in the header: **Edit** and a **⚙**
gear, plus — where your guest sees a plain title — a portal switcher. Guests
never see any of these three — for a guest they are absent, not greyed out.

### Switching portals, and adding one

The title in the header is not just a label: for an owner it is a dropdown
listing every portal you have, with the one you are looking at selected.
Choosing a different name switches straight to that portal.

At the bottom of that same dropdown is **+ Add portal** — the only way to
create a second (or third, or fourth) portal. Choosing it opens the same
create-portal screen a brand-new install shows: a name and a password (at
least 8 characters), and a **Create portal** button that is disabled until
both are filled in. The portal it creates is enabled immediately, with an
empty device list, and every portal's password must be unique — trying to
reuse one already in use, whether another portal's or `admin_password`
itself, is refused.

### Edit

Click **Edit** and the grid becomes an editing surface: every device gets a
dashed outline, and the button you clicked now reads **Done**. In edit mode,
tapping a device opens its editor instead of operating it — tapping a lamp will
not switch the lamp on. Each device also carries its own small **Edit** button,
which is the way in for a device that has no buttons of its own.

A device's editor lets you:

- **rename it** — this is the name guests see, and it need not match the name in
  Home Assistant
- **choose what guests can do with it** — tick only the actions you want to
  allow, such as unlock but not lock
- **move it up or down** — the order here is the order guests see
- **remove it** — guests lose access to it straight away

At the end of the grid is a dashed **+ Add device** tile. Click it to search your
Home Assistant devices and pick one to expose.

If a device you added has since been renamed or removed in Home Assistant, its
tile is outlined in red and labelled as orphaned. Remove it and add the device
again under its new name.

Click **Done** when you have finished.

### Settings (the gear icon)

The **⚙** button is not where a portal's own name, theme, on/off switch, or
password live — that surprises anyone coming from an earlier version, where
it was. It opens a small panel with:

- the **integration token**, revealed with a **Show token** button, for
  pairing the Home Assistant integration by hand in a Docker Compose install
  (add-on installs are discovered automatically and never need it)
- the **deployment id**
- a **Log out** button

Close the panel when you are done.

### Portal settings (the name, theme, on/off switch, and password)

Below the header, and above the device grid, is a collapsed row reading
**▸ Portal settings**. Click it to expand the current portal's own settings:

- **Portal name** — a text field. It saves when you click or tab away from
  it; there is no Enter-to-save and no Save button.
- **Theme** — three radio buttons, one per theme (see **Choosing a theme**
  below).
- **Enabled** — a checkbox. Unticking it is the guest kill-switch (see
  **Turning the guest portal on and off** below).
- **Password** — this portal's guest password, with a **Show password** /
  **Hide password** button. Changing it takes effect immediately and signs
  out every guest currently using that portal (see below).
- **Delete portal** — asks you to confirm, then removes the portal and its
  entire device list. This cannot be undone.

Collapse it again with the same **▸ Portal settings** row (now **▾**) when
you are done — as with editing, nothing here needs a separate save.

**Rotating a portal's password signs its guests out immediately.** The
moment you save a new password, every guest session for that portal is
revoked and their connection is dropped — they will need the new password to
get back in. This is deliberate: an old password should stop working the
instant you change it, not the next time someone happens to reload.

### Two things worth knowing before you start

**A device you add appears to your guests straight away, and can do nothing
until you say what it may do.** A newly added device arrives with no actions
allowed at all: a lamp, switch or fan says "No actions available" on its tile,
and a lock or blind simply has no buttons on it. This is deliberate — it means
adding a lock can never make it openable before you have decided what a guest
may do with it. Tick the actions you want and the tile becomes usable within a
second or two, on your guests' screens as well as your own.

**Every change saves the moment you make it.** There is no Save button, and
there is no undo. Renaming a device, ticking an action, moving a tile and
removing a device all take effect immediately, and a guest looking at the portal
sees the result at once. That is why removing a device asks you to confirm: it
is the one change you cannot simply make again.

## Naming the portal

Expand **▸ Portal settings** below the header and edit the **Portal name**
field. The name you type appears in that portal's header and in the browser
tab, for your guests and for you.

It saves as soon as you click or tab away from the field — there is no
Enter-to-save. Clearing the field restores the default name, `Guest Portal` —
the header is never left blank. Names are limited to 60 characters.

A guest who already has the portal open keeps the old name until their next page
load. The setting survives add-on restarts and updates.

## Turning the guest portal on and off

Expand **▸ Portal settings** below the header. The **Enabled** checkbox turns
that portal's guest side on and off. Unticking it:

- refuses guest logins, even with the correct password
- blocks guests who are already signed in, and drops their live updates
- leaves the portal fully usable for you — you can still edit devices and change
  settings

Guest sessions are blocked, not destroyed. When you turn the portal back on,
anyone who kept their tab open returns automatically without signing in again.

The setting survives add-on restarts and updates.

## Choosing a theme

Expand **▸ Portal settings** below the header. Three radio buttons, one per
theme, change how that guest portal looks:

- **Classic** — the look of Home Assistant itself. Each device is a wide row: a
  round icon on the left, the device's name and what it is doing next to it, and
  its buttons along the bottom. The icon takes on Home Assistant's own colour for
  that kind of device — amber for a lit lamp, green for a locked door — and the
  buttons stay a neutral grey, exactly as they do in Home Assistant.
- **Tiles** — a grid of large rounded squares, two across on a phone. The whole
  square is the button, and it floods with colour when the device is active: the
  lamp tile turns amber, the lock tile green, the garage door purple. Readable
  from across a room.
- **Cards** — a light, airy layout with plenty of space between things. Each
  device sits on its own quiet pale card with a large circular badge at the top,
  and that badge is the button. When the device is active the badge picks up a
  soft tint of its colour. The name and state sit below the badge, outside the
  button, so nothing happens if a guest rests a thumb on the text.

The theme applies to everything a guest sees: the login screen, the device list,
and the "temporarily unavailable" message shown while the portal is switched off.
Your own Edit mode, the device editor, and the **▸ Portal settings** accordion
follow it too — they take their colours from whichever theme you have chosen for
that portal, so they never look pasted on top of the portal.

Whichever you choose, it switches between a light and a dark appearance on its
own, following whatever the guest's phone or laptop is already set to. There is
no separate dark-mode setting to manage.

A guest who already has the portal open keeps the old look until their next page
load — reloading the page is enough. The setting survives add-on restarts and
updates.

## Access Methods

The portal supports two ways to access it:

### Admin Access via Home Assistant Sidebar

After installing the add-on, a "Home Assistant Guest Portal" entry appears in your Home Assistant sidebar. Click it to open the portal **with admin privileges, no password required**. This uses Home Assistant's ingress feature and authenticates you automatically.

From there, click **Edit** to choose which devices guests can access, or
expand **▸ Portal settings** to name the portal, pick a theme, rotate its
password, or turn the guest side off.

### Guest Access via Direct Port

Share the LAN address with your guests: `http://homeassistant.local:9123`. Guests log in with **their own portal's password**, which is what decides the portal they land on, and can control only the devices that portal exposes.

**Admins can also use the direct port** by logging in with the admin password instead of a portal's password.

## Add the portal to your home screen

A guest who has to hunt for a URL will not use the portal twice. Once they have
the portal open in a browser, they can keep it as an icon:

- **iPhone or iPad** — tap **Share** in Safari, scroll down the list, and tap
  **Add to Home Screen**. The name under the icon can be edited before tapping
  **Add**.
- **Android, and Chrome on a computer** — the browser offers to install it. That
  is a prompt asking to install the app, or a small install icon at the
  right-hand end of the address bar; on Android it also appears in the browser's
  menu as **Install app** or **Add to Home screen**.

Tapping the icon afterwards opens the portal on its own, with no address bar and
no tabs around it, so it looks like an app rather than a web page.

It is still the same portal, though, and it still has to be able to reach your
house. When it cannot — the guest has left, or the add-on is stopped — the app
says so itself: a page headed **Can't reach the guest portal**, suggesting they
may need to be on the home Wi-Fi, with a **Retry** button that tries again. That
is the portal talking, not the browser's error page about a hostname your guest
has never heard of.

### What this needs from your setup

Browsers only allow an app to be installed, and only allow it to keep a copy of
itself for when the network is gone, on a secure (`https://`) address. The
portal is served over plain `http://` on your own network, so today:

- **Android and Chrome on a computer** will not offer to install it from a plain
  `http://` address. There is no prompt and no address-bar icon to click.
- **iPhone and iPad** will still add the icon, and it will still open without
  Safari's chrome around it — but nothing is stored for when the network is out
  of reach, so opening it away from the house shows Safari's own error page
  rather than the portal's **Can't reach the guest portal** page.

Putting the portal behind HTTPS is not something the add-on does for you; it
needs a reverse proxy in front of it. Everything above works as described once
guests reach the portal over an `https://` address.

## First-Run Setup

1. Start the add-on
2. Open the portal from the Home Assistant sidebar (admin access, no
   password). A fresh install has no portals yet, so you land on the
   create-portal screen
3. Give the portal a name and set its password, then create it
4. Click **Edit**, then the **+ Add device** tile at the end of the grid, and
   pick an entity from your Home Assistant instance
5. Tap the new device's tile to give it a friendly name and tick the actions
   guests are allowed to use (e.g. unlock but not lock). Until you tick
   something the device is visible to guests but does nothing
6. Click **Done**. There is no Save button — every change saved as you made it
7. Optionally expand **▸ Portal settings** to rename the portal or choose a theme
8. Share the direct port URL and the portal's password with your guests:
   - URL: `http://homeassistant.local:9123` (or your LAN IP)
   - Password: The password you set when you created the portal

## Security Model

This portal is designed for deployment on a trusted home network.

- **Hybrid ingress**: Admins use the HA sidebar (ingress, no password); guests use the direct port with password authentication
- **Shared passwords**: one per portal for its guests (device control), and one deployment-wide for admins (device selection) — both apply only to the direct port
- **Server-side allowlist**: Only explicitly approved entities and actions are permitted
- **Network isolation**: LAN-only; no TLS (relies on physical network boundary)
- **Source address enforcement**: The ingress port only accepts connections from the Home Assistant Supervisor

## Accepted Risks

- **Shared credentials**: Anyone with a portal's password can operate every device that portal exposes, including locks. Do not expose devices you cannot afford to have controlled by any guest of that portal.
- **Entity renaming**: If you rename an entity in Home Assistant, the portal's allowlist entry becomes orphaned and the device will appear as unavailable. Edit mode outlines an orphaned tile in red; remove it there and add the device again under its new name.
- **Environment variable exposure**: The Supervisor provides full Core API access to the add-on. Treat add-on configuration access as equivalent to full access to all exposed devices.

## Support

This software is provided as-is. For Home Assistant issues, consult the [Home Assistant documentation](https://www.home-assistant.io/docs/).
