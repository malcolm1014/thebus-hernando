#!/usr/bin/env node
/**
 * Bumps minSdkVersion from Capacitor's stock template default (22) to
 * 24 -- required by io.github.rallista:valhalla-mobile (the on-device
 * routing engine, see plugins/valhalla-routing), whose own AAR declares
 * minSdk 24 and would otherwise fail the manifest merge with a
 * confusing downstream Gradle error instead of a clear one here.
 * `cap add android` regenerates android/variables.gradle from
 * Capacitor's template every time (the whole android/ dir is
 * gitignored), so this has to be reapplied after every run, same as
 * patch-android-manifest.js. Idempotent -- safe to run more than once.
 *
 * Android 7.0 (API 24) was released 2016 and is a negligible slice of
 * active devices at this point -- a real, disclosed tradeoff, not a
 * default nobody considered.
 */
const fs = require('fs');
const path = require('path');

const variablesPath = path.join(__dirname, '..', 'android', 'variables.gradle');

if (!fs.existsSync(variablesPath)) {
  console.error(`[patch-min-sdk] ${variablesPath} not found -- run \`cap add android\` first.`);
  process.exit(1);
}

let variables = fs.readFileSync(variablesPath, 'utf8');

const oldLine = 'minSdkVersion = 22';
const newLine = 'minSdkVersion = 24';

if (variables.includes(newLine)) {
  console.log('[patch-min-sdk] minSdkVersion already 24, skipping.');
  process.exit(0);
}
if (!variables.includes(oldLine)) {
  console.error(`[patch-min-sdk] expected "${oldLine}" not found -- Capacitor's template may have changed, update this script.`);
  process.exit(1);
}

variables = variables.replace(oldLine, newLine);
fs.writeFileSync(variablesPath, variables);
console.log('[patch-min-sdk] minSdkVersion bumped 22 -> 24 for valhalla-mobile compatibility.');
