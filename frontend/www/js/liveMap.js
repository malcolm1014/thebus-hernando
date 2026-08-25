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

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
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

  let onBusesUpdated = null;

  async function refreshBuses() {
    if (!map || !currentDataset) return;
    try {
      const res = await fetch(`${TheBusSync.API_BASE}/api/live-buses`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { buses } = await res.json();

      const seenIds = new Set();
      for (const bus of buses) {
        seenIds.add(bus.busId);
        const route = bus.routeId ? currentDataset.routes[bus.routeId] : null;
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
  }

  /** Leaflet needs to be told explicitly when its container's size changes (e.g. switching tabs) -- it can't detect that on its own. */
  function invalidateSize() {
    if (map) map.invalidateSize();
  }

  global.TheBusLiveMap = { initMap, drawStaticData, startPolling, stopPolling, invalidateSize };
})(window);
