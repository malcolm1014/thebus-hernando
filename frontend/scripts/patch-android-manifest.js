#!/usr/bin/env node
/**
 * Inserts the extra permissions our plugins need into Android's manifest:
 *   - ACCESS_COARSE/FINE_LOCATION (+ gps feature) for @capacitor/geolocation
 *     (its own AAR manifest is deliberately empty -- per its README,
 *     consuming apps must add these themselves).
 *   - POST_NOTIFICATIONS for @capacitor/local-notifications on Android 13+
 *     (service-alert notifications for followed routes).
 *
 * `cap add android` regenerates android/app/src/main/AndroidManifest.xml
 * from Capacitor's stock template every time (the whole android/ dir is
 * gitignored), so this has to be reapplied after every `cap add android`,
 * same as the CI signing-config step reapplies after every build.gradle
 * regeneration. Idempotent -- safe to run more than once, and it only adds
 * the lines that are actually missing.
 */
const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

if (!fs.existsSync(manifestPath)) {
  console.error(`[patch-android-manifest] ${manifestPath} not found -- run \`cap add android\` first.`);
  process.exit(1);
}

let manifest = fs.readFileSync(manifestPath, 'utf8');

const marker = '    <uses-permission android:name="android.permission.INTERNET" />';
if (!manifest.includes(marker)) {
  console.error('[patch-android-manifest] expected INTERNET permission line not found -- Capacitor\'s template may have changed, update this script\'s marker.');
  process.exit(1);
}

// Each line is inserted before the INTERNET marker only if its `test`
// string isn't already in the manifest -- so this is idempotent and can be
// extended one entry at a time.
const LINES = [
  { test: 'ACCESS_COARSE_LOCATION', xml: '    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />' },
  { test: 'ACCESS_FINE_LOCATION', xml: '    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />' },
  { test: 'android.hardware.location.gps', xml: '    <uses-feature android:name="android.hardware.location.gps" android:required="false" />' },
  { test: 'POST_NOTIFICATIONS', xml: '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />' },
];

const toAdd = LINES.filter((l) => !manifest.includes(l.test));
if (toAdd.length === 0) {
  console.log('[patch-android-manifest] all permissions already present, skipping.');
  process.exit(0);
}

manifest = manifest.replace(marker, `${toAdd.map((l) => l.xml).join('\n')}\n${marker}`);
fs.writeFileSync(manifestPath, manifest);
console.log(`[patch-android-manifest] added: ${toAdd.map((l) => l.test).join(', ')}.`);
