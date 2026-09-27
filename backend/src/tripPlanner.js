/**
 * Cross-agency / cross-country trip planning -- "Tier 2" from the
 * research brief (see README's "Trip planning" section). Where the
 * offline rule engine (frontend/www/js/queryEngine.js) plans A->B trips
 * INSIDE our bundled tri-county dataset, this reaches beyond it: any two
 * places in the country, using real nationwide transit data, whenever the
 * rider is online.
 *
 * We do NOT run a routing engine ourselves. We proxy Transitous
 * (https://transitous.org) -- a free, community-run instance of the MOTIS
 * engine at api.transitous.org that aggregates thousands of agency feeds
 * worldwide behind one JSON API. This is the same "proxy a third party
 * through our own backend" pattern the live-bus feeds use (passio.js /
 * pascoRealtime.js / swiftlyRealtime.js), for the same reasons: the app
 * never makes a cross-origin call, a future change is a server update,
 * and we can set the required User-Agent + cache centrally.
 *
 * Transitous etiquette (it's volunteer-run, best-effort, free for
 * open-source / non-profit use): every request MUST carry a meaningful
 * User-Agent naming the app, version, and a contact. We send that on
 * every call (config.tripPlannerUserAgent) and cache results so a burst
 * of riders doesn't hammer a donated service. If TriBus ever needs
 * guaranteed uptime, point TRANSITOUS_BASE_URL at a self-hosted MOTIS
 * instance -- the API is identical, so nothing else here changes.
 *
 * MOTIS API shape (confirmed against motis-project/motis openapi.yaml):
 *   GET /api/v1/geocode?text=<q>&place=<lat,lon>  -> [ {name,lat,lon,...} ]
 *   GET /api/v1/plan?fromPlace=<lat,lon>&toPlace=<lat,lon>&time=<ISO>
 *        -> { from, to, itineraries:[ {duration,startTime,endTime,
 *              transfers, legs:[ {mode,from,to,startTime,endTime,
 *              duration,distance,routeShortName,headsign,agencyName} ]} ] }
 */

const config = require('./config');

/** Reads the first defined value across several field-name spellings -- MOTIS is well-documented, but tolerating a couple of casings costs nothing and future-proofs against a version bump. */
function pick(obj, names) {
  if (!obj) return null;
  for (const name of names) {
    if (obj[name] != null) return obj[name];
  }
  return null;
}

function baseUrl() {
  return (config.transitousBaseUrl || 'https://api.transitous.org').replace(/\/+$/, '');
}

function requestHeaders() {
  return { 'User-Agent': config.tripPlannerUserAgent, Accept: 'application/json' };
}

// ---- Geocoding -----------------------------------------------------------
// Place names change slowly; cache generously so repeated "Tampa"/"Orlando"
// lookups don't each cost a call to a donated service. In-memory only (same
// reasoning as geocode.js: Render's free tier tears the container down on
// idle, so disk persistence wouldn't survive the cycle it actually hits).
const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;
const GEOCODE_MAX = 500;
const geocodeCache = new Map(); // "text|bias" -> { data, expiresAt }

async function geocodePlace(text, biasLatLon) {
  const query = String(text || '').trim();
  if (!query) return null;

  const key = `${query.toLowerCase()}|${biasLatLon || ''}`;
  const cached = geocodeCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const url = new URL(`${baseUrl()}/api/v1/geocode`);
  url.searchParams.set('text', query);
  if (biasLatLon) url.searchParams.set('place', biasLatLon);

  const res = await fetch(url, { headers: requestHeaders() });
  if (!res.ok) throw new Error(`Transitous geocode failed: HTTP ${res.status}`);
  const matches = await res.json();

  let data = null;
  const first = Array.isArray(matches) ? matches[0] : null;
  if (first) {
    const lat = pick(first, ['lat', 'latitude']);
    const lon = pick(first, ['lon', 'lng', 'longitude']);
    if (lat != null && lon != null) {
      data = { name: pick(first, ['name']) || query, lat: Number(lat), lon: Number(lon) };
    }
  }

  if (geocodeCache.size >= GEOCODE_MAX && !geocodeCache.has(key)) {
    geocodeCache.delete(geocodeCache.keys().next().value); // evict oldest (Map keeps insertion order)
  }
  geocodeCache.set(key, { data, expiresAt: Date.now() + GEOCODE_TTL_MS });
  return data;
}

// ---- Journey planning ----------------------------------------------------
const PLAN_TTL_MS = 45 * 1000; // a plan is time-sensitive; cache only long enough to absorb a burst
const planCache = new Map();
const MAX_ITINERARIES = 5;

