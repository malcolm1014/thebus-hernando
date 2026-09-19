/**
 * This app has no bundler (see frontend/www/js/geolocate.js's own doc
 * comment) -- every other native plugin is reached straight off
 * `Capacitor.Plugins.<Name>`, which Capacitor's runtime auto-populates
 * for ANY registered native plugin whether or not its JS/web package is
 * ever imported. This file exists only so `capacitor-valhalla-routing`
 * is a structurally valid npm/Capacitor plugin package (a `main` entry
 * Capacitor's tooling can resolve); nothing in this app actually
 * requires it. There is no web implementation -- Valhalla only runs
 * on-device via the native Android plugin, so every method here just
 * rejects until Capacitor's native bridge swaps in the real
 * implementation on Android.
 */
const { registerPlugin } = require('@capacitor/core');

const ValhallaRouting = registerPlugin('ValhallaRouting');

module.exports = { ValhallaRouting };
