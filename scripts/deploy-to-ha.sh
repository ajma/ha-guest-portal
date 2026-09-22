#!/usr/bin/env bash
set -euo pipefail

# Pushes this repo to the Home Assistant Supervisor's addons Samba share, so
# Supervisor picks it up as a local add-on (see README.md "Home Assistant
# Add-On" install steps). Uses smbclient directly rather than a local mount.
#
# Config comes from environment variables, optionally loaded from
# scripts/.env.deploy (gitignored, see scripts/.env.deploy.example):
#   HA_SMB_HOST   HA host/IP running the Samba share add-on
#   HA_SMB_USER   Samba username
#   HA_SMB_PASS   Samba password
#   HA_SMB_SHARE  share name (default: addons)
#   HA_ADDON_DIR  target folder name under the share (default: ha-guest-portal)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/scripts/.env.deploy"
# The file is gitignored and absent at lint time, so shellcheck cannot follow
# it; the directive silences SC1090 for this line only.
# shellcheck source=/dev/null
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

: "${HA_SMB_HOST:?Set HA_SMB_HOST (HA host/IP)}"
: "${HA_SMB_USER:?Set HA_SMB_USER}"
: "${HA_SMB_PASS:?Set HA_SMB_PASS}"
HA_SMB_SHARE="${HA_SMB_SHARE:-addons}"
HA_ADDON_DIR="${HA_ADDON_DIR:-ha-guest-portal}"

command -v smbclient >/dev/null || { echo "smbclient not found (install samba-client / smbclient)" >&2; exit 1; }

STAGE_DIR="$(mktemp -d)"
FILE_LIST="$(mktemp)"
trap 'rm -rf "$STAGE_DIR" "$FILE_LIST"' EXIT

# Stage only files git would track (tracked + untracked-but-not-ignored), so
# node_modules, dist, .env, and local *.db files never leave this machine.
cd "$REPO_ROOT"
git ls-files --cached --others --exclude-standard -z > "$FILE_LIST"
rsync -a --from0 --files-from="$FILE_LIST" "$REPO_ROOT/" "$STAGE_DIR/"

echo "Staged $(find "$STAGE_DIR" -type f | wc -l) files"

# PASSWD avoids putting the password on the command line (visible via ps).
PASSWD="$HA_SMB_PASS" smbclient "//${HA_SMB_HOST}/${HA_SMB_SHARE}" -U "$HA_SMB_USER" -c "
  prompt off;
  recurse on;
  mkdir ${HA_ADDON_DIR};
  cd ${HA_ADDON_DIR};
  lcd ${STAGE_DIR};
  mput *
"

echo "Deployed to //${HA_SMB_HOST}/${HA_SMB_SHARE}/${HA_ADDON_DIR}"
echo "In Home Assistant: Settings > Add-ons > (bottom right) Check for updates, then reinstall/restart the add-on."
