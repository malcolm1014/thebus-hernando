/**
 * Wire-format compaction: a pure transport-layer optimization applied
 * ONLY right before writing transit_data.json (see etl.js's
 * writeDataset()), never touching transform.js/mergeAgencyData's own
 * output shape. The client mirrors this with a matching expandDataset()
 * (frontend/www/js/sync.js) applied right after loading a dataset from
 * any source (cache/bundled snapshot/fresh download), before it's ever
 * handed to queryEngine.js. Because both ends of this are isolated to
 * the actual network/disk boundary, none of transform.js's or
 * queryEngine.js's own (extensively tested) logic needed to change at
 * all -- every existing test for either still exercises the plain,
 * human-readable object shape directly.
 *
 * Why this exists: confirmed empirically, not guessed -- running the
 * real multi-agency ETL against Hernando+Pasco+HART produced a 51MB
 * transit_data.json, 97% of it stop.routes[].arrivals[] entries (442k+
 * of them once HART's real metro-scale schedule is included). Each
 * arrival was a 4-key JSON OBJECT ({tripId, serviceId, headsign,
 * minutes}) repeating largely-non-unique strings verbatim: only ~22
 * distinct serviceIds and a few hundred distinct headsigns account for
 * nearly all 442k rows, and even tripId (unique per actual trip) still
 * repeats roughly once per stop that trip visits (~37x on average).
 * This was fine at Hernando's original scale (a few thousand arrivals)
 * but is real, measured waste at metro scale.
 *
 * The fix: intern every arrival's tripId/serviceId/headsign strings
 * into one shared pool (`stringPool`), and store each arrival as a
 * compact 4-element ARRAY of [tripIdx, serviceIdx, headsignIdx, minutes]
 * instead of a 4-key object -- this also eliminates the repeated JSON
 * key-name bytes ("tripId":/"serviceId":/"headsign":/"minutes":) that a
 * plain per-arrival string pool alone wouldn't touch.
 */

function compactForWire(data) {
  const pool = [];
  const poolIndexByString = new Map();

  function intern(str) {
    const key = str || '';
    const existing = poolIndexByString.get(key);
    if (existing !== undefined) return existing;
    const idx = pool.length;
    pool.push(key);
    poolIndexByString.set(key, idx);
    return idx;
  }

  const stops = {};
  for (const [stopId, stop] of Object.entries(data.stops)) {
    stops[stopId] = {
      ...stop,
      routes: stop.routes.map((routeEntry) => ({
        ...routeEntry,
        arrivals: routeEntry.arrivals.map((a) => [intern(a.tripId), intern(a.serviceId), intern(a.headsign), a.minutes]),
      })),
    };
  }

  return { ...data, stops, stringPool: pool };
}

/**
 * Reverses compactForWire() -- needed on the BACKEND too (not just the
 * client's mirror in sync.js), because etl.js's readPreviousData() reads
 * the on-disk transit_data.json back in for two purposes:
 * isSuspiciouslySmaller() (unaffected either way -- it only counts
 * stop/route dict KEYS, never touches arrivals) and, more importantly,
 * extractAgencySlice()'s per-agency fetch-failure fallback, whose output
 * gets fed right back into mergeAgencyData()/writeDataset() as if it
 * were fresh transform() output. Without expanding first, that fallback
 * path would silently double-compact already-compact array-shaped
 * arrivals as though they were still {tripId, serviceId, headsign,
 * minutes} objects -- reading undefined off an array and corrupting the
 * data rather than erroring loudly.
 */
function expandFromWire(data) {
  if (!data || !Array.isArray(data.stringPool)) return data; // not compacted (or already expanded) -- safe no-op
  const pool = data.stringPool;
  const stops = {};
  for (const [stopId, stop] of Object.entries(data.stops || {})) {
    stops[stopId] = {
      ...stop,
      routes: stop.routes.map((routeEntry) => ({
        ...routeEntry,
        arrivals: routeEntry.arrivals.map(([tripIdx, serviceIdx, headsignIdx, minutes]) => ({
          tripId: pool[tripIdx],
          serviceId: pool[serviceIdx],
          headsign: pool[headsignIdx],
          minutes,
        })),
      })),
    };
  }
  const { stringPool, ...rest } = data;
  return { ...rest, stops };
}

module.exports = { compactForWire, expandFromWire };
