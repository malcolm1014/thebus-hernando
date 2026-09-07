/**
 * Live vehicle positions for PascoGo -- a DIFFERENT vendor than
 * Hernando's Passio GO (see passio.js): PascoGo's tracker
 * (https://gopasco.rideralerts.com/InfoPoint/, branded "myStop") is
 * built on Avail Technologies' "InfoPoint"/myStop product, confirmed by
 * the page's own "Powered by avail" footer and its `MyAvail.*` JS
 * bundle names. There is no official public API or key for this
 * either; this replicates the exact request shape the InfoPoint
 * desktop widget itself uses, found the same way Hernando's Passio
 * integration was: inspecting its own network traffic via a real
 * browser (`GET rest/Routes/GetVisibleRoutes` for the route list, `GET
 * rest/Vehicles/GetAllVehiclesForRoutes?routeIDs=<comma-separated ids>`
 * for live positions -- confirmed it accepts every route id at once in
 * a single call, no authentication required for either endpoint).
 *
 * **Vehicle field names are UNVERIFIED against a live payload** -- no
 * buses were running at the hour this was built (confirmed via the
 * endpoint's own `CURRENT TIME` display, well outside Pasco's daytime
 * service hours), the same honest limitation passio.js already
 * documents for its own routeId correlation. `normalizeVehicle()`
 * below checks several plausible Avail/myStop field-name casings for
 * each value rather than a single guess, but this should be confirmed
 * (and the fallback list trimmed to just the real name) against a real
 * response during Pasco's weekday daytime service -- see
 * MANUAL_TEST_SCRIPT.md's existing pattern for exactly this kind of
 * verification.
 *
 * Because it's unauthenticated and undocumented, Avail could change or
 * remove this without notice -- the same accepted risk passio.js takes
 * for Hernando. Proxied through our own backend for the same reasons:
 * a future change only needs a server update, and the client never
 * deals with cross-origin requests to a third party.
 */

const PASCO_BASE = 'https://gopasco.rideralerts.com/InfoPoint';

// Route list barely changes -- cached far longer than live positions
// (CACHE_TTL_MS below) so a burst of requests doesn't refetch it
// needlessly. Not persisted to disk; a cold server start just refetches
// once.
const ROUTES_CACHE_TTL_MS = 10 * 60 * 1000;
let routesCache = { ids: null, expiresAt: 0 };

async function getRouteIds() {
  if (routesCache.ids && Date.now() < routesCache.expiresAt) {
    return routesCache.ids;
  }
  const res = await fetch(`${PASCO_BASE}/rest/Routes/GetVisibleRoutes`);
  if (!res.ok) {
    throw new Error(`PascoGo route list request failed: HTTP ${res.status}`);
  }
  const routes = await res.json();
  const ids = routes.map((r) => r.RouteId).filter((id) => id != null);
  routesCache = { ids, expiresAt: Date.now() + ROUTES_CACHE_TTL_MS };
  return ids;
}

/** Reads the first defined value across several plausible field-name casings -- see the file-level comment on why this is defensive rather than a single confirmed name. */
function pick(obj, names) {
  for (const name of names) {
    if (obj[name] != null) return obj[name];
  }
  return null;
}

function normalizeVehicle(v) {
  const lat = pick(v, ['Latitude', 'lat']);
  const lon = pick(v, ['Longitude', 'lon', 'Longitutde']); // a real Avail API typo seen in the wild for some agencies -- kept as a defensive fallback, not a guess made up here
  if (lat == null || lon == null) return null;
  const routeId = pick(v, ['RouteId', 'RouteID']);
  return {
    busId: String(pick(v, ['VehicleId', 'Name', 'Id']) ?? `${routeId}-${lat}-${lon}`),
    routeId: routeId != null ? String(routeId) : null,
    routeName: pick(v, ['RouteName', 'RouteAbbreviation']) != null ? String(pick(v, ['RouteName', 'RouteAbbreviation'])) : null,
    lat: Number(lat),
    lon: Number(lon),
    course: (() => { const h = pick(v, ['Heading', 'CalculatedCourse', 'Direction']); return h != null ? Number(h) : null; })(),
    speed: (() => { const s = pick(v, ['GroundSpeed', 'Speed']); return s != null ? Number(s) : null; })(),
  };
}

// Same short in-memory cache Passio's own module uses, for the same
// reason: a burst of concurrent app requests only costs one real
// upstream call, and a slow/failed upstream call doesn't stall every
// request behind it.
const CACHE_TTL_MS = 8000;
let cache = { data: null, expiresAt: 0 };

async function fetchLiveBuses() {
  if (cache.data && Date.now() < cache.expiresAt) {
    return cache.data;
  }

  const routeIds = await getRouteIds();
  const res = await fetch(`${PASCO_BASE}/rest/Vehicles/GetAllVehiclesForRoutes?routeIDs=${routeIds.join(',')}`);
  if (!res.ok) {
    throw new Error(`PascoGo live-bus request failed: HTTP ${res.status}`);
  }
  const raw = await res.json();
  const buses = (Array.isArray(raw) ? raw : []).map(normalizeVehicle).filter(Boolean);

  const result = { buses, fetchedAt: new Date().toISOString() };
  cache = { data: result, expiresAt: Date.now() + CACHE_TTL_MS };
  return result;
}

module.exports = { fetchLiveBuses, normalizeVehicle };
