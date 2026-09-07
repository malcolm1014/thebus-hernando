/**
 * Vehicle allocation: given a live vehicle's raw {lat, lon, course} on a
 * known route, figures out which SPECIFIC scheduled trip it's most
 * likely running -- something Passio/Avail's own feeds never tell us
 * (they report a routeId, never a trip_id -- see liveMap.js's own doc
 * comment on activeBusSummaries()). Knowing the trip is what turns "a bus
 * is somewhere on route 5" into "running about 6 minutes behind
 * schedule," and is the same problem OneBusAway/Transitime's AVL
 * matching solves with a full dispatch feed -- this is a much lighter
 * heuristic built only from data already in the offline dataset:
 * schedule + stop locations, no separate map-matching service.
 *
 * Deliberately does NOT project onto the route polyline for scoring
 * (unlike the visual snapping in liveMap.js/geoMath.js): a route's
 * `shapePoints` is only ONE representative polyline picked from a
 * single trip (see transform.js's own comment -- a route can have
 * several shape_ids for different directions/branches), so distance
 * along ITS shape doesn't reliably tell two trips apart. Instead this
 * scores candidates by comparing the vehicle's actual position against
 * where each candidate trip's OWN stop-to-stop schedule says it should
 * be right now, in between two real, per-trip stop coordinates --
 * accurate for the one thing that matters here (division ranking, not
 * absolute path shape) and needs nothing beyond what's already in
 * getTripsIndex().
 */
