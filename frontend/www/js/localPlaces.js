/**
 * Offline place resolver over the bundled data we already ship: transit
 * STOPS plus the OpenStreetMap corpus of PLACES (businesses/landmarks/POIs)
 * and named ROADS (data.places / data.roads -- the same tri-county corpus
 * the terminal search engine uses, see queryEngine.js). Its job here is to
 * turn a rider's typed place name into coordinates *without a network call*,
 * so the trip planner can route from/to a local landmark the online
 * geocoder might not know ("Avalon Publix", "Springstead High School")
 * before falling back to Transitous's geocoder for cities and addresses.
 *
 * Deliberately CONSERVATIVE: it only returns a hit on a strong match
 * (exact normalized name/alias, or a clear prefix match), so a vague query
 * like "main st" or a city name isn't force-matched to some random local
 * road/POI -- those fall through to the online geocoder, which is better at
 * them. Local specificity where the corpus is strong; online reach where
 * it isn't.
 */
(function (global) {
  let dataset = null;

  function setDataset(d) { dataset = d; }

  function normalize(text) {
    if (global.TheBusIntentParser && typeof TheBusIntentParser.normalize === 'function') {
      try { return TheBusIntentParser.normalize(text); } catch (e) { /* fall through */ }
    }
    return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function coordsOf(entry, source) {
    if (!entry || entry.lat == null || entry.lon == null) return null;
    return { name: entry.name || '', lat: Number(entry.lat), lon: Number(entry.lon), source };
  }

  /**
   * @returns {{name,lat,lon,source} | null}
   * source is 'stop' | 'place' | 'road' for transparency/debugging.
   */
  function resolve(text) {
    if (!dataset) return null;
    const q = normalize(text);
    if (!q || q.length < 3) return null;

    const stops = dataset.stops ? Object.values(dataset.stops) : [];
    const places = dataset.places ? Object.values(dataset.places) : [];
    const roads = dataset.roads ? Object.values(dataset.roads) : [];

    // 1) Exact name match: stop, then place (incl. aliases), then road.
    for (const s of stops) if (normalize(s.name) === q) return coordsOf(s, 'stop');
    for (const p of places) {
      if (normalize(p.name) === q) return coordsOf(p, 'place');
      if (Array.isArray(p.aliases) && p.aliases.some((a) => normalize(a) === q)) return coordsOf(p, 'place');
    }
    for (const r of roads) if (normalize(r.name) === q) return coordsOf(r, 'road');

    // 2) Prefix match (query at least 4 chars), preferring the shortest
    //    name so "springstead" -> "Springstead High School", not a longer
    //    unrelated name that merely starts the same. Stops/places only --
    //    a prefix road match is too likely to be the wrong same-named road.
    if (q.length >= 4) {
      let best = null;
      let bestLen = Infinity;
      const consider = (entry, source) => {
        const n = normalize(entry.name);
        if (n.startsWith(q) && n.length < bestLen) { best = coordsOf(entry, source); bestLen = n.length; }
      };
      stops.forEach((s) => consider(s, 'stop'));
      places.forEach((p) => consider(p, 'place'));
      if (best) return best;
    }
    return null;
  }

  global.TheBusLocalPlaces = { setDataset, resolve, normalize };
})(typeof window !== 'undefined' ? window : this);
