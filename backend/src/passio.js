/**
 * Live vehicle positions come from Passio GO -- the same real-time bus
 * tracker Hernando County itself embeds on its own transit page
 * (https://www.hernandocounty.us/living-here/transit-thebus/, iframed
 * from passiogo.com). There is no official public API or key for this;
 * these are the exact request shapes their own web widget uses,
 * confirmed by inspecting its network traffic. This is the same
 * approach taken by the open-source `athuler/PassioGo` project used by
 * apps for many other agencies (https://github.com/athuler/PassioGo).
 *
 * Because it's unauthenticated and undocumented, Passio could change or
 * remove it without notice -- that's a real risk of depending on it,
 * accepted here because live tracking has no alternative source (GTFS
 * static data has no real-time positions). Proxied through our own
 * backend (rather than called directly from the app) so a future
 * change only requires a server update, not an app-store release, and
 * so the mobile client doesn't have to deal with cross-origin requests
 * to a third party.
 */

const PASSIO_BASE = 'https://passiogo.com';

// Hernando County Transit's Passio system id. Confirmed via
// mapGetData.php?getSystems=2 -- coincidentally matches the GTFS
// agency_id (5732) but is a separate Passio-internal identifier; don't
// assume that equivalence holds for any other agency.
const SYSTEM_ID = '5732';

// Passio's server can be slow/flaky; a short in-memory cache means a
// burst of app requests (many riders opening the map around the same
// time) only costs Passio one real upstream call, and a slow/failed
// upstream call doesn't stall every concurrent request behind it.
const CACHE_TTL_MS = 8000;
let cache = { data: null, expiresAt: 0 };

async function fetchLiveBuses() {
  if (cache.data && Date.now() < cache.expiresAt) {
    return cache.data;
  }

  const res = await fetch(`${PASSIO_BASE}/mapGetData.php?getBuses=2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ s0: SYSTEM_ID, sA: 1 }),
  });
  if (!res.ok) {
    throw new Error(`Passio live-bus request failed: HTTP ${res.status}`);
  }
  const raw = await res.json();

  const buses = [];
  const busesById = (raw && raw.buses) || {};
  for (const [busId, entries] of Object.entries(busesById)) {
    if (busId === '-1' || !Array.isArray(entries) || entries.length === 0) continue;
    const v = entries[0];
    if (v.latitude == null || v.longitude == null) continue;
    buses.push({
      busId,
      // Best-effort correlation to our own GTFS route_id -- Passio's
      // route "groupId" appeared to match our GTFS route_id in the
      // static getRoutes response (checked at scaffolding time), but
      // this couldn't be confirmed against a live getBuses payload
      // (no vehicles were running at the hour this was built). Also
      // pass through Passio's own human-readable route name as a
      // fallback the client can display even if routeId doesn't match
      // anything in our dataset.
      routeId: v.routeId != null ? String(v.routeId) : null,
      routeName: v.route != null ? String(v.route) : null,
      lat: Number(v.latitude),
      lon: Number(v.longitude),
      course: v.calculatedCourse != null ? Number(v.calculatedCourse) : null,
      speed: v.speed != null ? Number(v.speed) : null,
    });
  }

  const result = { buses, fetchedAt: new Date().toISOString() };
  cache = { data: result, expiresAt: Date.now() + CACHE_TTL_MS };
  return result;
}

module.exports = { fetchLiveBuses };
