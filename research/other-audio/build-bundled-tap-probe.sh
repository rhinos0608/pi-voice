#!/bin/sh
# build-bundled-tap-probe.sh — Build the .app-bundle variant of the tap probe
# and launch it so the owner can test the "bundled tap" research claim.
#
# Claim under test: a minimal .app bundle carrying
# NSAudioCaptureUsageDescription, launched via LaunchServices (`open -W -n`),
# becomes its own responsible process and gets a proper audio-capture prompt —
# unlike a bare CLI whose terminal bundle lacks the usage description (which
# reportedly yields silent all-zero buffers).
#
# What this script does:
#   1. Compiles tap-probe.swift into TapProbe.app/Contents/MacOS/tap-probe.
#   2. Writes Info.plist with CFBundleIdentifier local.pi-voice.tap-probe and
#      NSAudioCaptureUsageDescription.
#   3. Ad-hoc codesigns the bundle (required for LaunchServices to treat it
#      as a real app identity for TCC).
#   4. Launches it with `open -W -n` (waits for exit). The app writes its
#      stats to a per-run text file inside the bundle root (stdout is
#      invisible under `open`), which this script then prints.
#
# The owner must be playing a video at normal volume while this runs.
# Running the app WILL show an audio-capture permission prompt on first use.
#
# Usage:
#   sh research/other-audio/build-bundled-tap-probe.sh [--duration 10]
#
# Do NOT run this from CI/SSH — it opens UI on the owner's screen.

set -eu

DURATION="10"
for arg in "$@"; do
  case "$arg" in
    --duration=*) DURATION="${arg#--duration=}" ;;
    --duration) echo "use --duration=N" >&2; exit 2 ;;
    -h|--help) sed -n '1,27p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_ROOT="$(mktemp -d -t tap-probe-bundle)"
APP_DIR="$BUNDLE_ROOT/TapProbe.app"
CONTENTS="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS/MacOS"
PLIST="$CONTENTS/Info.plist"
BIN="$MACOS_DIR/tap-probe"
STATS_FILE="$BUNDLE_ROOT/tap-probe-stats-$$.txt"

echo "== build: compiling TapProbe.app =="
echo "bundle root (owned by this run): $BUNDLE_ROOT"
mkdir -p "$MACOS_DIR"
xcrun swiftc -O "$HERE/tap-probe.swift" -o "$BIN"
echo "compiled: $BIN"

cat > "$PLIST" <<'PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>tap-probe</string>
	<key>CFBundleIdentifier</key>
	<string>local.pi-voice.tap-probe</string>
	<key>CFBundleName</key>
	<string>TapProbe</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>LSMinimumSystemVersion</key>
	<string>14.2</string>
	<key>NSAudioCaptureUsageDescription</key>
	<string>TapProbe captures system audio playback for 10 seconds to measure whether process taps deliver a signal (pi-voice research probe).</string>
</dict>
</plist>
PLIST_EOF
echo "wrote: $PLIST"

/usr/bin/codesign --force -s - "$APP_DIR"
echo "ad-hoc codesigned."

# `open` cannot pass argv or environment to the app, and stdout is invisible
# under `open`, so CFBundleExecutable is a tiny wrapper that execs the real
# binary with --duration/--stats-file baked in. The real binary writes its
# report to $STATS_FILE, which this script prints after `open -W` returns.
mv "$BIN" "$MACOS_DIR/tap-probe.real"
cat > "$BIN" <<WRAPPER_EOF
#!/bin/sh
exec "$MACOS_DIR/tap-probe.real" --duration "$DURATION" --stats-file "$STATS_FILE"
WRAPPER_EOF
chmod +x "$BIN"
/usr/bin/codesign --force -s - "$APP_DIR"

echo "== run: start a video at normal volume NOW, then press Enter =="
echo "The app will run ~${DURATION}s and may show an audio-capture prompt."
# shellcheck disable=SC2034
read -r _ < /dev/tty || true

/usr/bin/open -W -n "$APP_DIR"

echo "== stats ($STATS_FILE) =="
cat "$STATS_FILE"

echo "== cleanup =="
echo "inspect: $APP_DIR"
echo "to remove this run's bundle (stats file included):"
echo "rm -rf \"$BUNDLE_ROOT\""
