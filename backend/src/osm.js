const fs = require('fs');
const path = require('path');

/**
 * Loads the pre-filtered OpenStreetMap extract for the tri-county
 * service area (Hernando/Pasco/Hillsborough, plus Citrus once its own
 * GTFS feed is reachable -- see config.js) -- named roads and
 * businesses/POIs, committed to the repo at data/osm-source/*.json.
 *
 * Unlike GTFS, this is NOT re-fetched on every ETL run: the source is a
 * full-state OSM extract (~600MB from Geofabrik), far too heavy to pull
 * on every cron tick for data that changes on the order of months, not
 * daily. Instead scripts/refresh-osm-data.sh is a periodic MANUAL job
 * (run wherever osmium-tool is available -- Render's Node buildpack
 * doesn't have it, and installing a native binary dependency there just
 * to re-derive slowly-changing data isn't worth it) that regenerates
 * the two committed JSON files; this function just reads whatever was
 * last committed. Missing files mean "no OSM data yet, or the feature
 * was never set up" -- never a fatal error, exactly like every other
 * optional enrichment in this backend (Groq aliases, Geoapify maps,
 * Grok rephrasing -- see config.js's own doc comments on that pattern).
 *
 * ODbL ATTRIBUTION: this data is (c) OpenStreetMap contributors, ODbL-
 * licensed -- credited in the app's HELP/ABOUT text (queryEngine.js)
 * and PRIVACY_POLICY.md. Keep that credit if you fork this.
 */
const PLACES_PATH = path.join(__dirname, '..', 'data', 'osm-source', 'places.json');
const ROADS_PATH = path.join(__dirname, '..', 'data', 'osm-source', 'roads.json');

function readJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`[osm] failed to read ${filePath}: ${err.message}`);
    return [];
  }
}

/**
 * @param {{placesPath?: string, roadsPath?: string}} [paths] - override
 *   the default committed-data locations; only ever used by tests.
 * @returns {{places: object, roads: object}} keyed by id, matching
 *   stops/routes' own dict shape (see transform.js's mergeAgencyData).
 */
function loadOsmExtract(paths = {}) {
  const places = readJsonArray(paths.placesPath || PLACES_PATH);
  const roads = readJsonArray(paths.roadsPath || ROADS_PATH);
  return {
    places: Object.fromEntries(places.map((p) => [p.id, p])),
    roads: Object.fromEntries(roads.map((r) => [r.id, r])),
  };
}

module.exports = { loadOsmExtract, PLACES_PATH, ROADS_PATH };
