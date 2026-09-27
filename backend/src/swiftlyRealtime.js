/**
 * Live vehicle positions for HART (Hillsborough Area Regional Transit,
 * Tampa) via Swiftly's real-time API. Unlike Hernando's Passio GO
 * (passio.js) and PascoGo's Avail/myStop (pascoRealtime.js) -- both
 * reverse-engineered from an unauthenticated web widget -- this is an
 * OFFICIAL, documented, key-authenticated API. HART is Swiftly's
 * customer; this is the vendor-sanctioned path, so there is no defensive
 * field-name guessing here the way the other two need.
 *
 * Endpoint choice -- JSON `/vehicles`, not protobuf GTFS-RT:
 * Swiftly exposes the same live data two ways: a protobuf
 * `gtfs-rt-vehicle-positions` feed (the README's original sketch, back
 * when the key hadn't arrived) and a plain-JSON `/vehicles` endpoint.
 * This uses the JSON one on purpose:
 *   - No new dependency. Protobuf would pull in MobilityData's
 *     `gtfs-realtime-bindings` + protobufjs; this app deliberately keeps
 *     the backend dependency list tiny, and passio.js/pascoRealtime.js
 *     already establish "live vendor feed -> plain JSON -> normalize".
 *   - Richer, already-decoded data. Swiftly's JSON carries `routeShortName`
 *     and a real `tripId` per vehicle -- something neither Passio nor Avail
 *     provide (the whole vehicleAllocation.js machinery on the client
 *     exists to RECONSTRUCT a trip_id those feeds omit). We normalize to
 *     the exact shared bus shape the other two emit so the client works
 *     unchanged, and additionally pass Swiftly's `tripId` through for a
 *     future pass that could skip allocation entirely for HART.
 *
 * Auth: Swiftly authenticates with an `Authorization: <key>` request
 * header (the raw key, no "Bearer " prefix). The key is a secret --
 * config.swiftlyApiKey, never committed; see .env.example. Proxied
 * through our own backend (like the other two feeds) so the mobile client
 * never holds the key or makes a cross-origin call, and a future API
 * change is a server update rather than an app-store release.
 */

const config = require('./config');

const SWIFTLY_BASE = 'https://api.goswift.ly';

// Short in-memory cache, same size and reasoning as passio.js /
// pascoRealtime.js: a burst of riders opening the map only costs Swiftly
// one real upstream call every few seconds, and a slow/failed upstream
// call doesn't stall every concurrent request behind it. Swiftly also
// rate-limits by key, so this doubles as cheap protection against
// burning through that quota.
const CACHE_TTL_MS = 8000;
let cache = { data: null, expiresAt: 0 };

function normalizeVehicle(v) {
  // Swiftly nests the fix under `loc`; tolerate a flat shape too rather
  // than crashing if a payload variant ever omits the wrapper.
  const loc = v.loc || v;
  const lat = loc.lat;
  const lon = loc.lon;
  if (lat == null || lon == null) return null;
  return {
    busId: String(v.id != null ? v.id : `${v.routeId}-${lat}-${lon}`),
    routeId: v.routeId != null ? String(v.routeId) : null,
    // Prefer the rider-facing short name ("1", "6", "275LX"); fall back
    // to the headsign so the client always has something to label with.
    routeName: v.routeShortName != null ? String(v.routeShortName)
      : (v.headsign != null ? String(v.headsign) : null),
    lat: Number(lat),
    lon: Number(lon),
    course: loc.heading != null ? Number(loc.heading) : null,
    speed: loc.speed != null ? Number(loc.speed) : null,
    // Bonus over Passio/Avail: Swiftly gives a real trip id directly.
    // Passed through (not required by the shared shape) for a future
    // pass that could use it instead of client-side trip allocation.
    tripId: v.tripId != null ? String(v.tripId) : null,
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
  const res = await fetch(`${SWIFTLY_BASE}/real-time/${agencyKey}/vehicles`, {
    headers: { Authorization: apiKey },
  });
  if (!res.ok) {
    throw new Error(`Swiftly (HART) live-bus request failed: HTTP ${res.status}`);
  }
  const raw = await res.json();

  // Swiftly wraps the array as { data: { vehicles: [...] } }.
  const rawVehicles = (raw && raw.data && Array.isArray(raw.data.vehicles))
    ? raw.data.vehicles
    : [];
  const buses = rawVehicles.map(normalizeVehicle).filter(Boolean);

  const result = { buses, fetchedAt: new Date().toISOString() };
  cache = { data: result, expiresAt: Date.now() + CACHE_TTL_MS };
  return result;
}

module.exports = { fetchLiveBuses, normalizeVehicle };
