const { gtfsTimeToMinutes } = require('./gtfsParse');

const DOW_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// Route polylines were the single biggest chunk of the dataset (75KB,
// 23% of the whole payload for this feed) -- raw GTFS shapes.txt data
// at full resolution (up to ~870 points for one route) is far more
// precise than a phone-screen map needs. Douglas-Peucker simplification
// (same technique used for this project's regions.js on a sibling
// project) drops points that don't meaningfully change the visual line
// within a real-world tolerance, with no perceptible difference at
// rider-facing zoom levels.
const SHAPE_SIMPLIFY_TOLERANCE_METERS = 8;

/** Perpendicular distance from point `p` to the line through `a` and `b`, all as {x, y} in the same linear unit (meters here, via the equirectangular-ish projection below). */
function perpendicularDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
  const clampedT = Math.max(0, Math.min(1, t));
  const closestX = a.x + clampedT * dx;
  const closestY = a.y + clampedT * dy;
  return Math.hypot(p.x - closestX, p.y - closestY);
}

/** Classic recursive Douglas-Peucker line simplification. `pts` are {lat, lon, x, y} objects; returns the subset worth keeping. */
function douglasPeucker(pts, epsilonMeters) {
  if (pts.length < 3) return pts;
  let maxDist = 0;
  let index = 0;
  const end = pts.length - 1;
  for (let i = 1; i < end; i++) {
    const dist = perpendicularDistance(pts[i], pts[0], pts[end]);
    if (dist > maxDist) {
      maxDist = dist;
      index = i;
    }
  }
  if (maxDist > epsilonMeters) {
    const left = douglasPeucker(pts.slice(0, index + 1), epsilonMeters);
    const right = douglasPeucker(pts.slice(index), epsilonMeters);
    return left.slice(0, -1).concat(right);
  }
  return [pts[0], pts[end]];
}

/** Simplifies a [[lat, lon], ...] polyline. Projects to an approximate local meters-based plane first (accurate enough at single-county scale) so the tolerance is a real, meaningful distance rather than an arbitrary degree fraction. */
function simplifyShapePoints(latLonPoints, toleranceMeters) {
  if (latLonPoints.length < 3) return latLonPoints;
  const avgLat = latLonPoints.reduce((sum, p) => sum + p[0], 0) / latLonPoints.length;
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((avgLat * Math.PI) / 180);
  const pts = latLonPoints.map(([lat, lon]) => ({ lat, lon, x: lon * metersPerDegLon, y: lat * metersPerDegLat }));
  const kept = douglasPeucker(pts, toleranceMeters);
  return kept.map((p) => [p.lat, p.lon]);
}

/**
 * Flattens relational GTFS tables into the shape the mobile client wants:
 * fast lookup by stop, with arrival times pre-converted to minutes-past-
 * midnight so the client never has to parse a time string or join tables
 * on-device.
 *
 * Output shape:
 * {
 *   generatedAt: ISO string,
 *   agencyTimezone: IANA tz string (e.g. "America/New_York") -- arrival
 *     times are agency-local wall-clock time, NOT the querying device's
 *     own timezone, so the client must compute "now" in this zone rather
 *     than trusting the device's local clock/date directly.
 *   services: { [service_id]: { monday..sunday: bool, startDate, endDate, addedDates: [], removedDates: [] } },
 *   routes:   { [route_id]: { id, shortName, longName, color, textColor, stopIds: [stop_id in first-seen trip order], shapePoints: [[lat,lon], ...] for drawing the route on the map view } },
 *   stops:    {
 *     [stop_id]: {
 *       id, name, lat, lon,
 *       routes: [
 *         { routeId, shortName, longName, color,
 *           arrivals: [ { tripId, serviceId, headsign, minutes } ]  // sorted ascending, minutes may exceed 1440;
 *                                                                   // CAN BE EMPTY even though this route genuinely
 *                                                                   // serves the stop -- GTFS allows a stop_time row
 *                                                                   // with no arrival/departure time at all (a non-
 *                                                                   // "timepoint" stop meant to be interpolated,
 *                                                                   // not "not served"); the client should say so
 *                                                                   // distinctly from "no more service today"
 *         }
 *       ]
 *     }
 *   }
 * }
 */
