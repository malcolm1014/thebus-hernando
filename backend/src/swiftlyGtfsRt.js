/**
 * HART's GTFS-Realtime SERVICE ALERTS and TRIP UPDATES (arrival
 * predictions) via Swiftly. Companion to swiftlyRealtime.js, which
 * handles the third GTFS-RT feed (vehicle positions); kept separate
 * because alerts/trip-updates are whole-system GTFS-RT documents with a
 * very different shape from the per-vehicle positions JSON.
 *
 * We request Swiftly's JSON serialization (`?format=json`) of the
 * standard GTFS-Realtime FeedMessage, so there's NO protobuf dependency
 * (the app deliberately stays dependency-light) and the shape is a
 * published spec (https://gtfs.org/documentation/realtime/reference/)
 * rather than a vendor guess. Protobuf<->JSON field names are canonically
 * camelCase (tripUpdate, stopTimeUpdate, stopId, headerText, ...); we
 * also accept snake_case defensively, since JSON serializers vary and we
 * can't confirm Swiftly's exact casing against a live authenticated feed
 * from here.
 *
 * Swiftly explicitly designs these endpoints for server-to-server use
 * ("requests from web browsers are not supported", and the payloads cover
 * the whole agency so they can be large) -- which is exactly why this is
 * proxied and cached here rather than called from the app: one upstream
 * fetch every cache interval serves every rider, and the client only ever
 * receives the small slice it asked for (the alerts list, or one stop's
 * next arrivals).
 */

const config = require('./config');

function baseUrl() {
  return (config.swiftlyBaseUrl || 'https://api.goswift.ly').replace(/\/+$/, '');
}

function pick(obj, names) {
  if (!obj) return null;
  for (const name of names) {
    if (obj[name] != null) return obj[name];
  }
  return null;
}

/** A GTFS-RT TranslatedString -> plain text (prefers English, else the first translation). */
function translated(ts) {
  const translations = pick(ts, ['translation']);
  if (!Array.isArray(translations) || translations.length === 0) return null;
  const en = translations.find((t) => {
    const lang = (pick(t, ['language']) || '').toLowerCase();
    return lang === 'en' || lang.startsWith('en-');
  });
  const chosen = en || translations[0];
  const text = pick(chosen, ['text']);
  return text != null ? String(text) : null;
}

