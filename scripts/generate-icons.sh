#!/usr/bin/env bash
# Regenerates the PWA icons from brand/icon.png.
#
# The output is COMMITTED and this is not run by the build: the production
# image is built by Docker, which cannot be assumed to have ImageMagick, and a
# build step that quietly produced no icons would leave the app uninstallable
# with every check green.
#
# The 512 is an upscale from a 256 source and will be slightly soft. Replace
# brand/icon.png with a larger original if that ever matters.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p public/icons
convert brand/icon.png -resize 192x192 public/icons/icon-192.png
convert brand/icon.png -resize 512x512 public/icons/icon-512.png

# Maskable: Android crops to a circle and clips ~10% off each edge, so the
# artwork is inset onto a full-bleed background rather than run to the edge.
convert brand/icon.png -resize 410x410 \
  -background '#fafafa' -gravity center -extent 512x512 \
  public/icons/icon-maskable-512.png

echo "wrote public/icons/"
