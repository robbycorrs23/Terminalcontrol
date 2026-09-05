#!/bin/bash
# Regenerate the PWA icons in client/public/icons/<colour>/ from the FleetView mark.
#
# These are committed artifacts — this script exists so they're reproducible,
# NOT as a build step. Nobody needs to run it to build or run FleetView; run it
# only if the mark or the palette changes.
#
# Needs macOS `sips` (preinstalled). On Linux, swap the `sips` calls for
# `rsvg-convert -w $N -h $N in.svg -o out.png` (librsvg).
#
# WHY A PALETTE: the workspace is per-machine (see pane-registry.js), so you can
# have FleetView installed for several machines at once — and with one icon they
# are indistinguishable on a Home Screen holding real shells. Each machine picks
# a colour with FLEET_ICON_COLOR; the server serves that colour's bytes from the
# stable /icon-*.png URLs, so nothing in the HTML or the manifest has to change.
#
# Why four different compositions per colour instead of one SVG at four sizes:
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
# badge-96 is colour-independent (platforms recolour it) so it stays a single
# monochrome file at the top level.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=client/public/icons
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

LIGHT="#eaf2ff"

# name:background. Kept visually distinct from each other at Home-Screen size —
# that's the entire point, so avoid adding near-neighbours.
PALETTE=(
  "blue:#1f6feb"
  "violet:#8250df"
  "green:#2da44e"
  "amber:#bf8700"
  "red:#cf222e"
  "teal:#0d9488"
)

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

render() { # $1 = svg, $2 = size, $3 = out path
  sips -s format png --resampleHeightWidth "$2" "$2" "$1" --out "$3" >/dev/null
}

for entry in "${PALETTE[@]}"; do
  name="${entry%%:*}"
  bg="${entry#*:}"
  dir="$OUT/$name"
  mkdir -p "$dir"

  # Rounded tile (the favicon.svg composition).
  {
    echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    echo "  <rect x=\"1\" y=\"1\" width=\"30\" height=\"30\" rx=\"6\" fill=\"$bg\"/>"
    squares "$LIGHT"
    echo '</svg>'
  } > "$TMP/plain.svg"

  # Full-bleed, mark scaled to 0.889 about the centre so its DIAGONAL
  # (18*1.414 = 25.5 units) fits inside the maskable safe circle (80% of 32 =
  # 25.6 units). Scaling by area alone isn't enough — it's the corners that get
  # cropped.
  {
    echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    echo "  <rect x=\"0\" y=\"0\" width=\"32\" height=\"32\" fill=\"$bg\"/>"
    echo '  <g transform="translate(16,16) scale(0.889) translate(-16,-16)">'
    squares "$LIGHT"
    echo '  </g>'
    echo '</svg>'
  } > "$TMP/maskable.svg"

  # Full-bleed, square corners — iOS rounds it itself.
  {
    echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    echo "  <rect x=\"0\" y=\"0\" width=\"32\" height=\"32\" fill=\"$bg\"/>"
    squares "$LIGHT"
    echo '</svg>'
  } > "$TMP/apple.svg"

  render "$TMP/plain.svg"    192 "$dir/icon-192.png"
  render "$TMP/plain.svg"    512 "$dir/icon-512.png"
  render "$TMP/maskable.svg" 512 "$dir/icon-maskable-512.png"
  render "$TMP/apple.svg"    180 "$dir/apple-touch-icon.png"
  echo "  $name  $bg"
done

# Monochrome notification badge — one file, no colour variants.
{
  echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
  squares "#ffffff"
  echo '</svg>'
} > "$TMP/badge.svg"
render "$TMP/badge.svg" 96 client/public/badge-96.png
echo "  badge-96.png (colour-independent)"
echo "[icons] done -> $OUT"