async function fetchFeed(pathSegment, agencyKey) {
  const apiKey = config.swiftlyApiKey;
  if (!apiKey) throw new Error('Swiftly API key not configured (SWIFTLY_API_KEY)');
  const url = new URL(`${baseUrl()}/real-time/${agencyKey}/${pathSegment}`);
  url.searchParams.set('format', 'json');
  const res = await fetch(url, { headers: { Authorization: apiKey, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Swiftly ${pathSegment} request failed: HTTP ${res.status}`);
  return res.json();
}

/** The FeedMessage's entity[] array, across the couple of spellings a serializer might use. */
function entitiesOf(feed) {
  const entities = pick(feed, ['entity', 'entities']);
  return Array.isArray(entities) ? entities : [];
}

// ---- Service alerts ------------------------------------------------------
const ALERTS_TTL_MS = 60 * 1000; // alerts change slowly; a minute of caching is plenty
const alertsCache = new Map(); // agencyKey -> { data, expiresAt }

function normalizeAlert(entity) {
  const alert = pick(entity, ['alert']);
  if (!alert) return null;
  const informed = pick(alert, ['informedEntity', 'informed_entity']) || [];
  const routes = [];
  const stops = [];
  (Array.isArray(informed) ? informed : []).forEach((ie) => {
    const r = pick(ie, ['routeId', 'route_id']);
    const s = pick(ie, ['stopId', 'stop_id']);
    if (r != null) routes.push(String(r));
    if (s != null) stops.push(String(s));
  });
  const periods = (pick(alert, ['activePeriod', 'active_period']) || []).map((p) => ({
    start: pick(p, ['start']) != null ? Number(pick(p, ['start'])) : null,
    end: pick(p, ['end']) != null ? Number(pick(p, ['end'])) : null,
  }));
  return {
    id: pick(entity, ['id']) != null ? String(pick(entity, ['id'])) : null,
    header: translated(pick(alert, ['headerText', 'header_text'])),
    description: translated(pick(alert, ['descriptionText', 'description_text'])),
    cause: pick(alert, ['cause']) != null ? String(pick(alert, ['cause'])) : null,
    effect: pick(alert, ['effect']) != null ? String(pick(alert, ['effect'])) : null,
    severity: pick(alert, ['severityLevel', 'severity_level']) != null ? String(pick(alert, ['severityLevel', 'severity_level'])) : null,
    url: translated(pick(alert, ['url'])),
    routes,
    stops,
    activePeriods: periods,
  };
}

/** True when an alert has no active period, or "now" falls inside one (GTFS-RT: an empty activePeriod means always-active). */
function isAlertActive(alert, nowSecs) {
  if (!alert.activePeriods || alert.activePeriods.length === 0) return true;
  return alert.activePeriods.some((p) => {
    if (p.start != null && nowSecs < p.start) return false;
    if (p.end != null && nowSecs > p.end) return false;
    return true;
  });
}

async function fetchServiceAlerts(agencyKey, now = Date.now()) {
  const key = agencyKey || config.swiftlyHartAgencyKey;
  const cached = alertsCache.get(key);
  if (cached && now < cached.expiresAt) return cached.data;

  const feed = await fetchFeed('gtfs-rt-alerts', key);
  const nowSecs = Math.floor(now / 1000);
  const alerts = entitiesOf(feed)
    .map(normalizeAlert)
    .filter(Boolean)
    .filter((a) => a.header || a.description) // an alert with no text is nothing to show a rider
    .filter((a) => isAlertActive(a, nowSecs));

  const data = { alerts, fetchedAt: new Date(now).toISOString() };
  alertsCache.set(key, { data, expiresAt: now + ALERTS_TTL_MS });
  return data;
}

// ---- Trip updates (arrival predictions) ----------------------------------
const TRIP_UPDATES_TTL_MS = 20 * 1000; // Swiftly refreshes trip-updates ~every 10s
const tripUpdatesCache = new Map(); // agencyKey -> { data, expiresAt }

/**
 * Our dataset namespaces every stop id as `<agencyId>:<rawId>` (see
 * transform.js), but the GTFS-RT feed uses the agency's own raw stop_id.
 * Strip a leading `word:` prefix so a client can pass either form.
 */
function rawStopId(stopId) {
  const s = String(stopId);
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Parses a trip-updates FeedMessage into { byStop: { rawStopId: [{routeId,tripId,time,delay}] }, fetchedAt }. */
function parseTripUpdates(feed, now = Date.now()) {
  const byStop = {};
  entitiesOf(feed).forEach((entity) => {
    const tu = pick(entity, ['tripUpdate', 'trip_update']);
    if (!tu) return;
    const trip = pick(tu, ['trip']) || {};
    const routeId = pick(trip, ['routeId', 'route_id']);
    const tripId = pick(trip, ['tripId', 'trip_id']);
    const stus = pick(tu, ['stopTimeUpdate', 'stop_time_update']);
    (Array.isArray(stus) ? stus : []).forEach((stu) => {
      const sid = pick(stu, ['stopId', 'stop_id']);
      if (sid == null) return;
      const arrival = pick(stu, ['arrival']) || pick(stu, ['departure']);
      const time = pick(arrival, ['time']);
      if (time == null) return;
      const delay = pick(arrival, ['delay']);
      const list = byStop[String(sid)] || (byStop[String(sid)] = []);
      list.push({
        routeId: routeId != null ? String(routeId) : null,
        tripId: tripId != null ? String(tripId) : null,
        time: Number(time), // POSIX seconds
        delay: delay != null ? Number(delay) : null,
      });
    });
  });
  return { byStop, fetchedAt: new Date(now).toISOString() };
}

async function getTripUpdates(agencyKey, now = Date.now()) {
  const key = agencyKey || config.swiftlyHartAgencyKey;
  const cached = tripUpdatesCache.get(key);
  if (cached && now < cached.expiresAt) return cached.data;
  const feed = await fetchFeed('gtfs-rt-trip-updates', key);
  const data = parseTripUpdates(feed, now);
  tripUpdatesCache.set(key, { data, expiresAt: now + TRIP_UPDATES_TTL_MS });
  return data;
}

/** Upcoming live arrivals for one stop, soonest first, as {routeId, minutesUntil, delaySeconds, time}. */
async function predictionsForStop(agencyKey, stopId, { now = Date.now(), limit = 5 } = {}) {
  const { byStop, fetchedAt } = await getTripUpdates(agencyKey, now);
  const raw = rawStopId(stopId);
  const entries = byStop[raw] || [];
  const predictions = entries
    .map((e) => ({
      routeId: e.routeId,
      time: e.time,
      delaySeconds: e.delay,
      minutesUntil: Math.round((e.time * 1000 - now) / 60000),
    }))
    .filter((p) => p.minutesUntil >= 0)
    .sort((a, b) => a.time - b.time)
    .slice(0, limit);
  return { stopId: raw, predictions, fetchedAt };
}

module.exports = {
  fetchServiceAlerts,
  predictionsForStop,
  // exported for tests:
  normalizeAlert,
  isAlertActive,
  parseTripUpdates,
  rawStopId,
  translated,
};
