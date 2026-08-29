#!/usr/bin/env node
/**
 * Inserts the location permissions @capacitor/geolocation requires --
 * its own AAR manifest is deliberately empty (per its README, consuming
 * apps must add these themselves), and `cap add android` regenerates
 * android/app/src/main/AndroidManifest.xml from Capacitor's stock
 * template every time (the whole android/ dir is gitignored), so this
 * has to be reapplied after every `cap add android`, same as the CI
 * signing-config step reapplies after every build.gradle regeneration.
 * Idempotent -- safe to run more than once.
 */
const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

if (!fs.existsSync(manifestPath)) {
  console.error(`[patch-android-manifest] ${manifestPath} not found -- run \`cap add android\` first.`);
  process.exit(1);
}

const PERMISSIONS = `    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-feature android:name="android.hardware.location.gps" android:required="false" />
`;

let manifest = fs.readFileSync(manifestPath, 'utf8');

if (manifest.includes('ACCESS_FINE_LOCATION')) {
  console.log('[patch-android-manifest] location permissions already present, skipping.');
  process.exit(0);
}

const marker = '    <uses-permission android:name="android.permission.INTERNET" />';
if (!manifest.includes(marker)) {
  console.error('[patch-android-manifest] expected INTERNET permission line not found -- Capacitor\'s template may have changed, update this script\'s marker.');
  process.exit(1);
}

manifest = manifest.replace(marker, `${PERMISSIONS}${marker}`);
fs.writeFileSync(manifestPath, manifest);
console.log('[patch-android-manifest] added ACCESS_COARSE_LOCATION / ACCESS_FINE_LOCATION / location.gps feature.');
