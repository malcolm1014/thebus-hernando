#!/usr/bin/env node
/**
 * Bumps minSdkVersion/compileSdkVersion/targetSdkVersion in
 * android/variables.gradle from Capacitor's stock template defaults
 * (22/34/34) to what io.github.rallista:valhalla-mobile 0.6.3 (the
 * on-device routing engine, see plugins/valhalla-routing) actually
 * requires:
 *   - minSdk 26: valhalla-mobile's own AAR manifest declares this.
 *   - compileSdk/targetSdk 36: valhalla-mobile's AAR metadata REQUIRES
 *     consumers to compile against API 36+ (a hard `checkDebugAarMetadata`
 *     failure below that version, not just a lint warning).
 * `cap add android` regenerates android/variables.gradle from
 * Capacitor's template every time (the whole android/ dir is
 * gitignored), so this has to be reapplied after every run, same as
 * patch-android-manifest.js. Idempotent -- safe to run more than once.
 *
 * Real, verified consequences of this bump (see docs/valhalla-routing.md):
 * AGP 8.2.1 only warns (doesn't fail) building against compileSdk 36
 * even though it's newer than AGP 8.2.1 was tested against; and API 36
 * needs its SDK platform license accepted before Gradle can auto-
 * download it (see build-apk.yml's own license-acceptance step).
 * Android 8.0 (API 26, 2017) as the new minSdk floor is a negligible
 * slice of active devices at this point -- a real, disclosed tradeoff.
 */
const fs = require('fs');
const path = require('path');

const variablesPath = path.join(__dirname, '..', 'android', 'variables.gradle');

if (!fs.existsSync(variablesPath)) {
  console.error(`[patch-min-sdk] ${variablesPath} not found -- run \`cap add android\` first.`);
  process.exit(1);
}

let variables = fs.readFileSync(variablesPath, 'utf8');

const REPLACEMENTS = [
  ['minSdkVersion = 22', 'minSdkVersion = 26'],
  ['compileSdkVersion = 34', 'compileSdkVersion = 36'],
  ['targetSdkVersion = 34', 'targetSdkVersion = 36'],
];

const alreadyDone = REPLACEMENTS.every(([, after]) => variables.includes(after));
if (alreadyDone) {
  console.log('[patch-min-sdk] SDK versions already bumped, skipping.');
  process.exit(0);
}

for (const [before, after] of REPLACEMENTS) {
  if (variables.includes(after)) continue; // this one already applied
  if (!variables.includes(before)) {
    console.error(`[patch-min-sdk] expected "${before}" not found -- Capacitor's template may have changed, update this script.`);
    process.exit(1);
  }
  variables = variables.replace(before, after);
}

fs.writeFileSync(variablesPath, variables);
console.log('[patch-min-sdk] minSdk/compileSdk/targetSdk bumped for valhalla-mobile 0.6.3 compatibility.');
