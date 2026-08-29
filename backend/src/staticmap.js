/**
 * Renders a small static map image (a PNG, centered on one lat/lon with
 * a marker) for a single stop or landmark answer, via Geoapify's Static
 * Maps API -- built on OpenStreetMap data. Free tier: 3,000 requests/
 * day, no credit card (https://www.geoapify.com/pricing/, checked
 * 2026-08-28).
 *
 * Deliberately NOT built by bulk-downloading tiles from OSM's own public
 * tile server (the same server liveMap.js's Leaflet view already talks
 * to live, from each rider's own device -- that's normal, sanctioned
 * single-viewer use). Rendering many map IMAGES server-side and caching/
 * re-serving them to every app user is a different usage pattern, closer
 * to the "systematic/bulk" use OSM's tile policy is written to prevent
 * -- Geoapify is a purpose-built static-map API with its own terms that
 * actually cover this, rather than stretching a policy meant for
 * something else.
 *
 * Proxied through our backend (never called directly from the app) so
 * the API key never ships inside the client and can't be extracted from
 * app traffic or a decompiled APK to drain the free-tier quota.
 *
 * Entirely optional: with no GEOAPIFY_API_KEY configured, fetchStaticMap
 * always returns null and the client just shows a text-only answer,
 * exactly like before this feature existed -- same fallback pattern as
 * enrich.js's GROQ_API_KEY.
 */
const config = require('./config');

const STATICMAP_BASE = 'https://maps.geoapify.com/v1/staticmap';
const IMAGE_WIDTH = 400;
const IMAGE_HEIGHT = 240;
const ZOOM = 15;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // landmarks/stops don't move
const CACHE_MAX_ENTRIES = 500; // same cap rationale as geocode.js's cache
const cache = new Map(); // "lat,lon" (rounded) -> { buffer, contentType, expiresAt }

/** Inserts into `map`, evicting the oldest entry first if already at `maxEntries`. Same helper as geocode.js's cacheSet -- kept as a separate local copy rather than shared, since these two caches hold structurally different values and sharing a generic utility for two call sites isn't worth the indirection. */
function cacheSet(map, maxEntries, key, value) {
  if (map.size >= maxEntries && !map.has(key)) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}

/** Rounds to ~11m precision -- enough that two lookups for "the same place" reliably share a cache entry, without caching so coarsely that distinct nearby stops collide. */
function cacheKey(lat, lon) {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

/**
 * @returns {Promise<{buffer: Buffer, contentType: string} | null>} null
 *   if the feature isn't configured (no API key) -- callers must treat
 *   that the same as "unavailable," never as an error.
 */
async function fetchStaticMap(lat, lon) {
  if (!config.geoapifyApiKey) return null;

  const key = cacheKey(lat, lon);
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached;

  const url = new URL(STATICMAP_BASE);
  url.searchParams.set('style', 'osm-carto');
  url.searchParams.set('width', String(IMAGE_WIDTH));
  url.searchParams.set('height', String(IMAGE_HEIGHT));
  url.searchParams.set('center', `lonlat:${lon},${lat}`);
  url.searchParams.set('zoom', String(ZOOM));
  url.searchParams.set('marker', `lonlat:${lon},${lat};color:%2333ff00;size:medium`);
  url.searchParams.set('apiKey', config.geoapifyApiKey);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geoapify static map request failed: HTTP ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'image/png';
  const value = { buffer, contentType, expiresAt: Date.now() + CACHE_TTL_MS };
  cacheSet(cache, CACHE_MAX_ENTRIES, key, value);
  return value;
}

module.exports = { fetchStaticMap, cacheSet };
