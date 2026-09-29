/**
 * Live-map basemap tiles, proxied from Geoapify (built on OpenStreetMap
 * data). Companion to staticmap.js, and it exists for the SAME reason that
 * file spells out: the app must NOT pull its basemap from OSM's own public
 * tile server. OSM's tile usage policy explicitly forbids app/bulk use, and
 * on real devices those requests get blocked -- the symptom is a live map
 * that draws our own route/stop overlays fine but shows a black void where
 * the streets should be, because every tile request fails. (liveMap.js used
 * to hit tile.openstreetmap.org directly; that's what broke on-device.)
 *
 * Geoapify is a purpose-built tile API whose terms cover exactly this use,
 * with a free tier (3,000 requests/day, no credit card). Tiles are static,
 * so an aggressive server-side cache means the handful of tiles covering the
 * tri-county area at common zoom levels are fetched from Geoapify once and
 * then re-served to every rider for free.
 *
 * Proxied through our own backend (never called from the app directly) so
 * the API key never ships inside the client and can't be scraped from app
 * traffic or a decompiled APK. Entirely optional, same fallback contract as
 * staticmap.js: with no GEOAPIFY_API_KEY configured, fetchTile() returns
 * null and the route answers 503, at which point the client falls back to a
 * keyless basemap rather than showing black (see liveMap.js).
 */
const config = require('./config');

const TILE_BASE = 'https://maps.geoapify.com/v1/tile';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // tiles are static; a week is plenty
const CACHE_MAX_ENTRIES = 3000; // covers the covered counties across common zooms
const cache = new Map(); // "z/x/y" -> { buffer, contentType, expiresAt }

/** Same evict-oldest helper as staticmap.js/geocode.js. */
function cacheSet(map, maxEntries, key, value) {
  if (map.size >= maxEntries && !map.has(key)) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}

/** Slippy-map tile coordinate sanity check: integers, z in [0,20], x/y in [0, 2^z). */
function isValidTileCoord(z, x, y) {
  if (![z, x, y].every(Number.isInteger)) return false;
  if (z < 0 || z > 20) return false;
  const max = 2 ** z;
  return x >= 0 && x < max && y >= 0 && y < max;
}

/**
 * @returns {Promise<{buffer: Buffer, contentType: string} | null>} null
 *   when the feature isn't configured (no GEOAPIFY_API_KEY) -- callers must
 *   treat that as "unavailable" (503), never as an error.
 * @throws on an invalid tile coordinate or an upstream failure.
 */
async function fetchTile(z, x, y) {
  if (!config.geoapifyApiKey) return null;
  if (!isValidTileCoord(z, x, y)) {
    throw new Error(`invalid tile coordinate z/x/y: ${z}/${x}/${y}`);
  }

  const key = `${z}/${x}/${y}`;
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached;

  const style = config.mapTileStyle;
  const url = `${TILE_BASE}/${style}/${z}/${x}/${y}.png?apiKey=${encodeURIComponent(config.geoapifyApiKey)}`;
  const res = await fetch(url, { headers: { 'User-Agent': config.tripPlannerUserAgent } });
  if (!res.ok) throw new Error(`Geoapify tile request failed: HTTP ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'image/png';
  const value = { buffer, contentType, expiresAt: Date.now() + CACHE_TTL_MS };
  cacheSet(cache, CACHE_MAX_ENTRIES, key, value);
  return value;
}

module.exports = { fetchTile, isValidTileCoord, cacheSet };
