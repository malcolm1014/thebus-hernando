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
 */
(function (global) {
  let map = null;
  let routeLayerGroup = null;
  let stopLayerGroup = null;
  let busLayerGroup = null;
  let pollTimer = null;
  let currentDataset = null;
  const busMarkersById = new Map();

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
    }).addTo(map);

    routeLayerGroup = L.layerGroup().addTo(map);
    stopLayerGroup = L.layerGroup().addTo(map);
    busLayerGroup = L.layerGroup().addTo(map);

    return map;
  }

  /** Draws routes + stops from the already-synced offline dataset. Call once the dataset is loaded, and again if it's ever re-synced. */
  function drawStaticData(dataset) {
    if (!map) return;
    currentDataset = dataset;
    routeLayerGroup.clearLayers();
    stopLayerGroup.clearLayers();

    const bounds = [];

    for (const route of Object.values(dataset.routes)) {
      if (!route.shapePoints || route.shapePoints.length === 0) continue;
      L.polyline(route.shapePoints, {
        color: route.color || '#33ff00',
        weight: 4,
        opacity: 0.85,
      }).addTo(routeLayerGroup);
      for (const pt of route.shapePoints) bounds.push(pt);
    }

    for (const stop of Object.values(dataset.stops)) {
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

  let onBusesUpdated = null;
  let lastBuses = [];

  async function refreshBuses() {
    if (!map || !currentDataset) return;
    try {
      const res = await fetch(`${TheBusSync.API_BASE}/api/live-buses`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { buses } = await res.json();
      lastBuses = buses;

      const seenIds = new Set();
      for (const bus of buses) {
        seenIds.add(bus.busId);
        const matchedRouteId = matchRouteId(bus);
        const route = matchedRouteId ? currentDataset.routes[matchedRouteId] : null;
        const color = route ? (route.color || '#33ff00') : '#e0e0e0';
        const label = route ? (route.shortName || route.longName) : (bus.routeName || 'BUS');

        let marker = busMarkersById.get(bus.busId);
        if (!marker) {
          marker = L.marker([bus.lat, bus.lon], { icon: busDivIcon(color, bus.course) }).addTo(busLayerGroup);
          busMarkersById.set(bus.busId, marker);
        } else {
          marker.setLatLng([bus.lat, bus.lon]);
          marker.setIcon(busDivIcon(color, bus.course));
        }
        const speedText = bus.speed != null ? `<br/>${Math.round(bus.speed)} MPH` : '';
        marker.bindPopup(`<strong>${escapeHtml(String(label).toUpperCase())}</strong>${speedText}`);
      }

      // Drop markers for buses that stopped reporting (went out of service, lost signal, etc).
      for (const [id, marker] of busMarkersById) {
        if (!seenIds.has(id)) {
          busLayerGroup.removeLayer(marker);
          busMarkersById.delete(id);
        }
      }

      if (onBusesUpdated) onBusesUpdated({ ok: true, count: buses.length });
    } catch (err) {
      console.error('[liveMap] failed to refresh live bus positions', err);
      lastBuses = [];
      if (onBusesUpdated) onBusesUpdated({ ok: false, count: busMarkersById.size });
    }
  }

  /**
   * Starts polling live bus positions. Call when the map view becomes
   * visible; pair with stopPolling() when it's hidden.
   * @param {number} intervalMs
   * @param {(result: {ok: boolean, count: number}) => void} [onUpdate] -- called after each poll so the UI can show e.g. "7 buses active" / a connection problem
   */
  function startPolling(intervalMs, onUpdate) {
    stopPolling();
    onBusesUpdated = onUpdate || null;
    refreshBuses();
    pollTimer = setInterval(refreshBuses, intervalMs || 10000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
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

  /**
   * One entry per currently-active bus: which route, the stop it's
   * nearest to right now, and that route's next SCHEDULED arrival there
   * (from the same GTFS-derived timetable the terminal search uses --
   * Passio's live feed has no per-trip link back to the schedule of its
   * own, so this is the closest honest answer to "when's it getting
   * here" without inventing a speed/distance ETA estimate).
   */
  function activeBusSummaries(now) {
    if (!currentDataset) return [];
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

      return { label, text: `NEAR ${nearest.stop.name.toUpperCase()} (${nearest.dist.toFixed(2)} MI) -- NEXT: ${arrivalText}` };
    });
  }

  global.TheBusLiveMap = { initMap, drawStaticData, startPolling, stopPolling, invalidateSize, activeBusSummaries };
})(window);
