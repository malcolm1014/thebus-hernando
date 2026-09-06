/**
 * Turns a parsed intent+entities into an answer string by filtering the
 * locally-cached transit_data.json against the device's own clock. This
 * is the whole reason the data was pre-flattened server-side: everything
 * here is array filtering + arithmetic, no joins, so it's fast enough to
 * run on a phone with zero network access.
 */
(function (global) {
  let dataset = null;
  let index = null; // { routes: [{id, shortName, longName}], stops: [{id, name}] }
  let tripsIndexCache = null; // lazily built by getTripsIndex(), invalidated on setDataset()
  let stopTripIndexCache = null; // lazily built by getStopTripIndex(), invalidated on setDataset()
  let nearbyStopsIndexCache = null; // lazily built by getNearbyStopsIndex(), invalidated on setDataset()

  // Side channel, not part of answerQuery()'s return value: which real-
  // world point (if any) the MOST RECENT answer was actually about, so
  // app.js can optionally show a small static map image alongside the
  // text without answerQuery() itself having to change its return type
  // (a plain string) -- every existing caller and test already depends
  // on that shape. Reset at the top of every answerQuery() call so a
  // location-less answer (e.g. "list stops on route 10") never leaves a
  // stale previous location attached to it.
  let lastLocation = null;
  function setLastLocation(lat, lon, label) {
    lastLocation = (lat != null && lon != null) ? { lat, lon, label } : null;
  }
  function getLastLocation() {
    return lastLocation;
  }

  function setDataset(data) {
    dataset = data;
    tripsIndexCache = null;
    stopTripIndexCache = null;
    nearbyStopsIndexCache = null;
    // Each stop's own name is always a candidate; its `aliases` (informal
    // shorthand pre-generated server-side at ETL time -- see backend's
    // enrich.js -- absent on any dataset synced before that feature
    // existed, hence the fallback) contribute EXTRA candidates pointing
    // at the same stop id, so a phrase like "walmart on 50" can resolve
    // directly via fuzzyMatch without ever needing geocoding first.
    const stopCandidates = [];
    for (const s of Object.values(data.stops)) {
      stopCandidates.push({ id: s.id, name: s.name });
      for (const alias of s.aliases || []) {
        stopCandidates.push({ id: s.id, name: alias });
      }
    }
    index = {
      routes: Object.values(data.routes).map((r) => ({ id: r.id, shortName: r.shortName, longName: r.longName })),
      stops: stopCandidates,
    };
  }

  function getIndex() {
    return index;
  }

  /**
   * GTFS arrival times are the AGENCY's local wall-clock time, not UTC
   * and not necessarily the querying device's own timezone -- a phone
   * with its region/timezone set wrong (or a rider traveling with a
   * phone still on home-timezone) would otherwise get wrong "X min away"
   * answers. This reads the device's instant (`now`, a real Date, so
   * still correct in an absolute sense) but reports weekday/date/time-
   * of-day AS SEEN IN the agency's own timezone, via Intl -- no
   * date-math library needed.
   */
  // getAgencyClock is a pure function of (instant, timezone), and
  // resolveArrivalTiming() below always derives its 3 calls (today,
  // exactly-24h-ago, exactly-24h-from-now) from the SAME `now` --
  // meaning every call across an entire query resolves to just 3
  // distinct cache keys, no matter how many arrivals get checked.
  // Caching this matters a lot in practice, not just in theory:
  // `Intl.DateTimeFormat` construction + `formatToParts` is genuinely
  // slow (fine at a few thousand calls -- Hernando's original scale --
  // but confirmed to take minutes, not milliseconds, once a single
  // trip-planning query legitimately needs to check arrival timing
  // millions of times across a merged dataset with a HART-sized
  // network in it). Capped like searchIndex.js's own caches, evicting
  // the oldest entry once over the cap -- in real usage this basically
  // never fills past ~3 entries anyway, the cap just guards against a
  // pathological caller feeding many distinct `now` instants over a
  // long-lived session.
  const AGENCY_CLOCK_CACHE_MAX = 50;
  const agencyClockCache = new Map();

  function getAgencyClock(now, timeZone) {
    const key = `${now.getTime()}|${timeZone}`;
    const cached = agencyClockCache.get(key);
    if (cached) return cached;

    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      weekday: 'long',
    });
    const parts = {};
    for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
    const result = {
      dow: parts.weekday.toLowerCase(),
      dateStr: `${parts.year}${parts.month}${parts.day}`,
      minutes: Number(parts.hour) * 60 + Number(parts.minute),
    };

    if (agencyClockCache.size >= AGENCY_CLOCK_CACHE_MAX) {
      agencyClockCache.delete(agencyClockCache.keys().next().value);
    }
    agencyClockCache.set(key, result);
    return result;
  }

  function agencyTz() {
    return (dataset && dataset.agencyTimezone) || 'America/New_York';
  }

  /** Is `serviceId` running on the given (already agency-local) weekday/date? */
  function isServiceActiveForClock(serviceId, dow, dateStr) {
    const svc = dataset.services[serviceId];
    if (!svc) return false;
    if (svc.removedDates.includes(dateStr)) return false;
    if (svc.addedDates.includes(dateStr)) return true;
    if (!svc[dow]) return false;
    if (svc.startDate && dateStr < svc.startDate) return false;
    if (svc.endDate && dateStr > svc.endDate) return false;
    return true;
  }

  /** Is `serviceId` running on device instant `now`, per the agency's own calendar day? */
  function isServiceActive(serviceId, now) {
    const clock = getAgencyClock(now, agencyTz());
    return isServiceActiveForClock(serviceId, clock.dow, clock.dateStr);
  }

  /**
   * Some real-world feeds (Hernando County's included) leave
   * route_short_name entirely blank and put the whole rider-facing name
   * ("Blue", "Route 1 Red") in route_long_name instead. This picks
   * whichever field is populated and avoids a redundant "ROUTE ROUTE 1
   * RED" when the long name already starts with "Route".
   *
   * A DIFFERENT real-world redundancy, found by running this against
   * PascoGo's actual feed: unlike Hernando, Pasco populates BOTH fields,
   * but its long name is often just the literal string "Route " + the
   * short name ("14" / "Route 14") -- the short/long INEQUALITY check
   * above alone doesn't catch this (they're different strings), so it
   * used to print "ROUTE 14 (ROUTE 14)". Stripping a leading "Route "
   * from the long name before comparing catches this specific
   * redundancy too, without touching the genuinely-different-fields case
   * ("1" / "Florida Avenue", also real Tampa/HART data) that the
   * parenthetical format exists for in the first place.
   *
   * Prefixed with the agency's own label when `route.agencyLabel` is
   * present (a merged multi-agency dataset) -- two different counties'
   * feeds can both genuinely have a "Route 1", and a trip itinerary that
   * might cross agencies needs to disambiguate which one it means at
   * every mention, not just where a transfer happens to be called out.
   * Absent on a single-agency dataset (no `agencyMeta` was ever passed
   * to `transform()`), so this is a no-op for the app's original
   * single-county deployment shape.
   */
  function routeLabel(route) {
    const short = (route.shortName || '').trim();
    const long = (route.longName || '').trim();
    const prefix = route.agencyLabel ? `${route.agencyLabel.toUpperCase()} ` : '';
    const longWithoutRoutePrefix = long.replace(/^route\s+/i, '').trim();
    const isRedundant = short && long
      && (short.toLowerCase() === long.toLowerCase() || short.toLowerCase() === longWithoutRoutePrefix.toLowerCase());
    if (short && long && !isRedundant) {
      return `${prefix}ROUTE ${short} (${long.toUpperCase()})`;
    }
    const name = short || long;
    if (!name) return `${prefix}ROUTE (UNNAMED)`;
    return /^route\b/i.test(name) ? `${prefix}${name.toUpperCase()}` : `${prefix}ROUTE ${name.toUpperCase()}`;
  }

  /** Great-circle distance in miles -- accurate enough at county scale, no external library needed. */
  function haversineMiles(lat1, lon1, lat2, lon2) {
    const R = 3958.8; // Earth's radius in miles
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function formatClock(minutesPastMidnight) {
    const m = ((Math.round(minutesPastMidnight) % 1440) + 1440) % 1440;
    let h = Math.floor(m / 60);
    const min = m % 60;
    const suffix = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${String(min).padStart(2, '0')} ${suffix}`;
  }

  function toArrivalRecord(routeEntry, arr, minutesUntil, wallMinutes, isTomorrow) {
    return {
      routeId: routeEntry.routeId,
      shortName: routeEntry.shortName,
      longName: routeEntry.longName,
      agencyLabel: routeEntry.agencyLabel, // undefined on a single-agency dataset -- see routeLabel()
      headsign: arr.headsign,
      minutesUntil,
      clock: formatClock(wallMinutes),
      isTomorrow: !!isTomorrow, // rolled forward past midnight -- MUST be flagged, "AT 6:03 AM" bare reads as today's already-passed 6am, not tomorrow's first bus
    };
  }

  /**
   * Whether/when one raw (service_id, minutes-past-midnight) stop_time
   * value is a real, still-upcoming instant relative to `now` -- correct
   * across midnight in both directions:
   *  - a trip scheduled e.g. "25:30" (>= 1440 min) belongs to a service
   *    day that STARTED YESTERDAY -- it only counts if yesterday's
   *    service was active and that after-midnight instant hasn't
   *    actually passed yet on today's real clock.
   *  - a trip already passed earlier today only rolls forward to "later"
   *    if the service actually recurs tomorrow (a Friday-only route
   *    doesn't get treated as running again a few hours after a Friday
   *    night query).
   * Returns null if this instant isn't reachable at all from `now`
   * (service not active on the relevant day, or already passed with no
   * tomorrow recurrence), else `{ minutesUntil, wallMinutes, isTomorrow }`.
   *
   * Evaluated independently per stop_time row (not per whole trip) --
   * exactly right for a single stop's own arrival list (every real-world
   * use here and in nextArrivals), but NOTE for any caller walking a
   * single trip across multiple stops (e.g. a trip planner reconstructing
   * one vehicle's path): a trip that itself straddles midnight would have
   * its early stops resolved against "today" and its later ones against
   * "yesterday" independently, which can disagree. Not handled -- this
   * feed has no observed overnight service (see MANUAL_TEST_SCRIPT.md),
   * same accepted simplification as dayArrivals() below.
   */
  function resolveArrivalTiming(serviceId, minutes, now) {
    const tz = agencyTz();
    const today = getAgencyClock(now, tz);
    const yesterday = getAgencyClock(new Date(now.getTime() - 24 * 60 * 60 * 1000), tz);
    const tomorrow = getAgencyClock(new Date(now.getTime() + 24 * 60 * 60 * 1000), tz);

    if (minutes >= 1440) {
      const wallMinutes = minutes - 1440;
      if (wallMinutes < today.minutes) return null; // that after-midnight moment already passed today
      if (!isServiceActiveForClock(serviceId, yesterday.dow, yesterday.dateStr)) return null;
      return { minutesUntil: wallMinutes - today.minutes, wallMinutes, isTomorrow: false };
    }
    if (isServiceActiveForClock(serviceId, today.dow, today.dateStr) && minutes >= today.minutes) {
      return { minutesUntil: minutes - today.minutes, wallMinutes: minutes, isTomorrow: false };
    }
    if (isServiceActiveForClock(serviceId, tomorrow.dow, tomorrow.dateStr)) {
      return { minutesUntil: (1440 - today.minutes) + minutes, wallMinutes: minutes, isTomorrow: true };
    }
    return null;
  }

  /**
   * Next N active arrivals for one stop, optionally filtered to a single
   * route -- see resolveArrivalTiming() for the actual midnight-crossing
   * logic, applied per arrival here.
   */
  function nextArrivals(stopId, routeId, now, limit) {
    const stop = dataset.stops[stopId];
    if (!stop) return [];
    const results = [];

    for (const routeEntry of stop.routes) {
      if (routeId && routeEntry.routeId !== routeId) continue;
      for (const arr of routeEntry.arrivals) {
        const timing = resolveArrivalTiming(arr.serviceId, arr.minutes, now);
        if (!timing) continue;
        results.push(toArrivalRecord(routeEntry, arr, timing.minutesUntil, timing.wallMinutes, timing.isTomorrow));
      }
    }

    results.sort((a, b) => a.minutesUntil - b.minutesUntil);
    return limit ? results.slice(0, limit) : results;
  }

  /**
   * All of TODAY's active-service arrivals for a stop (optionally
   * filtered to one route), unsorted by "is this in the future" --
   * unlike nextArrivals(), which only returns what's still upcoming.
   * Used for FIND_FIRST_LAST_BUS, where "first bus" needs the day's
   * earliest scheduled time even if that time already passed hours ago.
   * Simplification, documented: doesn't attempt the yesterday-spillover
   * handling nextArrivals() does for trips scheduled past midnight --
   * acceptable for this feed (no observed overnight service), would need
   * revisiting if a future feed/agency actually runs past midnight.
   */
  function dayArrivals(stopId, routeId, now) {
    const stop = dataset.stops[stopId];
    if (!stop) return [];
    const tz = agencyTz();
    const today = getAgencyClock(now, tz);
    const results = [];
    for (const routeEntry of stop.routes) {
      if (routeId && routeEntry.routeId !== routeId) continue;
      for (const arr of routeEntry.arrivals) {
        if (!isServiceActiveForClock(arr.serviceId, today.dow, today.dateStr)) continue;
        const wallMinutes = arr.minutes % 1440;
        results.push(toArrivalRecord(routeEntry, arr, wallMinutes - today.minutes, wallMinutes));
      }
    }
    results.sort((a, b) => a.minutesUntil - b.minutesUntil);
    return results;
  }

  /**
   * One line per route serving a stop, each showing THAT route's own
   * next arrival -- unlike FIND_NEXT_ARRIVAL's top-3-soonest-overall list,
   * this guarantees a less-frequent route never gets crowded out of a
   * multi-route stop's answer just because another route runs more often.
   * Used by the NEAREST STOP answers, where "served by routes: Blue,
   * Purple" alone left riders with no way to tell which was actually
   * coming next without a separate query.
   */
  function nextArrivalLines(stop, now) {
    return stop.routes.map((routeEntry) => {
      const [next] = nextArrivals(stop.id, routeEntry.routeId, now, 1);
      if (!next) {
        return routeEntry.arrivals.length === 0
          ? noPublishedTimeLine(routeEntry, stop.lat, stop.lon, stop.id, now)
          : `${routeLabel(routeEntry)} -- NO MORE SERVICE TODAY`;
      }
      const day = next.isTomorrow ? 'TOMORROW ' : '';
      const timing = next.minutesUntil > COUNTDOWN_THRESHOLD_MIN
        ? `${day}AT ${next.clock}`
        : `${next.minutesUntil} MIN (${day}${next.clock})`;
      return `${routeLabel(next)} -- ${timing} TOWARD ${next.headsign.toUpperCase() || 'N/A'}`;
    });
  }

  function withNextArrivals(stop, now) {
    const lines = nextArrivalLines(stop, now);
    return lines.length ? `\nNEXT ARRIVALS:\n${lines.join('\n')}` : '';
  }

  /** "did you mean X, Y, or Z?" when fuzzy matching found 2-4 equally-good candidates instead of one clear winner -- see intentParser.js's pickBestOrFlagTie for why this can happen (git's "did you mean" precedent: list every tied candidate, don't silently guess). */
  function disambiguationMessage(entity, kind) {
    const names = [entity.name, ...entity.alternatives.map((a) => a.name)];
    return `MULTIPLE ${kind} MATCH THAT: ${names.map((n) => n.toUpperCase()).join(' / ')}. TRY BEING MORE SPECIFIC.`;
  }

  /** Past this many minutes out, show a plain clock time instead of a countdown -- "in 47 min" implies false precision this far ahead; industry-standard cutover for transit-arrival displays. */
  const COUNTDOWN_THRESHOLD_MIN = 30;

  /**
   * Straight-line-nearest stop to a raw {lat, lon} -- shared by the GPS
   * fallback path here and in answerFindNearestStop. Distinct from that
   * function's landmark version: no geocoding, the coordinates are
   * already known (came straight off the device).
   */
  function nearestStopToPoint(lat, lon) {
    let best = null;
    for (const stop of Object.values(dataset.stops)) {
      if (stop.lat == null || stop.lon == null) continue;
      const dist = haversineMiles(lat, lon, stop.lat, stop.lon);
      if (!best || dist < best.dist) best = { stop, dist };
    }
    return best;
  }

  /**
   * Reconstructs each real trip's own ordered (stopId, minutes) path from
   * the stop-keyed data the client already has -- no backend/ETL change
   * needed, since every stop's routes[].arrivals entry already carries
   * its tripId. Grouping those by tripId across every stop and sorting
   * by raw minutes recovers exactly the trip's true stop_times order
   * (GTFS keeps a trip's own times monotonically increasing, including
   * past-midnight rows encoded as >= 1440 -- see resolveArrivalTiming).
   * Only stops with a PUBLISHED time appear (the same 81%-blank-
   * stop_times gap noted in the README) -- a trip planner can only ever
   * board/alight where a real time exists anyway, so this is the right
   * set of usable stops for that purpose, not a lossy subset of it.
   * Built once per dataset and cached -- cheap to build (single pass
   * over data already in memory) but no reason to redo it per query.
   */
  function getTripsIndex() {
    if (tripsIndexCache) return tripsIndexCache;
    const trips = new Map(); // tripId -> { routeId, serviceId, headsign, stops: [{stopId, minutes}] sorted ascending
    for (const stop of Object.values(dataset.stops)) {
      for (const routeEntry of stop.routes) {
        for (const arr of routeEntry.arrivals) {
          if (!trips.has(arr.tripId)) {
            trips.set(arr.tripId, { routeId: routeEntry.routeId, serviceId: arr.serviceId, headsign: arr.headsign, stops: [] });
          }
          trips.get(arr.tripId).stops.push({ stopId: stop.id, minutes: arr.minutes });
        }
      }
    }
    for (const trip of trips.values()) trip.stops.sort((a, b) => a.minutes - b.minutes);
    tripsIndexCache = trips;
    return tripsIndexCache;
  }

  /**
   * Reverse index of getTripsIndex(): stopId -> [{tripId, idx}], `idx`
   * being that stop's position within the trip's own (already time-
   * sorted) stops array. Lets the trip planner ask "which trips pass
   * through this exact stop, and where in their path" in time
   * proportional to just those trips, instead of scanning every trip in
   * the system per candidate boarding stop -- the difference between a
   * fast query and a slow one once a merged multi-agency dataset has
   * thousands of trips (a full HART-sized system) rather than Hernando's
   * original ~150.
   */
  function getStopTripIndex() {
    if (stopTripIndexCache) return stopTripIndexCache;
    const index = new Map();
    for (const [tripId, trip] of getTripsIndex()) {
      trip.stops.forEach((s, idx) => {
        if (!index.has(s.stopId)) index.set(s.stopId, []);
        index.get(s.stopId).push({ tripId, idx });
      });
    }
    stopTripIndexCache = index;
    return stopTripIndexCache;
  }

  // How far a rider is assumed willing to walk between two DIFFERENT
  // agencies' stops to transfer between them -- e.g. a PascoGo stop and
  // a nearby HART stop a block apart at a regional connection point.
  // Deliberately smaller than MAX_WALK_MILES below (boarding/alighting
  // at a trip's own ends): a mid-trip cross-agency transfer is a real
  // extra cost every leg of the itinerary pays, so it's held to a
  // tighter, more realistic walk than "how far would I walk to start my
  // whole trip."
  const TRANSFER_WALK_MAX_MILES = 0.3;
  // Coarse spatial-hash bucket size (degrees) for getNearbyStopsIndex --
  // larger than TRANSFER_WALK_MAX_MILES so checking a point's own bucket
  // plus its 8 neighbors can never miss a real match near a bucket edge.
  const TRANSFER_GRID_CELL_DEG = 0.01;

  /**
   * For every stop, the other stops from a DIFFERENT agency within
   * TRANSFER_WALK_MAX_MILES -- this is the actual mechanism that makes
   * cross-county trip planning possible at all: separately-run transit
   * agencies never share a literal stop id (there's no GTFS concept of
   * "these two agencies' stops are the same place"), so a real-world
   * transfer between them only ever exists as "get off here, walk a
   * short distance, board a different agency's bus over there." Single-
   * agency datasets (no stop has an `agencyId` at all) naturally produce
   * an empty index here -- every stop's own agencyId is `undefined`,
   * so the `candidate.agencyId === stop.agencyId` check below is always
   * true and nothing is ever added, meaning this adds no behavior change
   * for a non-merged dataset.
   *
   * Bucketed by a coarse lat/lon grid (spatial hash) rather than a full
   * pairwise O(n²) scan -- meaningful once a merged dataset has several
   * thousand stops (a full Tampa-area system) rather than Hernando's
   * original ~370.
   */
  function getNearbyStopsIndex() {
    if (nearbyStopsIndexCache) return nearbyStopsIndexCache;
    const buckets = new Map();
    const bucketKey = (lat, lon) => `${Math.floor(lat / TRANSFER_GRID_CELL_DEG)},${Math.floor(lon / TRANSFER_GRID_CELL_DEG)}`;
    for (const stop of Object.values(dataset.stops)) {
      if (stop.lat == null || stop.lon == null) continue;
      const key = bucketKey(stop.lat, stop.lon);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(stop);
    }

    const nearby = new Map();
    for (const stop of Object.values(dataset.stops)) {
      if (stop.lat == null || stop.lon == null) continue;
      const results = [];
      const cellLat = Math.floor(stop.lat / TRANSFER_GRID_CELL_DEG);
      const cellLon = Math.floor(stop.lon / TRANSFER_GRID_CELL_DEG);
      for (let dLat = -1; dLat <= 1; dLat++) {
        for (let dLon = -1; dLon <= 1; dLon++) {
          const bucket = buckets.get(`${cellLat + dLat},${cellLon + dLon}`);
          if (!bucket) continue;
          for (const candidate of bucket) {
            if (candidate.id === stop.id || candidate.agencyId === stop.agencyId) continue;
            const dist = haversineMiles(stop.lat, stop.lon, candidate.lat, candidate.lon);
            if (dist <= TRANSFER_WALK_MAX_MILES) results.push({ stop: candidate, dist });
          }
        }
      }
      results.sort((a, b) => a.dist - b.dist);
      nearby.set(stop.id, results);
    }
    nearbyStopsIndexCache = nearby;
    return nearbyStopsIndexCache;
  }

  /**
   * When a route serves a stop but the feed has no published times for
   * it there (the 81%-blank-stop_times gap noted in the README) --
   * finds the geographically closest OTHER stop on that same route
   * that DOES have real published times, so a rider gets some real (if
   * approximate) schedule info instead of nothing. Anchored at the
   * ORIGINAL stop's own coordinates, not the rider's raw GPS point, so
   * this works identically whether the query came from GPS or a named
   * stop/landmark.
   */
  function nearestStopWithDataForRoute(routeId, anchorLat, anchorLon, excludeStopId) {
    const route = dataset.routes[routeId];
    if (!route || anchorLat == null || anchorLon == null) return null;
    let best = null;
    for (const stopId of route.stopIds) {
      if (stopId === excludeStopId) continue;
      const candidate = dataset.stops[stopId];
      if (!candidate || candidate.lat == null || candidate.lon == null) continue;
      const routeEntry = candidate.routes.find((r) => r.routeId === routeId);
      if (!routeEntry || routeEntry.arrivals.length === 0) continue;
      const dist = haversineMiles(anchorLat, anchorLon, candidate.lat, candidate.lon);
      if (!best || dist < best.dist) best = { stop: candidate, dist };
    }
    return best;
  }

  /**
   * Formats the "no published times at this stop" fallback line for one
   * route -- looks up that route's actual next departure at the nearest
   * OTHER stop that has one (via nearestStopWithDataForRoute, which
   * already handles the cross-midnight/tomorrow rollover through
   * nextArrivals), labeled clearly as "VIA <stop>" rather than implying
   * it's this stop's own time. Falls back to the old plain admission if
   * no nearby stop on the route has any published data either. Shared
   * by nextArrivalLines and answerFindNextArrival so "nearest stop to
   * X" and "when's the next bus at X" give the same fallback for the
   * same underlying data gap instead of two different behaviors.
   */
  function noPublishedTimeLine(routeEntry, anchorLat, anchorLon, excludeStopId, now) {
    const nearby = nearestStopWithDataForRoute(routeEntry.routeId, anchorLat, anchorLon, excludeStopId);
    if (nearby) {
      const [next] = nextArrivals(nearby.stop.id, routeEntry.routeId, now, 1);
      if (next) {
        const day = next.isTomorrow ? 'TOMORROW ' : '';
        const timing = next.minutesUntil > COUNTDOWN_THRESHOLD_MIN
          ? `${day}AT ${next.clock}`
          : `${next.minutesUntil} MIN (${day}${next.clock})`;
        return `${routeLabel(routeEntry)} -- NO PUBLISHED TIME HERE; NEXT DEPARTURE VIA ${nearby.stop.name.toUpperCase()} (${nearby.dist.toFixed(2)} MI AWAY) -- ${timing}`;
      }
    }
    return `${routeLabel(routeEntry)} -- SERVES THIS STOP, BUT NO PUBLISHED TIMES ARE AVAILABLE FOR IT`;
  }

  async function answerFindNextArrival(parsed, now) {
    let usedGps = false;
    if (!parsed.stop) {
      // No stop/landmark named at all -- fall back to the device's own
      // GPS position instead of immediately giving up, same "pull my
      // location" behavior requested for FIND_NEAREST_STOP.
      const pos = await TheBusGeolocate.getCurrentPosition();
      if (!pos) {
        return "I DIDN'T CATCH A STOP NAME. TRY: WHEN IS THE NEXT BUS AT <STOP NAME>? OR TURN ON LOCATION AND JUST ASK: WHEN IS THE NEXT BUS?";
      }
      const nearest = nearestStopToPoint(pos.lat, pos.lon);
      if (!nearest) return 'NO STOPS ON FILE.';
      parsed = { ...parsed, stop: { id: nearest.stop.id, name: nearest.stop.name, score: 1, alternatives: [] } };
      usedGps = true;
    }
    if (parsed.stop.alternatives.length > 0) return disambiguationMessage(parsed.stop, 'STOPS');
    if (parsed.route && parsed.route.alternatives.length > 0) return disambiguationMessage(parsed.route, 'ROUTES');
    const stop = dataset.stops[parsed.stop.id];

    if (parsed.route) {
      const servesStop = stop.routes.some((r) => r.routeId === parsed.route.id);
      if (!servesStop) {
        const route = dataset.routes[parsed.route.id];
        const routesHere = stop.routes.map((r) => routeLabel(r).replace(/^ROUTE /, '')).join(', ') || 'NONE ON FILE';
        return `${routeLabel(route)} DOES NOT SERVE ${stop.name.toUpperCase()}. ROUTES HERE: ${routesHere}.`;
      }
    }

    const relevantRoutes = parsed.route ? stop.routes.filter((r) => r.routeId === parsed.route.id) : stop.routes;
    const arrivals = nextArrivals(parsed.stop.id, parsed.route ? parsed.route.id : null, now, 3);

    const lines = arrivals.map((a) => {
      const day = a.isTomorrow ? 'TOMORROW ' : '';
      const timing = a.minutesUntil > COUNTDOWN_THRESHOLD_MIN
        ? `${day}AT ${a.clock}`
        : `${a.minutesUntil} MIN (${day}${a.clock})`;
      return `${routeLabel(a)} -- ${timing} TOWARD ${a.headsign.toUpperCase() || 'N/A'}`;
    });

    // A multi-route stop shouldn't just silently drop a route the rider
    // might be waiting for -- call out routes with zero upcoming
    // arrivals by name instead of collapsing everything into one
    // generic stop-level "nothing found" message.
    const routesWithArrivals = new Set(arrivals.map((a) => a.routeId));
    for (const r of relevantRoutes) {
      if (routesWithArrivals.has(r.routeId)) continue;
      // r.arrivals is the route's FULL, unfiltered arrival list (before
      // today's date/time filtering) -- if it's empty even before any
      // filtering, this route genuinely has no published times for this
      // stop at all (a non-"timepoint" stop in the feed), which is a
      // different situation from "ran today, already finished."
      lines.push(r.arrivals.length === 0
        ? noPublishedTimeLine(r, stop.lat, stop.lon, stop.id, now)
        : `${routeLabel(r)} -- NO MORE SERVICE TODAY`);
    }

    const stopLabel = usedGps ? `${stop.name.toUpperCase()} (NEAREST TO YOU)` : stop.name.toUpperCase();
    if (lines.length === 0) {
      return `NO SERVICE TODAY AT ${stopLabel}.`;
    }
    return `NEXT ARRIVALS AT ${stopLabel}:\n${lines.join('\n')}`;
  }

  function answerFindStopLocation(parsed) {
    if (!parsed.stop) {
      return "I DIDN'T CATCH A STOP NAME. TRY: WHERE IS <STOP NAME>?";
    }
    if (parsed.stop.alternatives.length > 0) return disambiguationMessage(parsed.stop, 'STOPS');
    const stop = dataset.stops[parsed.stop.id];
    setLastLocation(stop.lat, stop.lon, stop.name);
    const routeList = stop.routes.map((r) => routeLabel(r).replace(/^ROUTE /, '')).join(', ') || 'NONE ON FILE';
    const coords = (stop.lat != null && stop.lon != null)
      ? `${stop.lat.toFixed(5)}, ${stop.lon.toFixed(5)}`
      : 'UNAVAILABLE';
    return `STOP: ${stop.name.toUpperCase()}\nCOORDINATES: ${coords}\nSERVED BY ROUTES: ${routeList}`;
  }

  function answerListRouteStops(parsed) {
    if (!parsed.route) {
      return "I DIDN'T CATCH A ROUTE. TRY: LIST STOPS ON ROUTE 10.";
    }
    if (parsed.route.alternatives.length > 0) return disambiguationMessage(parsed.route, 'ROUTES');
    const route = dataset.routes[parsed.route.id];
    const names = route.stopIds.map((id) => dataset.stops[id]?.name).filter(Boolean);
    const label = routeLabel(route);
    if (names.length === 0) return `NO STOPS ON FILE FOR ${label}.`;
    return `${label} STOPS:\n${names.map((n, i) => `${i + 1}. ${n.toUpperCase()}`).join('\n')}`;
  }

  /** "FIRST BUS" / "LAST BUS" -- distinct from "next bus": needs the whole day's schedule (dayArrivals), not just what's still upcoming, so it still answers correctly even late at night after service has ended for the day. */
  function answerFindFirstLastBus(parsed, now) {
    if (!parsed.stop) {
      return "I DIDN'T CATCH A STOP NAME. TRY: FIRST BUS AT <STOP NAME>? OR LAST BUS AT <STOP NAME>?";
    }
    if (parsed.stop.alternatives.length > 0) return disambiguationMessage(parsed.stop, 'STOPS');
    if (parsed.route && parsed.route.alternatives.length > 0) return disambiguationMessage(parsed.route, 'ROUTES');
    const stop = dataset.stops[parsed.stop.id];

    if (parsed.route) {
      const servesStop = stop.routes.some((r) => r.routeId === parsed.route.id);
      if (!servesStop) {
        const route = dataset.routes[parsed.route.id];
        const routesHere = stop.routes.map((r) => routeLabel(r).replace(/^ROUTE /, '')).join(', ') || 'NONE ON FILE';
        return `${routeLabel(route)} DOES NOT SERVE ${stop.name.toUpperCase()}. ROUTES HERE: ${routesHere}.`;
      }
    }

    const all = dayArrivals(parsed.stop.id, parsed.route ? parsed.route.id : null, now);
    if (all.length === 0) {
      return `NO SERVICE TODAY AT ${stop.name.toUpperCase()}.`;
    }
    const picked = parsed.firstOrLast === 'last' ? all[all.length - 1] : all[0];
    const label = parsed.firstOrLast === 'last' ? 'LAST BUS' : 'FIRST BUS';
    return `${label} TODAY AT ${stop.name.toUpperCase()}:\n${routeLabel(picked)} -- AT ${picked.clock} TOWARD ${picked.headsign.toUpperCase() || 'N/A'}`;
  }

  // Recognizes the rider referring to their own position instead of a
  // named place ("nearest stop to me", "closest stop to here") -- routed
  // to GPS instead of ever being handed to the geocoder, which has no
  // way to resolve "me" to anything.
  const SELF_LOCATION_RE = /^(me|here|my location|my current location|my position)$/i;

  function knownStopAnswer(landmarkLabel, stop, now) {
    const routesHere = stop.routes.map((r) => routeLabel(r).replace(/^ROUTE /, '')).join(', ') || 'NONE ON FILE';
    setLastLocation(stop.lat, stop.lon, stop.name);
    return `"${landmarkLabel.toUpperCase()}" IS A KNOWN STOP:\n${stop.name.toUpperCase()}\nSERVED BY ROUTES: ${routesHere}${withNextArrivals(stop, now)}`;
  }

  function nearestToPointAnswer(landmarkLabel, lat, lon, now) {
    const best = nearestStopToPoint(lat, lon);
    if (!best) return 'NO STOPS ON FILE.';
    const routesHere = best.stop.routes.map((r) => routeLabel(r).replace(/^ROUTE /, '')).join(', ') || 'NONE ON FILE';
    setLastLocation(best.stop.lat, best.stop.lon, best.stop.name);
    return `NEAREST STOP TO ${landmarkLabel.toUpperCase()}:\n${best.stop.name.toUpperCase()} (${best.dist.toFixed(2)} MI AWAY)\nSERVED BY ROUTES: ${routesHere}${withNextArrivals(best.stop, now)}`;
  }

  /**
   * Resolves any free-text landmark string to an actual place, checked
   * in order across all 3 search tiers, cheapest/most-confident first --
   * shared by FIND_NEAREST_STOP and PLAN_TRIP, since both ultimately
   * need "turn this free-text phrase into a real point on the map":
   *   TIER 3 (LANGUAGE) -- this exact phrase resolved confidently
   *      before ("walmart on 19" was already looked up once) -- an
   *      instant, offline, guaranteed-consistent repeat answer, no
   *      matching or network work at all.
   *   TIER 1 (GTFS) -- the phrase is already the (informal) name of a
   *      known stop itself ("walmart on 19" for the stop "Walmart US19
   *      Spring Hill") -- checked via the SAME fuzzy stop-name matching
   *      every other intent uses, fully offline.
   *   (GPS) -- the rider's own position ("nearest stop to me") -- not
   *      cached, since "me" resolves to a different point every time.
   *   TIER 2 (PLACES) -- a real-world place (business, school,
   *      landmark) this device has successfully geocoded before --
   *      offline and instant, since it's just a local coordinate lookup
   *      now, no network round trip needed a second time.
   *   NETWORK -- a genuine place never seen before -- resolved via
   *      TheBusGeocode, the one part of this query that truly can't
   *      work offline. Successful lookups get folded into tiers 2 and 3
   *      for next time, so the app's local knowledge only ever grows.
   *
   * Returns one of:
   *   { type: 'stop', stop, label }        -- landmarkText IS a known stop
   *   { type: 'point', lat, lon, label }   -- resolved to a coordinate
   *   { type: 'unavailable', message }     -- couldn't resolve at all;
   *      `message` is a ready-to-return rider-facing explanation.
   */
  async function resolveLandmark(landmarkText) {
    await TheBusSearchIndex.ensureLoaded();
    const normalizedLandmark = TheBusIntentParser.normalize(landmarkText);
    const isSelf = SELF_LOCATION_RE.test(landmarkText.trim());

    if (!isSelf) {
      const alias = TheBusSearchIndex.lookupAlias('landmark', normalizedLandmark);
      if (alias) {
        if (alias.kind === 'stop') {
          console.log('[thebus:tier] TIER 3 (LANGUAGE) -> stop', { query: normalizedLandmark, resolvedTo: alias.id });
          return { type: 'stop', stop: dataset.stops[alias.id], label: landmarkText };
        }
        if (alias.kind === 'place') {
          const place = TheBusSearchIndex.getPlaceById(alias.id);
          if (place) {
            console.log('[thebus:tier] TIER 3 (LANGUAGE) -> place', { query: normalizedLandmark, resolvedTo: alias.id });
            return { type: 'point', lat: place.lat, lon: place.lon, label: landmarkText };
          }
        }
      }
    }

    const directMatch = TheBusIntentParser.fuzzyMatch(normalizedLandmark, index.stops);
    if (directMatch && directMatch.alternatives.length === 0) {
      const stop = dataset.stops[directMatch.id];
      TheBusSearchIndex.recordAlias('landmark', normalizedLandmark, { kind: 'stop', id: directMatch.id, name: stop.name });
      console.log('[thebus:tier] TIER 1 (GTFS)', { query: normalizedLandmark, resolvedTo: directMatch.id });
      return { type: 'stop', stop, label: landmarkText };
    }

    if (isSelf) {
      const pos = await TheBusGeolocate.getCurrentPosition();
      if (!pos) {
        console.log('[thebus:tier] GPS -> unavailable', { query: normalizedLandmark });
        return { type: 'unavailable', message: "COULDN'T GET YOUR LOCATION. CHECK THAT LOCATION IS TURNED ON FOR THIS APP AND TRY AGAIN." };
      }
      console.log('[thebus:tier] GPS', { query: normalizedLandmark, lat: pos.lat, lon: pos.lon });
      return { type: 'point', lat: pos.lat, lon: pos.lon, label: 'you' };
    }

    const placeMatch = TheBusIntentParser.fuzzyMatch(normalizedLandmark, TheBusSearchIndex.getPlaceCandidates());
    if (placeMatch && placeMatch.alternatives.length === 0) {
      const place = TheBusSearchIndex.getPlaceById(placeMatch.id);
      TheBusSearchIndex.recordAlias('landmark', normalizedLandmark, { kind: 'place', id: place.id, name: place.name });
      console.log('[thebus:tier] TIER 2 (PLACES)', { query: normalizedLandmark, resolvedTo: place.id });
      return { type: 'point', lat: place.lat, lon: place.lon, label: landmarkText };
    }

    if (!navigator.onLine) {
      console.log('[thebus:tier] NETWORK -> skipped, offline', { query: normalizedLandmark });
      return { type: 'unavailable', message: `LOOKING UP "${landmarkText.toUpperCase()}" NEEDS A NETWORK CONNECTION. TRY AGAIN WHEN ONLINE.` };
    }

    let place;
    try {
      place = await TheBusGeocode.lookup(landmarkText);
    } catch (err) {
      console.error(err);
      return { type: 'unavailable', message: `COULDN'T LOOK UP "${landmarkText.toUpperCase()}" RIGHT NOW. TRY AGAIN IN A MOMENT.` };
    }
    if (!place) {
      console.log('[thebus:tier] NETWORK -> not found', { query: normalizedLandmark });
      return { type: 'unavailable', message: `COULDN'T FIND "${landmarkText.toUpperCase()}" NEAR HERNANDO COUNTY. TRY A NEARBY ROAD OR A BETTER-KNOWN LANDMARK -- VERY SMALL LOCAL BUSINESSES SOMETIMES AREN'T IN THE MAP DATA THIS APP USES.` };
    }

    console.log('[thebus:tier] NETWORK (geocoded, folded into tiers 2/3 for next time)', { query: normalizedLandmark, lat: place.lat, lon: place.lon });
    const placeId = TheBusSearchIndex.recordPlace({ name: landmarkText, lat: place.lat, lon: place.lon });
    TheBusSearchIndex.recordAlias('landmark', normalizedLandmark, { kind: 'place', id: placeId, name: landmarkText });
    return { type: 'point', lat: place.lat, lon: place.lon, label: landmarkText };
  }

  async function answerFindNearestStop(parsed, now) {
    if (!parsed.landmark) {
      // No place named at all ("nearest stop?", "closest bus") -- same
      // "use my location instead of giving up" fallback
      // answerFindNextArrival already applies for its own no-stop-named
      // case, so a genuinely broad, locationless question behaves the
      // same way regardless of which intent it happened to classify as.
      const pos = await TheBusGeolocate.getCurrentPosition();
      if (!pos) {
        return "I DIDN'T CATCH A PLACE NAME. TRY: NEAREST STOP TO <PLACE>? OR TURN ON LOCATION AND JUST ASK: NEAREST STOP?";
      }
      return nearestToPointAnswer('you', pos.lat, pos.lon, now);
    }
    const resolved = await resolveLandmark(parsed.landmark);
    if (resolved.type === 'unavailable') return resolved.message;
    if (resolved.type === 'stop') return knownStopAnswer(parsed.landmark, resolved.stop, now);
    return nearestToPointAnswer(resolved.label, resolved.lat, resolved.lon, now);
  }

  // Real transfers and boarding always cost a few real minutes, not zero
  // -- crossing the street or the length of a hub's platform. Also acts
  // as a floor so a same-trip "transfer" (getting off and immediately
  // reboarding the same vehicle) is never proposed as if it were free.
  const TRANSFER_BUFFER_MIN = 3;
  // Rough, deliberately simple walking-speed assumption for estimating
  // walk time to/from a boarding stop when the origin/destination is a
  // real-world point rather than a named stop -- good enough to rank
  // itineraries and give a rider a ballpark, not meant to be precise.
  const WALK_SPEED_MPH = 3;
  const MAX_WALK_MILES = 0.75;
  const MAX_BOARDING_CANDIDATES = 3;

  function walkMinutesForMiles(miles) {
    return (miles / WALK_SPEED_MPH) * 60;
  }

  /**
   * Up to MAX_BOARDING_CANDIDATES nearest stops to a raw point, each
   * with its walking distance/time -- lets the trip planner consider a
   * couple of nearby stops (not just the single closest) in case a
   * slightly farther one actually gets a rider there sooner. Falls back
   * to the single nearest stop system-wide (matching nearestStopToPoint's
   * own no-max-distance behavior) if nothing is within MAX_WALK_MILES,
   * so a rider in a sparser part of the county still gets a real answer
   * instead of "no stops nearby" for a place a bus genuinely could serve.
   */
  function nearestBoardingCandidates(lat, lon) {
    const scored = [];
    for (const stop of Object.values(dataset.stops)) {
      if (stop.lat == null || stop.lon == null) continue;
      const dist = haversineMiles(lat, lon, stop.lat, stop.lon);
      if (dist > MAX_WALK_MILES) continue;
      scored.push({ stop, dist });
    }
    scored.sort((a, b) => a.dist - b.dist);
    let candidates = scored.slice(0, MAX_BOARDING_CANDIDATES);
    if (candidates.length === 0) {
      const best = nearestStopToPoint(lat, lon);
      if (best) candidates = [best];
    }
    return candidates.map((c) => ({ stop: c.stop, dist: c.dist, walkMinutes: walkMinutesForMiles(c.dist) }));
  }

  /**
   * Turns a resolveLandmark() result into the set of stops a rider could
   * plausibly board/alight at. A resolved KNOWN STOP is its own single
   * candidate at zero walk distance -- the rider named that exact stop,
   * so suggesting a "closer" neighbor instead would be a confusing
   * answer to a question they didn't ask. A resolved real-world POINT
   * (GPS, a geocoded place) instead gets the nearest few stops, since
   * there's no single "correct" stop to anchor to.
   */
  function boardingCandidatesFor(resolved) {
    if (resolved.type === 'stop') return [{ stop: resolved.stop, dist: 0, walkMinutes: 0 }];
    return nearestBoardingCandidates(resolved.lat, resolved.lon);
  }

  function resolvedPoint(resolved) {
    return resolved.type === 'stop'
      ? { lat: resolved.stop.lat, lon: resolved.stop.lon }
      : { lat: resolved.lat, lon: resolved.lon };
  }

  // A regional trip (Citrus through Hernando into Tampa) can genuinely
  // need several agency-to-agency transfers, not just one -- this caps
  // it at 3 (4 legs total), comfortably covering a full cross-4-agency
  // journey while keeping the search bounded. See getStopTripIndex()'s
  // comment for why this stays fast even at that depth on a large
  // merged dataset: each round only ever examines trips that actually
  // pass through a reached stop, not every trip in the system.
  const MAX_TRANSFERS = 3;

  /**
   * Seeds round 0: the boarding candidates themselves, each "reached" at
   * its own walk time with no ride taken yet (`legs: []`).
   */
  function seedReach(candidates) {
    const reach = new Map();
    for (const seed of candidates) {
      const existing = reach.get(seed.stop.id);
      if (!existing || seed.walkMinutes < existing.minutesUntil) {
        reach.set(seed.stop.id, { minutesUntil: seed.walkMinutes, legs: [], originCandidate: seed });
      }
    }
    return reach;
  }

  /**
   * Earliest-arrival search, one RAPTOR-style round: from every stop
   * reached so far, find the best next ride (plus a real transfer
   * buffer, waived for round 0's own boarding candidates -- walking up
   * and boarding needs no extra buffer beyond the walk time already
   * counted). Also allows walking to a nearby DIFFERENT-agency stop
   * before boarding (via getNearbyStopsIndex()) -- the actual mechanism
   * that connects otherwise-independent county systems together, since
   * two agencies never share a literal stop id. Excludes re-boarding the
   * exact trip a rider is already on, which isn't a transfer at all.
   *
   * Uses getStopTripIndex() rather than scanning every trip per seed --
   * only trips that actually pass through a given boarding stop are
   * ever examined, which is what keeps this fast at the scale of a
   * merged multi-agency dataset (thousands of trips) rather than
   * Hernando's original ~150.
   */
  function relaxRound(prevReach, now) {
    const nextReach = new Map();
    const stopTripIndex = getStopTripIndex();
    const tripsIndex = getTripsIndex();
    const nearbyIndex = getNearbyStopsIndex();

    function tryBoardFrom(boardStop, readyMinutes, prevRec, excludeTripId, transferWalkMiles) {
      for (const { tripId, idx: boardIdx } of stopTripIndex.get(boardStop.id) || []) {
        if (tripId === excludeTripId) continue;
        const trip = tripsIndex.get(tripId);
        const boardTiming = resolveArrivalTiming(trip.serviceId, trip.stops[boardIdx].minutes, now);
        if (!boardTiming || boardTiming.minutesUntil < readyMinutes) continue;

        for (let i = boardIdx + 1; i < trip.stops.length; i++) {
          const alightStopId = trip.stops[i].stopId;
          const alightTiming = resolveArrivalTiming(trip.serviceId, trip.stops[i].minutes, now);
          if (!alightTiming) continue;
          const existing = nextReach.get(alightStopId);
          if (existing && existing.minutesUntil <= alightTiming.minutesUntil) continue;
          nextReach.set(alightStopId, {
            minutesUntil: alightTiming.minutesUntil,
            originCandidate: prevRec.originCandidate,
            legs: [...prevRec.legs, {
              routeId: trip.routeId,
              tripId,
              headsign: trip.headsign,
              boardStop,
              boardTiming,
              alightStop: dataset.stops[alightStopId],
              alightTiming,
              transferWalkMiles: transferWalkMiles || 0,
            }],
          });
        }
      }
    }

    for (const [stopId, rec] of prevReach) {
      const stop = dataset.stops[stopId];
      if (!stop) continue;
      const readyMinutes = rec.legs.length > 0 ? rec.minutesUntil + TRANSFER_BUFFER_MIN : rec.minutesUntil;
      const lastTripId = rec.legs.length > 0 ? rec.legs[rec.legs.length - 1].tripId : null;
      tryBoardFrom(stop, readyMinutes, rec, lastTripId, 0);

      for (const { stop: nearbyStop, dist } of nearbyIndex.get(stopId) || []) {
        tryBoardFrom(nearbyStop, readyMinutes + walkMinutesForMiles(dist), rec, null, dist);
      }
    }
    return nextReach;
  }

  function formatArrivalClock(timing) {
    const day = timing.isTomorrow ? 'TOMORROW ' : '';
    return timing.minutesUntil > COUNTDOWN_THRESHOLD_MIN
      ? `${day}${formatClock(timing.wallMinutes)}`
      : `${timing.minutesUntil} MIN (${day}${formatClock(timing.wallMinutes)})`;
  }

  function formatTripLeg(leg, index) {
    const route = dataset.routes[leg.routeId];
    const lines = [];
    if (leg.transferWalkMiles > 0) {
      lines.push(`   WALK ${leg.transferWalkMiles.toFixed(2)} MI TO ${leg.boardStop.name.toUpperCase()} (~${Math.round(walkMinutesForMiles(leg.transferWalkMiles))} MIN)`);
    }
    lines.push(`${index + 1}. BOARD ${routeLabel(route)} TOWARD ${(leg.headsign || 'N/A').toUpperCase()} AT ${leg.boardStop.name.toUpperCase()} -- ${formatArrivalClock(leg.boardTiming)}`);
    lines.push(`   RIDE TO ${leg.alightStop.name.toUpperCase()} -- ARRIVE ${formatArrivalClock(leg.alightTiming)}`);
    return lines.join('\n');
  }

  function formatTripPlan(originResolved, destResolved, best) {
    const lines = [`TRIP FROM ${(originResolved.label || '').toUpperCase()} TO ${(destResolved.label || '').toUpperCase()}:`];
    if (best.originCandidate.walkMinutes > 0.5) {
      lines.push(`WALK ${best.originCandidate.dist.toFixed(2)} MI TO ${best.originCandidate.stop.name.toUpperCase()} (~${Math.round(best.originCandidate.walkMinutes)} MIN)`);
    }
    best.legs.forEach((leg, i) => {
      lines.push(formatTripLeg(leg, i));
      // A walk-based transfer prints its own "WALK ... MI TO ..." line
      // (via the NEXT leg's own formatTripLeg call, since that's the leg
      // that actually walked somewhere before boarding) -- only add the
      // plain "TRANSFER" note when the next leg boarded with no walk
      // (a same-stop reboard), so the two notes are never redundant.
      if (i < best.legs.length - 1 && best.legs[i + 1].transferWalkMiles === 0) lines.push(`   TRANSFER (${TRANSFER_BUFFER_MIN}+ MIN)`);
    });
    if (best.destCandidate.walkMinutes > 0.5) {
      lines.push(`WALK ${best.destCandidate.dist.toFixed(2)} MI FROM ${best.destCandidate.stop.name.toUpperCase()} TO YOUR DESTINATION (~${Math.round(best.destCandidate.walkMinutes)} MIN)`);
    }
    const transferNote = best.legs.length > 1 ? ` (${best.legs.length - 1} TRANSFER${best.legs.length > 2 ? 'S' : ''})` : ' (DIRECT)';
    lines.push(`TOTAL TRAVEL TIME: ~${Math.round(best.total)} MIN${transferNote}`);
    return lines.join('\n');
  }

  /**
   * "I need to go from X to Y" -- plans an actual multi-leg transit
   * itinerary instead of just answering about one stop at a time. Both
   * ends are resolved through the exact same tiered landmark resolution
   * as FIND_NEAREST_STOP (resolveLandmark), so a named stop, a real-world
   * place, or "me"/"here" for either end all work identically to how
   * they already do elsewhere in the app.
   *
   * The search itself considers up to MAX_TRANSFERS transfers across
   * every real trip currently running, reconstructed from the same
   * offline dataset via getTripsIndex() -- no network needed beyond
   * whatever resolveLandmark's own tiers require to resolve a real-world
   * place name. A single-agency deployment (e.g. Hernando alone) never
   * needs anywhere near that many transfers in practice, so this bound
   * mainly matters for a full multi-agency, multi-county journey, where
   * getNearbyStopsIndex() lets a leg end on one agency's network and the
   * next begin on another's via a short walk. Picks the itinerary with
   * the lowest total real-world time (ride time plus every walk segment,
   * including both ends), preferring fewer transfers whenever two
   * itineraries would arrive at the same time.
   */
  async function answerPlanTrip(parsed, now) {
    if (!parsed.origin || !parsed.destination) {
      return "I DIDN'T CATCH BOTH A START AND AN END. TRY: FROM <PLACE> TO <PLACE>?";
    }

    const [originResolved, destResolved] = await Promise.all([
      resolveLandmark(parsed.origin),
      resolveLandmark(parsed.destination),
    ]);
    if (originResolved.type === 'unavailable') return originResolved.message;
    if (destResolved.type === 'unavailable') return destResolved.message;

    const originPt = resolvedPoint(originResolved);
    const destPt = resolvedPoint(destResolved);
    if (originPt.lat != null && originPt.lon != null && destPt.lat != null && destPt.lon != null) {
      const straightLineMiles = haversineMiles(originPt.lat, originPt.lon, destPt.lat, destPt.lon);
      if (straightLineMiles < 0.2) {
        return `${(originResolved.label || '').toUpperCase()} AND ${(destResolved.label || '').toUpperCase()} ARE ONLY ${straightLineMiles.toFixed(2)} MI APART -- WALKING IS PROBABLY FASTER THAN A BUS.`;
      }
    }

    const originCandidates = boardingCandidatesFor(originResolved);
    const destCandidates = boardingCandidatesFor(destResolved);
    if (originCandidates.length === 0) return `COULDN'T FIND A NEARBY STOP FOR "${parsed.origin.toUpperCase()}".`;
    if (destCandidates.length === 0) return `COULDN'T FIND A NEARBY STOP FOR "${parsed.destination.toUpperCase()}".`;

    const rounds = [seedReach(originCandidates)];
    for (let i = 0; i < MAX_TRANSFERS + 1; i++) rounds.push(relaxRound(rounds[rounds.length - 1], now));

    let best = null;
    for (const dest of destCandidates) {
      for (const reach of rounds) {
        const r = reach.get(dest.stop.id);
        if (!r || r.legs.length === 0) continue; // a bare "you're already there" seed isn't a real itinerary
        const total = r.minutesUntil + dest.walkMinutes;
        const better = !best
          || total < best.total - 0.001
          || (Math.abs(total - best.total) < 0.001 && r.legs.length < best.legs.length);
        if (better) best = { total, originCandidate: r.originCandidate, destCandidate: dest, legs: r.legs };
      }
    }

    if (!best) {
      return `COULDN'T FIND A BUS CONNECTION FROM "${parsed.origin.toUpperCase()}" TO "${parsed.destination.toUpperCase()}" RIGHT NOW -- TRY A DIFFERENT TIME, OR CHECK THAT BOTH PLACES ARE NEAR A ROUTE THAT'S CURRENTLY RUNNING.`;
    }
    return formatTripPlan(originResolved, destResolved, best);
  }

  /**
   * A query with no recognized command keyword at all ("Avalon Publix",
   * just a stop name with no "when"/"where"/etc.) used to fall straight
   * to the generic help text, even though extractStop/extractRoute
   * (which run unconditionally in parseQuery, regardless of intent)
   * already found the entity with full confidence -- silently
   * contradicting onboarding's own "you can always skip this and just
   * type a stop or place name instead." Answers exactly as the
   * equivalent explicit command would rather than a fresh code path, so
   * disambiguation/route-filtering/etc. all still apply unchanged.
   */
  function answerBareLookup(parsed, now) {
    if (parsed.stop) return answerFindNextArrival(parsed, now);
    if (parsed.route) return answerListRouteStops(parsed);
    return "COMMAND NOT RECOGNIZED. TRY:\n- WHEN IS THE NEXT BUS AT <STOP>?\n- WHERE IS <STOP>?\n- LIST STOPS ON ROUTE <N>\n- NEAREST STOP TO <PLACE>?\n- FIRST/LAST BUS AT <STOP>?\n- FROM <PLACE> TO <PLACE>?";
  }

  /**
   * @param {string} text - raw rider input
   * @param {Date} now - device clock (caller-supplied so this stays pure/testable)
   */
  async function answerQuery(text, now) {
    setLastLocation(null, null, null);
    if (!dataset) return 'DATASET NOT LOADED. CHECK YOUR CONNECTION AND RESTART.';
    const parsed = TheBusIntentParser.parseQuery(text, index);

    switch (parsed.intent) {
      case 'PLAN_TRIP': return answerPlanTrip(parsed, now);
      case 'FIND_NEAREST_STOP': return answerFindNearestStop(parsed, now);
      case 'FIND_FIRST_LAST_BUS': return answerFindFirstLastBus(parsed, now);
      case 'FIND_NEXT_ARRIVAL': return answerFindNextArrival(parsed, now);
      case 'FIND_STOP_LOCATION': return answerFindStopLocation(parsed);
      case 'LIST_ROUTE_STOPS': return answerListRouteStops(parsed);
      default:
        return answerBareLookup(parsed, now);
    }
  }

  global.TheBusQueryEngine = { setDataset, getIndex, answerQuery, nextArrivals, isServiceActive, getLastLocation };
})(window);
