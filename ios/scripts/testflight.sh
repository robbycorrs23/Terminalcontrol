#!/usr/bin/env bash
# Archive FleetView for iOS and upload it to TestFlight.
#   ios/scripts/testflight.sh            # test, archive, upload
#   ios/scripts/testflight.sh --no-upload  # same, but export the .ipa locally only
#
# Signing: the archive uses automatic signing (development), the export uses the
# "FleetView App Store" profile + the local Apple Distribution certificate —
# the API key can't use Apple's cloud-managed distribution cert ("Cloud signing
# permission error"), same as the other projects' TestFlight scripts.
# Build number = a timestamp, so every upload is unique and increasing.
set -euo pipefail

KEY_ID="${ASC_KEY_ID:-63H63G924B}"
ISSUER_ID="${ASC_ISSUER_ID:-e26181bd-b05f-4e5a-a43c-d20bd728bc26}"
KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8}"
AUTH=(-authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER_ID")

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${FLEET_IOS_WORK:-$(mktemp -d)}"
mkdir -p "$WORK"
BUILD_NUMBER="$(date +%Y%m%d%H%M)"
DEST="upload"
[ "${1:-}" = "--no-upload" ] && DEST="export"

cd "$ROOT"
xcodegen generate --quiet

cat > "$WORK/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$DEST</string>
  <key>teamID</key><string>Z778754952</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>com.robertcorrado.fleetview</key><string>FleetView App Store</string>
  </dict>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST

SIM="$(xcrun simctl list devices available | grep -m1 -oE 'iPhone [0-9]+ Pro \(([0-9A-F-]+)\)' | grep -oE '[0-9A-F-]{36}' || true)"
if [ -n "$SIM" ] && [ "${SKIP_TESTS:-0}" != "1" ]; then
  echo "==> Testing (needs this Mac's FleetView on 127.0.0.1:4280)"
  xcodebuild -project FleetView.xcodeproj -scheme FleetView -destination "id=$SIM" \
    -derivedDataPath "$WORK/dd" -quiet test
fi

echo "==> Archiving build $BUILD_NUMBER"
xcodebuild -project FleetView.xcodeproj -scheme FleetView -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$WORK/dd" \
  -archivePath "$WORK/FleetView.xcarchive" -allowProvisioningUpdates "${AUTH[@]}" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" -quiet archive

echo "==> Exporting ($DEST)"
xcodebuild -exportArchive -archivePath "$WORK/FleetView.xcarchive" \
  -exportOptionsPlist "$WORK/ExportOptions.plist" -exportPath "$WORK/export" "${AUTH[@]}"

if [ "$DEST" = "upload" ]; then
  echo "==> Uploaded build $BUILD_NUMBER. It appears in TestFlight once Apple finishes processing (usually 5-15 min)."
else
  echo "==> Exported to $WORK/export"
fi
