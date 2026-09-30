/**
 * Live vehicle positions for HART (Hillsborough Area Regional Transit,
 * Tampa) via Swiftly's official, key-authenticated real-time API.
 *
 * Endpoint choice -- the GTFS-rt vehicle-positions feed, NOT Swiftly's
 * `/vehicles` JSON endpoint:
 * Swiftly exposes live vehicle data two ways, and they are licensed
 * SEPARATELY. Our API key's grant (per the Swiftly onboarding email) covers
 * the GTFS-realtime feeds -- "GTFS-rt: vehicle positions", trip updates, and
 * alerts -- and nothing else. The plain-JSON `/real-time/{agency}/vehicles`
 * endpoint is a DIFFERENT Swiftly product (their "Real-time API"), which the
 * key is NOT authorized for: hitting it returned HTTP 403 "Permission
 * Denied" for every poll (confirmed via /api/live-status) even though the
 * agency key ('tampa') and auth were correct -- alerts on the same key work
 * fine. So we use the licensed `gtfs-rt-vehicle-positions` feed instead.
 *
 * We request Swiftly's JSON serialization (`?format=json`) of the standard
 * GTFS-Realtime FeedMessage -- exactly like swiftlyGtfsRt.js does for
 * alerts/trip-updates -- so there's NO protobuf dependency and the shape is
 * the published GTFS-rt spec rather than a vendor guess. Protobuf<->JSON
 * field names are canonically camelCase (vehicle, position, latitude,
 * routeId, ...); we also accept snake_case defensively, since JSON
 * serializers vary.
 *
 * Tradeoff vs. the old `/vehicles` endpoint: GTFS-rt VehiclePosition carries
 * the GTFS route_id and trip_id but NOT a rider-facing route short name, so
 * routeName comes back null here and the client resolves the label from the
 * bundled schedule via routeId (HART's routes are in the dataset). Lat/lon,
 * bearing, speed and a real trip id all still come through.
 *
 * Auth: Swiftly authenticates with an `Authorization: <key>` header (raw
 * key, no "Bearer " prefix). Proxied through our backend (like the other
 * feeds) so the mobile client never holds the key.
 */

const config = require('./config');

// Shared with the alerts/trip-updates feeds via config (src/swiftlyGtfsRt.js).
const SWIFTLY_BASE = config.swiftlyBaseUrl || 'https://api.goswift.ly';

// Short in-memory cache, same size and reasoning as passio.js /
// pascoRealtime.js: a burst of riders opening the map only costs Swiftly
// one real upstream call every few seconds, and a slow/failed upstream
// call doesn't stall every concurrent request behind it. Swiftly also
// rate-limits by key, so this doubles as cheap protection against
// burning through that quota.
const CACHE_TTL_MS = 8000;
let cache = { data: null, expiresAt: 0 };

/** First present key from `names` on `obj` (tolerates camelCase vs snake_case serializers). */
function pick(obj, names) {
  if (!obj) return null;
  for (const name of names) {
    if (obj[name] != null) return obj[name];
  }
  return null;
}

/** A GTFS-rt FeedMessage entity[] array, across the spellings a serializer might use (or a bare array). */
function entitiesOf(feed) {
  if (Array.isArray(feed)) return feed;
  const entities = pick(feed, ['entity', 'entities']);
  return Array.isArray(entities) ? entities : [];
}

/**
 * One GTFS-rt VehiclePosition entity -> the shared bus shape the client
 * expects (same shape passio.js/pascoRealtime.js emit). Returns null for an
 * entity with no usable position, so a partial feed never yields NaN pins.
 */
function normalizeVehicle(entity) {
  const vp = pick(entity, ['vehicle']); // the VehiclePosition
  if (!vp) return null;
  const pos = pick(vp, ['position']);
  const lat = pick(pos, ['latitude', 'lat']);
  const lon = pick(pos, ['longitude', 'lon']);
  if (lat == null || lon == null) return null;

  const trip = pick(vp, ['trip']) || {};
  const routeId = pick(trip, ['routeId', 'route_id']);
  const tripId = pick(trip, ['tripId', 'trip_id']);
  const descriptor = pick(vp, ['vehicle']); // nested VehicleDescriptor { id, label }
  const vehId = pick(descriptor, ['id', 'label']);
  const id = vehId != null ? vehId : pick(entity, ['id']);
  const bearing = pick(pos, ['bearing', 'heading']);
  const speed = pick(pos, ['speed']);

  return {
    busId: String(id != null ? id : `${routeId}-${lat}-${lon}`),
    routeId: routeId != null ? String(routeId) : null,
    // GTFS-rt VehiclePosition has no rider-facing short name; the client
    // resolves the label from the bundled schedule via routeId.
    routeName: null,
    lat: Number(lat),
    lon: Number(lon),
    course: bearing != null ? Number(bearing) : null,
    speed: speed != null ? Number(speed) : null,
    tripId: tripId != null ? String(tripId) : null,
  };
}

async function fetchLiveBuses() {
  if (cache.data && Date.now() < cache.expiresAt) {
    return cache.data;
  }

  const apiKey = config.swiftlyApiKey;
  if (!apiKey) {
    // Guard: server.js only wires this source in when the key is set, so
    // this should never fire in practice -- but fail loud rather than
    // firing an inevitably-401 request if it's ever called unconfigured.
    throw new Error('Swiftly API key not configured (SWIFTLY_API_KEY)');
  }

  const agencyKey = config.swiftlyHartAgencyKey;
  const url = new URL(`${SWIFTLY_BASE}/real-time/${agencyKey}/gtfs-rt-vehicle-positions`);
  url.searchParams.set('format', 'json');
  const res = await fetch(url, { headers: { Authorization: apiKey, Accept: 'application/json' } });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text() || '').slice(0, 300).replace(/\s+/g, ' ').trim(); } catch (e) { /* ignore */ }
    throw new Error(`Swiftly (HART) live-bus request failed for agency "${agencyKey}": HTTP ${res.status}${detail ? ` -- ${detail}` : ''}`);
  }
  const raw = await res.json();

  const buses = entitiesOf(raw).map(normalizeVehicle).filter(Boolean);

  const result = { buses, fetchedAt: new Date().toISOString() };
  cache = { data: result, expiresAt: Date.now() + CACHE_TTL_MS };
  return result;
}

module.exports = { fetchLiveBuses, normalizeVehicle };
