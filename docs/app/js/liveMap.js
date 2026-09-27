/**
 * Live map view: draws every route's polyline + every stop (from the
 * same cached dataset the terminal search uses, so this part works
 * offline) and overlays real-time bus positions polled from our
 * backend's /api/live-buses proxy (this part genuinely needs network --
 * a stale bus position is actively misleading, so it's never cached).
 *
 * Uses L.circleMarker / L.divIcon throughout instead of Leaflet's
 * default L.marker so the app never depends on the default marker
 * image assets -- one less thing to keep bundled/in sync.
 *
 * Depends on geoMath.js (polyline snapping/bearing) and
 * vehicleAllocation.js (which trip is this vehicle probably running) --
 * both must load before this file, same as its existing dependency on
 * TheBusQueryEngine/TheBusSync being loaded first.
 */
(function (global) {
  let map = null;
  let routeLayerGroup = null;
  let stopLayerGroup = null;
  let busLayerGroup = null;
  let pollTimer = null;
  let currentPollIntervalMs = 10000;
  let currentDataset = null;
  const busMarkersById = new Map();

  // Whether the OSM basemap tiles are actually rendering right now --
  // separate from navigator.onLine, which only says the DEVICE has a
  // network path, not that THIS specific host is reachable (a captive
  // wifi portal, a corporate firewall blocking just tile servers, etc.
  // would leave navigator.onLine true while every tile request still
  // fails). Optimistic by default; a real tile error flips it false, a
  // later full successful batch load flips it back -- so a transient
  // single-tile hiccup during normal panning doesn't get treated the
  // same as the basemap being genuinely unreachable.
  let basemapHealthy = true;
  function isBasemapHealthy() {
    return basemapHealthy;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function initMap(containerId) {
    if (map) return map;

    map = L.map(containerId, { zoomControl: true, attributionControl: true })
      .setView([28.55, -82.6], 11); // rough Hernando County center; refined by fitBounds once stop data draws

    // Plain OpenStreetMap tiles -- CARTO's basemaps (used here previously)
    // started requiring a free API key partway through this project and
    // watermarked every tile without one. OSM's own tile servers need no
    // key or account and never will (that's their whole model), so this
    // can't silently break again the same way. It's a light basemap by
    // default; the terminal-green "dark mode" look comes from a CSS
    // filter on .leaflet-tile-pane (see terminal.css) rather than a
    // purpose-built dark tileset -- real street names/labels are OSM's
    // own standard style, just recolored, not a separate lookup.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    })
      .on('tileerror', () => { basemapHealthy = false; })
      .on('load', () => { basemapHealthy = true; }) // a full batch finishing means tiles ARE reaching this device again
      .addTo(map);

    routeLayerGroup = L.layerGroup().addTo(map);
    stopLayerGroup = L.layerGroup().addTo(map);
    busLayerGroup = L.layerGroup().addTo(map);

    // Trajectory rendering: clicking empty map background resets the
    // "highlight one route" state set by clickRouteToHighlight below.
    map.on('click', () => setHighlightedRoute(null));

    return map;
  }

  // --- Trajectory rendering: route highlight toggle ---------------------
  // routeId -> its L.Polyline, so a click on one route can dim every
  // OTHER route's opacity instead of redrawing the whole layer -- the
  // same "show all vs. one highlighted route" pattern used by other open
  // transit-map viewers (OneBusAway's, gtfspy-webviz) surveyed for this.
  const routeLinesById = new Map();
  let highlightedRouteId = null;
  const ROUTE_DIM_OPACITY = 0.2;
  const ROUTE_NORMAL_OPACITY = 0.85;
  const ROUTE_HIGHLIGHT_WEIGHT = 6;
  const ROUTE_NORMAL_WEIGHT = 4;

  function setHighlightedRoute(routeId) {
    highlightedRouteId = (highlightedRouteId === routeId) ? null : routeId;
    for (const [id, line] of routeLinesById) {
      if (!highlightedRouteId || id === highlightedRouteId) {
        line.setStyle({ opacity: ROUTE_NORMAL_OPACITY, weight: ROUTE_HIGHLIGHT_WEIGHT * (id === highlightedRouteId ? 1 : ROUTE_NORMAL_WEIGHT / ROUTE_HIGHLIGHT_WEIGHT) });
      } else {
        line.setStyle({ opacity: ROUTE_DIM_OPACITY, weight: ROUTE_NORMAL_WEIGHT });
      }
    }
  }

  /**
   * Draws routes + stops from the already-synced offline dataset. Call
   * once the dataset is loaded, and again if it's ever re-synced (or the
   * rider switches which county's map they're looking at).
   *
   * `agencyId` (optional): restricts drawing to one agency's own
   * routes/stops and fits the view to just that region -- a merged
   * multi-agency dataset (Hernando+Pasco+HART) covers a huge geographic
   * area at wildly different densities (HART's 2,246 stops in urban
   * Tampa vs. Hernando's 369 rural ones); drawing and fitting bounds to
   * ALL of it at once was both visually unreadable (everything shrinks
   * to indistinguishable dots) and a real render-cost concern on a
   * phone. Omitted (the default), draws everything -- the exact
   * original single-agency behavior, so a non-merged dataset (or a
   * caller that genuinely wants the full regional overview) is
   * unaffected.
   */
  function drawStaticData(dataset, agencyId) {
    if (!map) return;
    currentDataset = dataset;
    routeLayerGroup.clearLayers();
    stopLayerGroup.clearLayers();
    routeLinesById.clear();
    highlightedRouteId = null;

    const bounds = [];

    for (const route of Object.values(dataset.routes)) {
      if (agencyId && route.agencyId !== agencyId) continue;
      if (!route.shapePoints || route.shapePoints.length === 0) continue;
      const line = L.polyline(route.shapePoints, {
        color: route.color || '#33ff00',
        weight: ROUTE_NORMAL_WEIGHT,
        opacity: ROUTE_NORMAL_OPACITY,
      }).addTo(routeLayerGroup);
      // Click a route's own line to highlight just that route (dim the
      // rest); click it again, or empty map, to go back to showing all.
      line.on('click', (e) => {
        L.DomEvent.stopPropagation(e); // don't also trigger the map's own click handler (which resets the highlight)
        setHighlightedRoute(route.id);
      });
      routeLinesById.set(route.id, line);
      for (const pt of route.shapePoints) bounds.push(pt);
    }

    for (const stop of Object.values(dataset.stops)) {
      if (agencyId && stop.agencyId !== agencyId) continue;
      if (stop.lat == null || stop.lon == null) continue;
      const marker = L.circleMarker([stop.lat, stop.lon], {
        radius: 4,
        color: '#000000',
        weight: 1,
        fillColor: '#33ff00',
        fillOpacity: 0.9,
      }).addTo(stopLayerGroup);
      const routesHere = stop.routes.map((r) => r.shortName || r.longName).filter(Boolean).join(', ') || 'NONE';
      marker.bindPopup(`<strong>${escapeHtml(stop.name.toUpperCase())}</strong><br/>ROUTES: ${escapeHtml(routesHere.toUpperCase())}`);
      bounds.push([stop.lat, stop.lon]);
    }

    if (bounds.length > 0) map.fitBounds(bounds, { padding: [20, 20] });
  }

  function busDivIcon(color, course) {
    const rotation = course != null ? `transform: translate(-50%, -50%) rotate(${course}deg);` : 'transform: translate(-50%, -50%);';
    return L.divIcon({
      className: 'bus-marker',
      html: `<div class="bus-marker-dot" style="background:${color};${rotation}"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  /**
   * Passio's live routeId does NOT match our GTFS route_id -- confirmed
   * against a real live feed capture (bus.routeId values like "61931",
   * "66631" vs GTFS route ids like "7398", "8424"; passio.js's own doc
   * comment already flagged this as unconfirmed when it was written).
   * Passio's human-readable routeName ("Route 5") usually carries just a
   * route NUMBER that also appears in our GTFS route's longName
   * ("Route 5 Yellow") -- checked first via a real GTFS id match in case
   * a future feed/agency ever DOES line up, since that'd be strictly
   * more reliable than parsing a display string. Not every Passio route
   * number has a matching GTFS entry in this feed (color-only-named
   * routes, and a few plain numbers with no obvious counterpart) --
   * those return null rather than guessing wrong.
   */
  function matchRouteId(bus) {
    if (bus.routeId && currentDataset.routes[bus.routeId]) return bus.routeId;
    const m = /route\s*#?\s*(\d+)/i.exec(bus.routeName || '');
    if (!m) return null;
    const num = m[1];
    const found = Object.values(currentDataset.routes).find(
      (r) => r.shortName === num || new RegExp(`\\broute\\s*${num}\\b`, 'i').test(r.longName || '')
    );
    return found ? found.id : null;
  }

  // --- GPS refinement: snap a raw vendor fix onto the route's own shape -
  // A bus's raw lat/lon from Passio/Avail routinely sits a lane-width or
  // two off the actual road centerline (ordinary consumer GPS error) --
  // visually distracting on a zoomed-in map where the route line is
  // right there. Projects the fix onto route.shapePoints (see
  // geoMath.js) and uses that instead, UNLESS the fix is implausibly far
  // from its own supposed route (a bad vendor routeId match, or the bus
  // genuinely off-route) -- in that case showing the raw fix is more
  // honest than snapping it somewhere nonsensical.
  const MAX_SNAP_DISTANCE_METERS = 300;

  function snappedPosition(bus, route) {
    if (!route || !route.shapePoints || route.shapePoints.length < 2) return null;
    const proj = TheBusGeoMath.nearestPointOnPolyline(bus.lat, bus.lon, route.shapePoints);
    if (!proj || proj.distMeters > MAX_SNAP_DISTANCE_METERS) return null;
    return proj;
  }

  // --- Vehicle allocation: sticky trip assignment ------------------------
  // busId -> { tripId, headsign, serviceId, distanceMiles, expected }.
  // Re-matching from scratch every ~10s poll would flap between two
  // similarly-plausible trips on ordinary GPS jitter; this keeps the
  // previous poll's trip unless a fresh candidate is convincingly (not
  // just marginally) closer to where its own schedule says it should be.
  const tripAssignmentByBusId = new Map();
  const STICKY_MARGIN_MILES = 0.15;

  function pickTripWithStickiness(busId, fresh, trips, stopsById, lat, lon) {
    const prev = tripAssignmentByBusId.get(busId);
    if (!fresh) return prev || null; // a transient bad fix shouldn't blank out a known-good previous match
    if (!prev || prev.tripId === fresh.tripId) return fresh;

    const prevTrip = trips.get(prev.tripId);
    if (prevTrip) {
      const prevExpected = TheBusVehicleAllocation.expectedPositionAt(prevTrip, stopsById, prev.agencyMinutes);
      if (prevExpected) {
        const R = 3958.8;
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(prevExpected.lat - lat);
        const dLon = toRad(prevExpected.lon - lon);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(prevExpected.lat)) * Math.sin(dLon / 2) ** 2;
        const prevDistanceMiles = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        if (prevDistanceMiles <= fresh.distanceMiles + STICKY_MARGIN_MILES) {
          return { ...prev, distanceMiles: prevDistanceMiles, expected: prevExpected };
        }
      }
    }
    return fresh;
  }

  // --- Trajectory rendering: smooth interpolation between polls ---------
  // busId -> { from: [lat,lon], to: [lat,lon], startTime (performance.now()), durationMs }.
  // Snapping a marker instantly to each new poll position makes movement
  // look like a series of teleports at a 10s cadence; interpolating over
  // a requestAnimationFrame loop between the previous and new position
  // reads as continuous motion instead, the same trick every reviewed
  // live-transit-map viewer uses (Leaflet.MovingMarker et al.) -- ~30
  // lines of vanilla JS, not worth a dependency for.
  const busAnimState = new Map();
  let animFrameId = null;

  function animationTick() {
    animFrameId = null;
    if (!map) return;
    const now = performance.now();
    for (const [busId, anim] of busAnimState) {
      const marker = busMarkersById.get(busId);
      if (!marker) { busAnimState.delete(busId); continue; }
      const t = anim.durationMs > 0 ? Math.min(1, (now - anim.startTime) / anim.durationMs) : 1;
      const lat = anim.from[0] + t * (anim.to[0] - anim.from[0]);
      const lon = anim.from[1] + t * (anim.to[1] - anim.from[1]);
      marker.setLatLng([lat, lon]);
    }
    if (pollTimer) animFrameId = requestAnimationFrame(animationTick); // keep animating only while the map view is actively polling
  }

  function ensureAnimationLoop() {
    if (animFrameId == null && typeof requestAnimationFrame === 'function') animFrameId = requestAnimationFrame(animationTick);
  }

  // --- Trajectory rendering: fade markers during a stale/failed poll ----
  // A failed fetch used to leave existing bus markers on screen looking
  // exactly as "live" as a moment ago, with zero visual signal anything
  // was wrong. Dims them progressively with how stale the last
  // successful poll is instead of a binary show/hide.
  let lastSuccessfulFetchAt = null;

  function applyStaleFade() {
    if (!lastSuccessfulFetchAt) return;
    const ageMs = Date.now() - lastSuccessfulFetchAt;
    const interval = currentPollIntervalMs || 10000;
    let opacity = 1;
    if (ageMs > interval * 4) opacity = 0.3;
    else if (ageMs > interval * 1.5) opacity = 0.6;
    for (const marker of busMarkersById.values()) marker.setOpacity(opacity);
  }

  // Real device time by default -- overridable ONLY for tests, since
  // refreshBuses() is driven by its own setInterval rather than called
  // with an externally-supplied `now` the way queryEngine.js's functions
  // are, so trip-matching's schedule-window check would otherwise be
  // coupled to whatever real wall-clock time a test happens to run at.
  let nowFn = () => new Date();
  function __setNowForTesting(fn) { nowFn = fn || (() => new Date()); }

  let onBusesUpdated = null;
  let lastBuses = [];
  // Which agency's buses to show -- null/falsy means every agency the
  // backend has a live source for (matches drawStaticData's own
  // "falsy agencyId = no filter" convention). Set via startPolling()'s
  // 3rd argument so switching the county selector also narrows which
  // buses are drawn, not just which stops/routes.
  let currentAgencyFilter = null;

  async function refreshBuses() {
    if (!map || !currentDataset) return;
    try {
      const res = await fetch(`${TheBusSync.API_BASE}/api/live-buses`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { buses: allBuses } = await res.json();
      const buses = currentAgencyFilter ? allBuses.filter((b) => b.agencyId === currentAgencyFilter) : allBuses;
      lastBuses = buses;
      lastSuccessfulFetchAt = Date.now();

      const now = nowFn();
      const agencyMinutes = TheBusQueryEngine.agencyMinutesNow(now);
      const trips = TheBusQueryEngine.getTripsIndex();

      const seenIds = new Set();
      for (const bus of buses) {
        seenIds.add(bus.busId);
        const matchedRouteId = matchRouteId(bus);
        const route = matchedRouteId ? currentDataset.routes[matchedRouteId] : null;
        const color = route ? (route.color || '#33ff00') : '#e0e0e0';
        const label = route ? (route.shortName || route.longName) : (bus.routeName || 'BUS');

        const snapped = snappedPosition(bus, route);
        const renderLat = snapped ? snapped.lat : bus.lat;
        const renderLon = snapped ? snapped.lon : bus.lon;

        if (matchedRouteId) {
          const fresh = TheBusVehicleAllocation.findBestTrip({
            trips, stopsById: currentDataset.stops, routeId: matchedRouteId,
            lat: bus.lat, lon: bus.lon, course: bus.course,
            agencyMinutes, now, isActiveFn: TheBusQueryEngine.isServiceActive,
          });
          const assignment = pickTripWithStickiness(bus.busId, fresh && { ...fresh, agencyMinutes }, trips, currentDataset.stops, bus.lat, bus.lon);
          if (assignment) tripAssignmentByBusId.set(bus.busId, assignment);
          else tripAssignmentByBusId.delete(bus.busId);
        } else {
          tripAssignmentByBusId.delete(bus.busId);
        }

        let marker = busMarkersById.get(bus.busId);
        if (!marker) {
          marker = L.marker([renderLat, renderLon], { icon: busDivIcon(color, bus.course) }).addTo(busLayerGroup);
          busMarkersById.set(bus.busId, marker);
        } else {
          const current = marker.getLatLng();
          busAnimState.set(bus.busId, {
            from: [current.lat, current.lng],
            to: [renderLat, renderLon],
            startTime: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
            durationMs: Math.min(currentPollIntervalMs, 8000),
          });
          marker.setIcon(busDivIcon(color, bus.course));
        }
        marker.setOpacity(1); // a bus reporting again this poll is no longer stale, even if it was faded a moment ago
        const speedText = bus.speed != null ? `<br/>${Math.round(bus.speed)} MPH` : '';
        marker.bindPopup(`<strong>${escapeHtml(String(label).toUpperCase())}</strong>${speedText}`);
      }
      ensureAnimationLoop();

      // Drop markers for buses that stopped reporting (went out of service, lost signal, etc).
      for (const [id, marker] of busMarkersById) {
        if (!seenIds.has(id)) {
          busLayerGroup.removeLayer(marker);
          busMarkersById.delete(id);
          busAnimState.delete(id);
          tripAssignmentByBusId.delete(id);
        }
      }

      if (onBusesUpdated) onBusesUpdated({ ok: true, count: buses.length });
    } catch (err) {
      console.error('[liveMap] failed to refresh live bus positions', err);
      lastBuses = [];
      applyStaleFade(); // a failed poll doesn't mean the buses vanished -- fade them rather than leaving them looking falsely live, or erasing them outright
      if (onBusesUpdated) onBusesUpdated({ ok: false, count: busMarkersById.size });
    }
  }

  /**
   * Starts polling live bus positions. Call when the map view becomes
   * visible; pair with stopPolling() when it's hidden.
   * @param {number} intervalMs
   * @param {(result: {ok: boolean, count: number}) => void} [onUpdate] -- called after each poll so the UI can show e.g. "7 buses active" / a connection problem
   * @param {string|null} [agencyFilter] -- only show this agency's buses (falsy = every agency with a live source)
   */
  function startPolling(intervalMs, onUpdate, agencyFilter) {
    stopPolling();
    onBusesUpdated = onUpdate || null;
    currentAgencyFilter = agencyFilter || null;
    currentPollIntervalMs = intervalMs || 10000;
    refreshBuses();
    pollTimer = setInterval(refreshBuses, currentPollIntervalMs);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (animFrameId != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(animFrameId);
    animFrameId = null;
    busAnimState.clear();
    lastBuses = [];
  }

  /** Leaflet needs to be told explicitly when its container's size changes (e.g. switching tabs) -- it can't detect that on its own. */
  function invalidateSize() {
    if (map) map.invalidateSize();
  }

  /** Great-circle distance in miles -- same formula queryEngine.js uses for nearest-stop, duplicated locally rather than exported/shared since it's a tiny, dependency-free bit of math and this module otherwise never touches queryEngine.js. */
  function haversineMiles(lat1, lon1, lat2, lon2) {
    const R = 3958.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /** Nearest stop ON a given route to a raw {lat, lon} -- restricted to that route's own stops (not every stop in the county) so an active bus is described by a stop it could actually be approaching, not just whatever's geographically closest. */
  function nearestStopOnRoute(routeId, lat, lon) {
    const route = currentDataset.routes[routeId];
    if (!route) return null;
    let best = null;
    for (const stopId of route.stopIds) {
      const stop = currentDataset.stops[stopId];
      if (!stop || stop.lat == null || stop.lon == null) continue;
      const dist = haversineMiles(lat, lon, stop.lat, stop.lon);
      if (!best || dist < best.dist) best = { stop, dist };
    }
    return best;
  }

  const SUMMARY_COUNTDOWN_THRESHOLD_MIN = 30;
  const ADHERENCE_NOISE_FLOOR_MIN = 2; // don't bother reporting "1 min late" -- within normal GPS/schedule-interpolation noise

  /** "" (nothing worth reporting), " -- RUNNING ~N MIN LATE", or " -- RUNNING ~N MIN EARLY", from vehicleAllocation.js's schedule-deviation estimate for this bus's currently-assigned trip. */
  function adherenceText(bus, agencyMinutes) {
    const assignment = tripAssignmentByBusId.get(bus.busId);
    if (!assignment) return '';
    const trip = TheBusQueryEngine.getTripsIndex().get(assignment.tripId);
    if (!trip) return '';
    const deviation = TheBusVehicleAllocation.estimateScheduleDeviationMinutes(trip, currentDataset.stops, bus.lat, bus.lon, agencyMinutes);
    if (deviation == null || Math.abs(deviation) < ADHERENCE_NOISE_FLOOR_MIN) return '';
    const rounded = Math.round(Math.abs(deviation));
    return ` -- RUNNING ~${rounded} MIN ${deviation > 0 ? 'LATE' : 'EARLY'}`;
  }

  /**
   * One entry per currently-active bus: which route, the stop it's
   * nearest to right now, that route's next SCHEDULED arrival there
   * (from the same GTFS-derived timetable the terminal search uses), and
   * -- when vehicle-allocation confidently matched a specific trip -- a
   * schedule-adherence estimate for that trip. Passio/Avail's live feed
   * has no per-trip link back to the schedule of its own, so trip
   * matching (vehicleAllocation.js) is what makes the adherence estimate
   * possible at all; without a confident match this still falls back to
   * the route-level "next scheduled arrival" it always showed.
   */
  function activeBusSummaries(now) {
    if (!currentDataset) return [];
    const agencyMinutes = TheBusQueryEngine.agencyMinutesNow(now);
    return lastBuses.map((bus) => {
      const matchedRouteId = matchRouteId(bus);
      const route = matchedRouteId ? currentDataset.routes[matchedRouteId] : null;
      const label = route ? (route.shortName || route.longName) : (bus.routeName || 'BUS');
      if (!route) return { label, text: 'ROUTE NOT IN SCHEDULE DATA' };

      const nearest = nearestStopOnRoute(matchedRouteId, bus.lat, bus.lon);
      if (!nearest) return { label, text: 'NO STOPS ON FILE FOR THIS ROUTE' };

      const [next] = TheBusQueryEngine.nextArrivals(nearest.stop.id, matchedRouteId, now, 1);
      const arrivalText = next
        ? (next.isTomorrow ? 'TOMORROW ' : '') + (next.minutesUntil <= SUMMARY_COUNTDOWN_THRESHOLD_MIN
          ? `${next.minutesUntil} MIN`
          : `AT ${next.clock}`)
        : 'NO MORE SCHEDULED ARRIVALS TODAY';

      return { label, text: `NEAR ${nearest.stop.name.toUpperCase()} (${nearest.dist.toFixed(2)} MI) -- NEXT: ${arrivalText}${adherenceText(bus, agencyMinutes)}` };
    });
  }

  global.TheBusLiveMap = { initMap, drawStaticData, startPolling, stopPolling, invalidateSize, activeBusSummaries, isBasemapHealthy, __setNowForTesting };
})(window);
