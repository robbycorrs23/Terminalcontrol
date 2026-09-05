#!/bin/bash
# Regenerate the PWA icons in client/public/ from the FleetView mark.
#
# These are committed artifacts — this script exists so they're reproducible,
# NOT as a build step. Nobody needs to run it to build or run FleetView; run it
# only if the mark itself changes.
#
# Needs macOS `sips` (preinstalled). On Linux, swap the `sips` calls for
# `rsvg-convert -w $N -h $N in.svg -o out.png` (librsvg).
#
# Why four different compositions instead of one SVG at four sizes:
#   icon-192/512        rounded tile, transparent outside the corners — the
#                       plain any-purpose icon, shown as-is by most browsers.
#   icon-maskable-512   FULL-BLEED background, mark shrunk into the safe zone.
#                       Android/Chrome crop maskable icons to an arbitrary
#                       shape (circle, squircle, teardrop); anything relying on
#                       transparent corners gets its corners sliced off, and
#                       anything outside the centre 80% circle can be cropped.
#   apple-touch-icon    FULL-BLEED and deliberately NOT pre-rounded. iOS masks
#                       Home Screen icons with its own squircle, so a
#                       pre-rounded source gets rounded twice and shows pale
#                       fringes at the corners.
#   badge-96            Monochrome silhouette. Used for the small status glyph
#                       next to a notification, where the platform recolours it.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=client/public
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

BLUE="#1f6feb"
LIGHT="#eaf2ff"

# The 2x2 grid mark, spanning x/y 7..25 of a 32-unit canvas.
squares() { # $1 = fill
  cat <<EOF
  <g fill="$1">
    <rect x="7" y="7" width="7.5" height="7.5"/>
    <rect x="17.5" y="7" width="7.5" height="7.5"/>
    <rect x="7" y="17.5" width="7.5" height="7.5"/>
    <rect x="17.5" y="17.5" width="7.5" height="7.5"/>
  </g>
EOF
}

# Rounded tile (matches favicon.svg).
{
  echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
  echo "  <rect x=\"1\" y=\"1\" width=\"30\" height=\"30\" rx=\"6\" fill=\"$BLUE\"/>"
  squares "$LIGHT"
  echo '</svg>'
} > "$TMP/plain.svg"

# Full-bleed, mark scaled to 0.889 about the centre so its DIAGONAL (18*1.414 =
# 25.5 units) fits inside the maskable safe circle (80% of 32 = 25.6 units).
# Scaling by area alone isn't enough here — it's the corners that get cropped.
{
  echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
  echo "  <rect x=\"0\" y=\"0\" width=\"32\" height=\"32\" fill=\"$BLUE\"/>"
  echo '  <g transform="translate(16,16) scale(0.889) translate(-16,-16)">'
  squares "$LIGHT"
  echo '  </g>'
  echo '</svg>'
} > "$TMP/maskable.svg"

# Full-bleed, square corners — iOS rounds it itself.
{
  echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
  echo "  <rect x=\"0\" y=\"0\" width=\"32\" height=\"32\" fill=\"$BLUE\"/>"
  squares "$LIGHT"
  echo '</svg>'
} > "$TMP/apple.svg"

# Monochrome silhouette on transparency.
{
  echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
  squares "#ffffff"
  echo '</svg>'
} > "$TMP/badge.svg"

render() { # $1 = svg, $2 = size, $3 = out
  sips -s format png --resampleHeightWidth "$2" "$2" "$1" --out "$OUT/$3" >/dev/null
  echo "  $3  ${2}x${2}"
}

echo "[icons] writing to $OUT"
render "$TMP/plain.svg"    192 icon-192.png
render "$TMP/plain.svg"    512 icon-512.png
render "$TMP/maskable.svg" 512 icon-maskable-512.png
render "$TMP/apple.svg"    180 apple-touch-icon.png
render "$TMP/badge.svg"     96 badge-96.png
echo "[icons] done"
