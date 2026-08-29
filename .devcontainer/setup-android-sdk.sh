#!/usr/bin/env bash
# Installs just enough of the Android SDK to run `cap add android` and a
# real Gradle build (assembleDebug / bundleRelease) inside this
# Codespace -- command-line only, no emulator/AVD (this devcontainer
# doesn't have the hardware acceleration an Android emulator needs to
# run at a usable speed; use a real phone for on-device testing, see
# ../MANUAL_TEST_SCRIPT.md).
set -euo pipefail

SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
CMDLINE_TOOLS_VERSION="11076708" # https://developer.android.com/studio#command-line-tools-only -- re-check if this 404s, Google doesn't keep a stable "latest" URL

mkdir -p "$SDK_ROOT/cmdline-tools"
cd /tmp
curl -sSL -o cmdline-tools.zip "https://dl.google.com/android/repo/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip"
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
