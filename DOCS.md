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

Example configuration:
```yaml
guest_password: your-secure-guest-password
admin_password: your-secure-admin-password
```

**No Home Assistant token is needed** — the Supervisor automatically provides it.

## Changing the Port

The add-on listens on port 9123 inside the container. To change the port exposed on your Home Assistant host:

1. Open the add-on's page in Home Assistant
2. Go to **Configuration → Network**
3. Change the host port (the number on the left of the colon in `9123/tcp`)

The container port (right side) must remain 9123 and should not be modified.

**Upgrade note:** If your saved configuration still contains a `port:` line from an earlier version, remove it — the option no longer exists.

## Editing the portal

Open the portal from your Home Assistant sidebar and you land on the same page
your guests see, with two extra buttons in the header: **Edit** and **Settings**.
Guests never see either one — for a guest the buttons are absent, not greyed out.

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

### Settings

**Settings** opens a panel over the portal holding three things: the portal's
name, the theme, and the switch that turns the guest side on and off. Each is
described in its own section below. Close the panel when you are done — as with
editing, nothing here needs saving.

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

**Settings** has a **Portal name** field. The name you type appears in the portal
header and in the browser tab, for your guests and for you.

Press Enter, or click outside the field, to save it. Clearing the field restores
the default name, `Guest Portal` — the header is never left blank. Names are
limited to 60 characters.

A guest who already has the portal open keeps the old name until their next page
load. The setting survives add-on restarts and updates.

## Turning the guest portal on and off

Click **Settings** in the portal header. The **Guest Portal** switch at the
bottom of the panel turns the guest side on and off. Turning it off:

- refuses guest logins, even with the correct password
- blocks guests who are already signed in, and drops their live updates
- leaves the portal fully usable for you — you can still edit devices and change
  settings

Guest sessions are blocked, not destroyed. When you turn the portal back on,
anyone who kept their tab open returns automatically without signing in again.

The setting survives add-on restarts and updates.

## Choosing a theme

**Settings** has a **Theme** picker showing three small pictures of the portal.
Click one to change how the guest portal looks. The three are:

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
Your own Edit and Settings panels follow it too — they take their colours from
whichever theme you have chosen, so they never look pasted on top of the portal.

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
**Settings** to name the portal, pick a theme, or turn the guest side off.

### Guest Access via Direct Port

Share the LAN address with your guests: `http://homeassistant.local:9123`. Guests log in with the **guest password** and can control only the devices you've exposed.

**Admins can also use the direct port** by logging in with the admin password instead of the guest password.

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
2. Open the portal from the Home Assistant sidebar (admin access, no password)
3. Click **Edit**, then the **+ Add device** tile at the end of the grid, and
   pick an entity from your Home Assistant instance
4. Tap the new device's tile to give it a friendly name and tick the actions
   guests are allowed to use (e.g. unlock but not lock). Until you tick
   something the device is visible to guests but does nothing
5. Click **Done**. There is no Save button — every change saved as you made it
6. Optionally click **Settings** to name the portal and choose a theme
7. Share the direct port URL and guest password with your guests:
   - URL: `http://homeassistant.local:9123` (or your LAN IP)
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
- **Entity renaming**: If you rename an entity in Home Assistant, the portal's allowlist entry becomes orphaned and the device will appear as unavailable. Edit mode outlines an orphaned tile in red; remove it there and add the device again under its new name.
- **Environment variable exposure**: The Supervisor provides full Core API access to the add-on. Treat add-on configuration access as equivalent to full access to all exposed devices.

## Support

This software is provided as-is. For Home Assistant issues, consult the [Home Assistant documentation](https://www.home-assistant.io/docs/).