function normalizeLeg(leg) {
  const from = pick(leg, ['from']) || {};
  const to = pick(leg, ['to']) || {};
  const startTime = pick(leg, ['startTime']) || pick(from, ['departure']);
  const endTime = pick(leg, ['endTime']) || pick(to, ['arrival']);
  const durationSecs = pick(leg, ['duration']);
  const distance = pick(leg, ['distance']);
  return {
    mode: pick(leg, ['mode']) || 'UNKNOWN',
    routeName: (() => {
      const r = pick(leg, ['routeShortName', 'routeLongName', 'route']);
      return r != null ? String(r) : null;
    })(),
    headsign: (() => { const h = pick(leg, ['headsign', 'tripHeadsign']); return h != null ? String(h) : null; })(),
    agency: (() => { const a = pick(leg, ['agencyName', 'agency']); return a != null ? String(a) : null; })(),
    from: pick(from, ['name']) != null ? String(pick(from, ['name'])) : null,
    to: pick(to, ['name']) != null ? String(pick(to, ['name'])) : null,
    departure: startTime != null ? String(startTime) : null,
    arrival: endTime != null ? String(endTime) : null,
    durationMinutes: durationSecs != null ? Math.round(Number(durationSecs) / 60) : null,
    distanceMeters: distance != null ? Number(distance) : null,
  };
}

function normalizeItinerary(it) {
  const durationSecs = pick(it, ['duration']);
  const legs = Array.isArray(pick(it, ['legs'])) ? it.legs.map(normalizeLeg) : [];
  return {
    durationMinutes: durationSecs != null ? Math.round(Number(durationSecs) / 60) : null,
    departure: (() => { const t = pick(it, ['startTime']); return t != null ? String(t) : null; })(),
    arrival: (() => { const t = pick(it, ['endTime']); return t != null ? String(t) : null; })(),
    transfers: (() => { const n = pick(it, ['transfers']); return n != null ? Number(n) : null; })(),
    legs,
  };
}

function buildPlanUrl({ fromLatLon, toLatLon, time, arriveBy }) {
  const url = new URL(`${baseUrl()}/api/v1/plan`);
  url.searchParams.set('fromPlace', fromLatLon);
  url.searchParams.set('toPlace', toLatLon);
  if (time) url.searchParams.set('time', time);
  if (arriveBy) url.searchParams.set('arriveBy', 'true');
  return url;
}

/**
 * Plans a trip between two places. Each endpoint is given either as
 * free-text (geocoded via Transitous) or as explicit {lat,lon} coords.
 * Returns { from, to, itineraries } -- itineraries is [] (not an error)
 * when the two points are real but no transit route connects them.
 * Throws only on a genuine upstream/network failure, or a
 * PlaceNotFoundError when a text place can't be resolved.
 */
async function planTrip({ from, to, fromCoords, toCoords, time, arriveBy } = {}) {
  const origin = fromCoords || (await geocodePlace(from));
  if (!origin) throw new PlaceNotFoundError('from', from);
  // Bias the destination search toward the origin so a bare "Main St"
  // resolves near where the trip starts, not on the other coast.
  const originLatLon = `${origin.lat},${origin.lon}`;
  const dest = toCoords || (await geocodePlace(to, originLatLon));
  if (!dest) throw new PlaceNotFoundError('to', to);

  const cacheKey = JSON.stringify({ o: originLatLon, d: `${dest.lat},${dest.lon}`, time: time || '', arriveBy: !!arriveBy });
  const cached = planCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const url = buildPlanUrl({ fromLatLon: originLatLon, toLatLon: `${dest.lat},${dest.lon}`, time, arriveBy });
  const res = await fetch(url, { headers: requestHeaders() });
  if (!res.ok) throw new Error(`Transitous plan failed: HTTP ${res.status}`);
  const raw = await res.json();

  const rawItins = Array.isArray(pick(raw, ['itineraries'])) ? raw.itineraries : [];
  const result = {
    from: { name: origin.name || from || 'START', lat: origin.lat, lon: origin.lon },
    to: { name: dest.name || to || 'DESTINATION', lat: dest.lat, lon: dest.lon },
    itineraries: rawItins.slice(0, MAX_ITINERARIES).map(normalizeItinerary),
    fetchedAt: new Date().toISOString(),
  };

  planCache.set(cacheKey, { data: result, expiresAt: Date.now() + PLAN_TTL_MS });
  return result;
}

/** Distinct error so the server can answer 422 ("couldn't find that place") instead of a generic 502. */
class PlaceNotFoundError extends Error {
  constructor(which, text) {
    super(`Could not find a place matching "${text}" (${which})`);
    this.name = 'PlaceNotFoundError';
    this.which = which;
    this.text = text;
  }
}

module.exports = {
  planTrip,
  geocodePlace,
  normalizeItinerary,
  normalizeLeg,
  buildPlanUrl,
  PlaceNotFoundError,
};
