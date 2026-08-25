/**
 * Loads the browser-style IIFE modules (intentParser.js, queryEngine.js,
 * etc.) into Node's global scope so they can run under `node --test`.
 * These files were only ever verified via one-off manual `node -e` runs
 * during development -- this makes that verification permanent and
 * repeatable instead of relying on memory of "I checked this earlier."
 *
 * Uses the REAL Node `global` object as `window` (not a fresh per-call
 * stub) -- each module does `global.TheBusFoo = {...}` where `global`
 * is the IIFE's own parameter bound to `window`, so a stub object would
 * break any later-loaded module's bare reference to an earlier one
 * (e.g. queryEngine.js calling `TheBusIntentParser.parseQuery(...)` as
 * a bare identifier, which only resolves via the process's real global
 * scope chain). This is safe here because `node --test` runs each test
 * FILE in its own separate process by default, so this never leaks
 * between files.
 */
const fs = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', 'www', 'js');

global.window = global;
if (!global.navigator) global.navigator = { onLine: true };

/** Loads one or more modules (by filename in www/js/) by evaluating them against the real Node global object. */
function loadModules(...filenames) {
  for (const filename of filenames) {
    const code = fs.readFileSync(path.join(JS_DIR, filename), 'utf8');
    // eslint-disable-next-line no-eval
    eval(code);
  }
}

/** A small, fully self-contained mock dataset -- same shape transform.js produces -- so these tests never depend on the live backend or the real Hernando feed. */
function buildMockDataset(overrides = {}) {
  return {
    version: 'test',
    generatedAt: new Date().toISOString(),
    agencyTimezone: 'America/New_York',
    services: {
      WEEKDAY: { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false, startDate: '20260101', endDate: '20261231', addedDates: [], removedDates: [] },
    },
    routes: {
      R1: { id: 'R1', shortName: '', longName: 'Route 1 Red', color: '#ff0000', textColor: null, stopIds: ['S1', 'S2'], shapePoints: [] },
      R2: { id: 'R2', shortName: '', longName: 'Blue', color: '#0000ff', textColor: null, stopIds: ['S1'], shapePoints: [] },
    },
    stops: {
      S1: {
        id: 'S1', name: 'Avalon Publix', lat: 28.50, lon: -82.60,
        routes: [
          {
            routeId: 'R1', shortName: '', longName: 'Route 1 Red', color: '#ff0000',
            arrivals: [
              { tripId: 'T1', serviceId: 'WEEKDAY', headsign: 'Downtown', minutes: 8 * 60 },
              { tripId: 'T2', serviceId: 'WEEKDAY', headsign: 'Downtown', minutes: 9 * 60 },
              { tripId: 'T3', serviceId: 'WEEKDAY', headsign: 'Downtown', minutes: 19 * 60 + 27 }, // last bus of the day
            ],
          },
          {
            routeId: 'R2', shortName: '', longName: 'Blue', color: '#0000ff',
            arrivals: [], // real-world case: served, but no published times for this stop (non-timepoint)
          },
        ],
      },
      S2: {
        id: 'S2', name: 'Pine Island Park', lat: 28.60, lon: -82.70,
        routes: [{ routeId: 'R1', shortName: '', longName: 'Route 1 Red', color: '#ff0000', arrivals: [] }],
      },
      // Two near-duplicate names sharing most words -- a real pattern in
      // Hernando's own data ("US19 Pine Forest Dr N/W" vs "N/E") -- to
      // exercise the disambiguation-on-tie behavior.
      S3: { id: 'S3', name: 'Spring Hill Dr North', lat: 28.51, lon: -82.61, routes: [] },
      S4: { id: 'S4', name: 'Spring Hill Dr South', lat: 28.49, lon: -82.61, routes: [] },
    },
    ...overrides,
  };
}

module.exports = { loadModules, buildMockDataset };