(function (global) {
  const DEFAULT_SLACK_MINUTES = 15; // how far before its first/after its last stop a trip is still considered "could be running now"
  const HEADING_REJECT_DEG = 120; // vehicle heading this far from the trip's expected direction of travel rules the candidate out
  const MAX_PLAUSIBLE_MILES = 2; // a "best" candidate farther than this from its own expected position isn't a confident match

  function haversineMiles(lat1, lon1, lat2, lon2) {
    const R = 3958.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function bearingDeg(lat1, lon1, lat2, lon2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const p1 = toRad(lat1);
    const p2 = toRad(lat2);
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function bearingDiffDeg(a, b) {
    const diff = Math.abs(a - b) % 360;
    return diff > 180 ? 360 - diff : diff;
  }

  /**
   * Trips on `routeId` whose own schedule window (first stop's minutes
   * to last stop's minutes, plus `slackMinutes` on each end) covers
   * `agencyMinutes` and whose service is active right now. `trips` is
   * the Map from queryEngine.js's getTripsIndex(); `now` + `isActiveFn`
   * let callers reuse queryEngine's own isServiceActive/agency-calendar
   * logic rather than duplicating it.
   */
  function candidateTrips(trips, routeId, agencyMinutes, now, isActiveFn, slackMinutes) {
    const slack = slackMinutes == null ? DEFAULT_SLACK_MINUTES : slackMinutes;
    const out = [];
    for (const [tripId, trip] of trips) {
      if (trip.routeId !== routeId) continue;
      if (trip.stops.length < 2) continue; // need at least 2 timed stops to interpolate an expected position
      const first = trip.stops[0].minutes;
      const last = trip.stops[trip.stops.length - 1].minutes;
      if (agencyMinutes < first - slack || agencyMinutes > last + slack) continue;
      if (!isActiveFn(trip.serviceId, now)) continue;
      out.push({ tripId, ...trip });
    }
    return out;
  }

  /**
   * Where a trip's own schedule says it should be at `agencyMinutes`,
   * linearly interpolated between the two scheduled stops that bracket
   * that time (clamped to the first/last stop before/after the trip's
   * own window). Returns null if none of the trip's stops resolve to a
   * real lat/lon in `stopsById` (a stop referenced only by id we don't
   * have coordinates for). `expectedBearingDeg` is the direction of
   * travel between those two bracketing stops -- used to reject a
   * candidate the vehicle is clearly heading away from, not toward.
   */
  function expectedPositionAt(trip, stopsById, agencyMinutes) {
    const usable = trip.stops
      .map((s) => ({ ...s, stop: stopsById[s.stopId] }))
      .filter((s) => s.stop && s.stop.lat != null && s.stop.lon != null);
    if (usable.length < 2) return null;

    let i = 0;
    while (i < usable.length - 2 && usable[i + 1].minutes < agencyMinutes) i++;
    const a = usable[i];
    const b = usable[i + 1];
    const span = b.minutes - a.minutes;
    const t = span > 0 ? Math.max(0, Math.min(1, (agencyMinutes - a.minutes) / span)) : 0;

    return {
      lat: a.stop.lat + t * (b.stop.lat - a.stop.lat),
      lon: a.stop.lon + t * (b.stop.lon - a.stop.lon),
      expectedBearingDeg: bearingDeg(a.stop.lat, a.stop.lon, b.stop.lat, b.stop.lon),
    };
  }

  /**
   * The single best trip match for a live vehicle, or null when nothing
   * clears the confidence bar (no candidate trips, or the closest one is
   * still implausibly far from where its own schedule says it should
   * be -- better to say "trip unknown" than guess wrong).
   *
   * `trips`: queryEngine.js's getTripsIndex() Map. `stopsById`:
   * dataset.stops. `now`/`isActiveFn`: passed through to candidateTrips.
   */
  function findBestTrip({ trips, stopsById, routeId, lat, lon, course, agencyMinutes, now, isActiveFn, slackMinutes }) {
    const candidates = candidateTrips(trips, routeId, agencyMinutes, now, isActiveFn, slackMinutes);
    let best = null;

    for (const trip of candidates) {
      const expected = expectedPositionAt(trip, stopsById, agencyMinutes);
      if (!expected) continue;

      if (course != null) {
        const diff = bearingDiffDeg(course, expected.expectedBearingDeg);
        if (diff > HEADING_REJECT_DEG) continue; // heading toward the opposite end of the route -- not this trip
      }

      const distanceMiles = haversineMiles(lat, lon, expected.lat, expected.lon);
      if (!best || distanceMiles < best.distanceMiles) {
        best = { tripId: trip.tripId, headsign: trip.headsign, serviceId: trip.serviceId, distanceMiles, expected };
      }
    }

    if (!best || best.distanceMiles > MAX_PLAUSIBLE_MILES) return null;
    return best;
  }

  /**
   * Schedule-adherence estimate for an already-matched trip: projects the
   * vehicle's actual {lat, lon} onto the trip's own stop-to-stop path
   * (straight lines between consecutive scheduled stops, reusing
   * geoMath.js's polyline projection -- both modules share the browser's
   * global scope, same cross-module pattern liveMap.js already uses for
   * TheBusQueryEngine/TheBusSync) to find which leg of the trip it's
   * actually on and how far along it, then reads off what time the
   * schedule says a vehicle should be at that exact spot. The difference
   * from `agencyMinutes` is how many minutes ahead/behind schedule the
   * vehicle appears to be. Returns null when there's nothing to project
   * onto (fewer than 2 usable stops) or geoMath.js isn't loaded.
   */
  function estimateScheduleDeviationMinutes(trip, stopsById, lat, lon, agencyMinutes) {
    const usable = trip.stops
      .map((s) => ({ ...s, stop: stopsById[s.stopId] }))
      .filter((s) => s.stop && s.stop.lat != null && s.stop.lon != null);
    if (usable.length < 2 || !global.TheBusGeoMath) return null;

    const polyline = usable.map((s) => [s.stop.lat, s.stop.lon]);
    const proj = global.TheBusGeoMath.nearestPointOnPolyline(lat, lon, polyline);
    if (!proj) return null;

    const a = usable[proj.segmentIndex];
    const b = usable[proj.segmentIndex + 1];
    const expectedMinutes = a.minutes + proj.t * (b.minutes - a.minutes);
    return agencyMinutes - expectedMinutes; // positive = running late, negative = running early
  }

  global.TheBusVehicleAllocation = { candidateTrips, expectedPositionAt, findBestTrip, estimateScheduleDeviationMinutes };
})(window);