function transform({ agency, routes, trips, stops, stopTimes, calendar, calendarDates, frequencies, shapes }) {
  const agencyTimezone = (agency[0] && agency[0].agency_timezone) || 'America/New_York';

  if (frequencies && frequencies.length > 0) {
    // Headway-based trips (frequencies.txt) generate arrivals dynamically
    // instead of listing them in stop_times.txt -- not present in
    // Hernando County's feed today, but if it (or a future second
    // agency) ever adds them, those routes would silently produce zero
    // arrivals below since we only walk stop_times. Fail loudly instead
    // of shipping a silently-broken dataset.
    throw new Error(
      `frequencies.txt has ${frequencies.length} row(s) -- headway-based trips are not supported by this transform yet.`
    );
  }

  // --- services: which days of the week / date exceptions each service_id runs ---
  const services = {};
  for (const c of calendar) {
    services[c.service_id] = {
      monday: c.monday === '1',
      tuesday: c.tuesday === '1',
      wednesday: c.wednesday === '1',
      thursday: c.thursday === '1',
      friday: c.friday === '1',
      saturday: c.saturday === '1',
      sunday: c.sunday === '1',
      startDate: c.start_date,
      endDate: c.end_date,
      addedDates: [],
      removedDates: [],
    };
  }
  for (const cd of calendarDates) {
    if (!services[cd.service_id]) {
      // service defined only via exceptions (no calendar.txt row) -- start empty
      services[cd.service_id] = {
        monday: false, tuesday: false, wednesday: false, thursday: false,
        friday: false, saturday: false, sunday: false,
        startDate: null, endDate: null, addedDates: [], removedDates: [],
      };
    }
    if (cd.exception_type === '1') services[cd.service_id].addedDates.push(cd.date);
    else if (cd.exception_type === '2') services[cd.service_id].removedDates.push(cd.date);
  }

  // --- shapes: shape_id -> [[lat, lon], ...] polyline (simplified), for drawing routes on the map view ---
  const rawShapePointsById = new Map();
  for (const pt of shapes) {
    if (!rawShapePointsById.has(pt.shape_id)) rawShapePointsById.set(pt.shape_id, []);
    rawShapePointsById.get(pt.shape_id).push({
      seq: Number(pt.shape_pt_sequence),
      point: [Number(pt.shape_pt_lat), Number(pt.shape_pt_lon)],
    });
  }
  const shapePointsById = new Map();
  for (const [shapeId, pts] of rawShapePointsById) {
    pts.sort((a, b) => a.seq - b.seq);
    shapePointsById.set(shapeId, simplifyShapePoints(pts.map((p) => p.point), SHAPE_SIMPLIFY_TOLERANCE_METERS));
  }

  // --- routes lookup ---
  const routeById = {};
  for (const r of routes) {
    routeById[r.route_id] = {
      id: r.route_id,
      shortName: r.route_short_name || '',
      longName: r.route_long_name || '',
      color: r.route_color ? `#${r.route_color}` : null,
      textColor: r.route_text_color ? `#${r.route_text_color}` : null,
      stopIds: [], // filled below, first-seen trip order (a reasonable proxy for stop sequence)
      shapePoints: [], // filled below from the first trip's shape_id seen for this route
    };
  }

  // --- trip_id -> {route_id, service_id, headsign, shapeId} ---
  const tripInfo = {};
  for (const t of trips) {
    tripInfo[t.trip_id] = {
      routeId: t.route_id,
      serviceId: t.service_id,
      headsign: t.trip_headsign || '', // resolved below once stop_times are walked, if still blank
      shapeId: t.shape_id || null,
    };
  }

  // --- stops lookup, seeded from stops.txt ---
  const stopById = {};
  for (const s of stops) {
    stopById[s.stop_id] = {
      id: s.stop_id,
      name: s.stop_name || s.stop_id,
      lat: s.stop_lat ? Number(s.stop_lat) : null,
      lon: s.stop_lon ? Number(s.stop_lon) : null,
      routesById: {}, // temp working map, flattened to an array at the end
    };
  }

  // --- walk stop_times.txt: this is the big join that builds arrivals ---
  // Group by trip first so we can preserve each trip's real stop sequence
  // (needed for routes[].stopIds) while also emitting per-stop arrivals.
  const stopTimesByTrip = new Map();
  for (const st of stopTimes) {
    if (!stopTimesByTrip.has(st.trip_id)) stopTimesByTrip.set(st.trip_id, []);
    stopTimesByTrip.get(st.trip_id).push(st);
  }

  const seenRouteStops = new Map(); // routeId -> Set of stopIds already recorded, to keep stopIds ordered+unique

  for (const [tripId, rows] of stopTimesByTrip) {
    const trip = tripInfo[tripId];
    if (!trip) continue; // orphaned stop_time row with no matching trip
    const route = routeById[trip.routeId];
    if (!route) continue;

    rows.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));

    // Some feeds (Hernando County's included) leave trip_headsign blank
    // entirely. Fall back to the trip's actual final stop as the
    // effective destination -- still real data, just derived instead of
    // authored, and far more useful to a rider than repeating the route
    // name back at them.
    if (!trip.headsign) {
      const lastStopId = rows[rows.length - 1].stop_id;
      trip.headsign = stopById[lastStopId] ? stopById[lastStopId].name : '';
    }

    // First trip's shape wins -- a route can have multiple shape_ids (one
    // per direction/branch); a single representative polyline is enough
    // for a simple "where do the buses run" map view.
    if (route.shapePoints.length === 0 && trip.shapeId && shapePointsById.has(trip.shapeId)) {
      route.shapePoints = shapePointsById.get(trip.shapeId);
    }

    if (!seenRouteStops.has(route.id)) seenRouteStops.set(route.id, new Set());
    const seenSet = seenRouteStops.get(route.id);

    for (const st of rows) {
      const stop = stopById[st.stop_id];
      if (!stop) continue; // stop_time referencing an unknown stop_id

      if (!seenSet.has(st.stop_id)) {
        seenSet.add(st.stop_id);
        route.stopIds.push(st.stop_id);
      }

      // A stop is served by this route whenever a stop_time row places it
      // on the route, regardless of whether this particular row has a
      // usable time -- GTFS deliberately leaves arrival/departure blank
      // for non-"timepoint" stops (81% of rows in this feed), meaning
      // "interpolate this, don't skip it," not "this stop isn't served."
      // Conflating the two used to silently drop 89% of stops from their
      // own routes' "served by" lists. The stop-route relationship is
      // recorded unconditionally here; only a *displayable arrival time*
      // requires a valid `minutes` below.
      if (!stop.routesById[route.id]) {
        stop.routesById[route.id] = {
          routeId: route.id,
          shortName: route.shortName,
          longName: route.longName,
          color: route.color,
          arrivals: [],
        };
      }

      const minutes = gtfsTimeToMinutes(st.arrival_time || st.departure_time);
      if (minutes === null) continue; // served, but no published time for this specific stop_time row to display

      stop.routesById[route.id].arrivals.push({
        tripId,
        serviceId: trip.serviceId,
        headsign: trip.headsign,
        minutes,
      });
    }
  }

  // --- flatten stop.routesById -> stop.routes[], sort arrivals ascending ---
  const stopsOut = {};
  for (const stop of Object.values(stopById)) {
    const routesArr = Object.values(stop.routesById);
    for (const r of routesArr) r.arrivals.sort((a, b) => a.minutes - b.minutes);
    stopsOut[stop.id] = {
      id: stop.id,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      routes: routesArr,
    };
  }

  const routesOut = {};
  for (const r of Object.values(routeById)) {
    routesOut[r.id] = r;
  }

  return {
    generatedAt: new Date().toISOString(),
    agencyTimezone,
    services,
    routes: routesOut,
    stops: stopsOut,
  };
}

module.exports = { transform, DOW_KEYS };
