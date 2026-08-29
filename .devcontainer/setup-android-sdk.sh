#!/usr/bin/env bash
# Installs just enough of the Android SDK to run `cap add android` and a
# real Gradle build (assembleDebug / bundleRelease) inside this
# Codespace -- command-line only, no emulator/AVD (this devcontainer
# doesn't have the hardware acceleration an Android emulator needs to
# run at a usable speed; use a real phone for on-device testing, see
# ../MANUAL_TEST_SCRIPT.md).
set -euo pipefail

SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
# https://developer.android.com/studio#command-line-tools-only -- Google
# doesn't keep a stable "latest" URL, so this WILL go stale; if it 404s,
# get the current version+base-path pair from the authoritative manifest:
#   curl -sSL https://dl.google.com/android/repository/repository2-3.xml \
#     | grep -o 'commandlinetools-linux-[0-9]*_latest.zip' | sort -u | tail -1
# (note the base path is /android/repository/, NOT /android/repo/ -- the
# devsite download page and some docs link the wrong one)
CMDLINE_TOOLS_VERSION="16111833"

mkdir -p "$SDK_ROOT/cmdline-tools"
cd /tmp
curl -fsSL -o cmdline-tools.zip "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip"
unzip -q cmdline-tools.zip
# The zip's own top-level folder is named "cmdline-tools" -- sdkmanager
# expects it nested one level deeper, at cmdline-tools/latest/, or every
# tool inside silently looks for the SDK in the wrong place.
mv cmdline-tools "$SDK_ROOT/cmdline-tools/latest"
rm cmdline-tools.zip

SDKMANAGER="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
yes | "$SDKMANAGER" --licenses > /dev/null
"$SDKMANAGER" --install \
  "platform-tools" \
  "platforms;android-34" \
  "platforms;android-35" \
  "build-tools;34.0.0" \
  "build-tools;35.0.0"

echo "export PATH=\"\$PATH:$SDK_ROOT/cmdline-tools/latest/bin:$SDK_ROOT/platform-tools\"" >> "$HOME/.bashrc"

echo "Android SDK ready at $SDK_ROOT"
