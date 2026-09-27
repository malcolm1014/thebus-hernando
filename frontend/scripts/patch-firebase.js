#!/usr/bin/env node
/**
 * Wires Firebase Cloud Messaging into the generated Android project so
 * @capacitor/push-notifications can deliver server pushes (followed-route
 * service alerts -- see backend/src/push.js).
 *
 * Reads the google-services.json contents from the GOOGLE_SERVICES_JSON env
 * var (a GitHub Actions secret) and:
 *   1. writes android/app/google-services.json, and
 *   2. ensures the Gradle wiring exists -- the google-services classpath in
 *      the project build.gradle and the conditional `apply plugin` in the
 *      app build.gradle. Capacitor 6 already scaffolds both by default, so
 *      those are usually no-ops; this is belt-and-suspenders in case the
 *      template varies.
 *
 * NO-OP when GOOGLE_SERVICES_JSON is unset: prints a note and exits 0, so a
 * build without Firebase configured is completely unaffected (push simply
 * stays inert, exactly as before). `cap add android` regenerates android/
 * every run (it's gitignored), so this reapplies each build -- same pattern
 * as patch-android-manifest.js / patch-min-sdk.js. Idempotent.
 */
const fs = require('fs');
const path = require('path');

const raw = process.env.GOOGLE_SERVICES_JSON;
if (!raw || !raw.trim()) {
  console.log('[patch-firebase] GOOGLE_SERVICES_JSON not set -- skipping (push notifications stay inert).');
  process.exit(0);
}

const androidDir = path.join(__dirname, '..', 'android');
const appDir = path.join(androidDir, 'app');
if (!fs.existsSync(appDir)) {
  console.error(`[patch-firebase] ${appDir} not found -- run \`cap add android\` first.`);
  process.exit(1);
}

// 1) Validate + write google-services.json.
try {
  JSON.parse(raw);
} catch (e) {
  console.error('[patch-firebase] GOOGLE_SERVICES_JSON is not valid JSON:', e.message);
  process.exit(1);
}
fs.writeFileSync(path.join(appDir, 'google-services.json'), raw);
console.log('[patch-firebase] wrote android/app/google-services.json.');

const GOOGLE_SERVICES_VERSION = '4.4.2';

// 2a) Project-level build.gradle: ensure the google-services classpath.
const projectGradlePath = path.join(androidDir, 'build.gradle');
if (fs.existsSync(projectGradlePath)) {
  let g = fs.readFileSync(projectGradlePath, 'utf8');
  if (g.includes('com.google.gms:google-services')) {
    console.log('[patch-firebase] google-services classpath already present in project build.gradle.');
  } else {
    const marker = /(classpath\s+['"]com\.android\.tools\.build:gradle[^'"]*['"])/;
    if (marker.test(g)) {
      g = g.replace(marker, `$1\n        classpath 'com.google.gms:google-services:${GOOGLE_SERVICES_VERSION}'`);
      fs.writeFileSync(projectGradlePath, g);
      console.log('[patch-firebase] added google-services classpath to project build.gradle.');
    } else {
      console.warn('[patch-firebase] could not find the Android Gradle classpath line to anchor to -- relying on Capacitor\'s own classpath.');
    }
  }
}

// 2b) App-level build.gradle: ensure the google-services plugin is applied.
const appGradlePath = path.join(appDir, 'build.gradle');
let a = fs.readFileSync(appGradlePath, 'utf8');
if (a.includes('com.google.gms.google-services')) {
  console.log('[patch-firebase] google-services plugin already applied in app build.gradle.');
} else {
  a += `\n// Added by patch-firebase.js -- apply the google-services plugin only when the config file is present.\ntry {\n    def servicesJSON = file('google-services.json')\n    if (servicesJSON.text) {\n        apply plugin: 'com.google.gms.google-services'\n    }\n} catch (Exception e) {\n    logger.info("google-services.json not found, google-services plugin not applied.")\n}\n`;
  fs.writeFileSync(appGradlePath, a);
  console.log('[patch-firebase] appended conditional google-services plugin apply to app build.gradle.');
}
