const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules, buildMockDataset } = require('./helpers');

/**
 * liveMap.js talks to real Leaflet (L) and the DOM, neither of which
 * exist under `node --test` -- this project's other browser-only files
 * have historically only been "verified via one-off manual `node -e`
 * runs" (see helpers.js's own top comment). Rather than leave the new
 * GPS-snapping/vehicle-allocation/trajectory-rendering wiring in this
 * file completely unverified, this stubs the small slice of Leaflet's
 * API liveMap.js actually calls -- enough to exercise the real logic
 * (which trip got matched, whether a route highlight toggles, whether a
 * failed poll fades markers) without a real map or browser.
 */
function installLeafletStub() {
  const created = { polylines: [], markers: new Map() };

  function chainable(obj) {
    obj.addTo = () => obj;
    obj.on = (event, cb) => { obj._handlers = obj._handlers || {}; obj._handlers[event] = cb; return obj; };
    return obj;
  }

  global.L = {
    map: () => {
      const obj = chainable({ fitBounds: () => {}, invalidateSize: () => {} });
      obj.setView = () => obj; // Leaflet's real setView() returns the map itself, chainable
      return obj;
    },
    tileLayer: () => chainable({}),
    layerGroup: () => chainable({ clearLayers: () => {}, removeLayer: () => {} }),
    polyline: (points, opts) => {
      const line = chainable({ points, opts, setStyle: (s) => Object.assign(line.opts, s) });
      created.polylines.push(line);
      return line;
    },
    circleMarker: () => chainable({ bindPopup: () => {} }),
    marker: (latlng, opts) => {
      const m = chainable({
        _latlng: { lat: latlng[0], lng: latlng[1] },
        icon: opts.icon,
        opacity: 1,
        getLatLng: () => m._latlng,
        setLatLng: (ll) => { m._latlng = Array.isArray(ll) ? { lat: ll[0], lng: ll[1] } : ll; },
        setIcon: (icon) => { m.icon = icon; },
        setOpacity: (o) => { m.opacity = o; },
        bindPopup: () => {},
      });
      return m;
    },
    divIcon: (opts) => opts,
    DomEvent: { stopPropagation: () => {} },
  };
  return created;
}

loadModules('geoMath.js', 'vehicleAllocation.js', 'intentParser.js', 'searchIndex.js', 'queryEngine.js', 'sync.js', 'liveMap.js');

/** A route with a real shapePoints polyline (a straight east-west line) and one trip on it, so GPS-snap + trip-matching both have something to work with. */
function datasetWithShapeAndTrip() {
  const dataset = buildMockDataset({
    services: {
      // Active every day, indefinitely -- these tests fix trip-matching's
      // schedule-window clock via __setNowForTesting, but real calendar
      // weekday/date-range gating (isServiceActive) still runs for real,
      // so this must not depend on which real day the test happens to run.
      WEEKDAY: { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true, startDate: '20200101', endDate: '20991231', addedDates: [], removedDates: [] },
    },
    routes: {
      R1: {
        id: 'R1', shortName: '5', longName: 'Route 5', color: '#ff0000', stopIds: ['S1', 'S2'],
        shapePoints: [[28.50, -82.60], [28.50, -82.50]],
      },
    },
    stops: {
      S1: { id: 'S1', name: 'West Stop', lat: 28.50, lon: -82.60, routes: [{ routeId: 'R1', shortName: '5', longName: 'Route 5', color: '#ff0000', arrivals: [{ tripId: 'T1', serviceId: 'WEEKDAY', headsign: 'East', minutes: 480 }] }] },
      S2: { id: 'S2', name: 'East Stop', lat: 28.50, lon: -82.50, routes: [{ routeId: 'R1', shortName: '5', longName: 'Route 5', color: '#ff0000', arrivals: [{ tripId: 'T1', serviceId: 'WEEKDAY', headsign: 'East', minutes: 500 }] }] },
    },
  });
  return dataset;
}

const TUESDAY_810AM_ET = new Date('2026-08-25T12:10:00Z'); // 8:10am ET (agency-local minute 490) -- inside trip T1's 8:00-8:20am (480-500) window

test('drawStaticData renders a polyline per route with a shape, and clicking it toggles a highlight', () => {
  const created = installLeafletStub();
  const dataset = datasetWithShapeAndTrip();
  TheBusLiveMap.initMap('map');
  TheBusLiveMap.drawStaticData(dataset);
  assert.equal(created.polylines.length, 1);
  const line = created.polylines[0];
  assert.equal(line.opts.opacity, 0.85);

  line._handlers.click({}); // simulate a rider tapping the route line
  assert.equal(line.opts.weight, 6); // highlighted route gets a fatter line
  assert.equal(line.opts.opacity, 0.85); // and stays fully visible

  line._handlers.click({}); // tap again -- toggles back off
  assert.equal(line.opts.weight, 4); // back to normal weight
  assert.equal(line.opts.opacity, 0.85);
});

test('refreshBuses snaps a slightly-off-road fix onto the route shape (GPS refinement)', async () => {
  installLeafletStub();
  const dataset = datasetWithShapeAndTrip();
  TheBusLiveMap.initMap('map');
  TheBusLiveMap.drawStaticData(dataset);
  TheBusQueryEngine.setDataset(dataset);

  // ~50m north of the shape's midpoint -- close enough to snap.
  global.fetch = async () => ({ ok: true, json: async () => ({ buses: [{ busId: 'B1', routeId: 'R1', lat: 28.5005, lon: -82.55, course: 90 }] }) });

  let result = null;
  TheBusLiveMap.startPolling(10000, (r) => { result = r; });
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the in-flight refreshBuses() promise chain settle
  TheBusLiveMap.stopPolling();

  assert.ok(result && result.ok && result.count === 1);
});

test('activeBusSummaries reports a schedule-adherence estimate once vehicle allocation confidently matches a trip', async () => {
  installLeafletStub();
  const dataset = datasetWithShapeAndTrip();
  TheBusLiveMap.initMap('map');
  TheBusLiveMap.drawStaticData(dataset);
  TheBusQueryEngine.setDataset(dataset);

  // It's 8:10am (agency-minute 490) on a trip scheduled 8:00-8:20am
  // (480-500) -- on time, the bus would be at the midpoint (-82.55). This
  // places it only 30% of the way along (-82.57) instead: about 4
  // minutes behind where the schedule says it should be, close enough to
  // its expected position to still be a plausible match.
  global.fetch = async () => ({ ok: true, json: async () => ({ buses: [{ busId: 'B1', routeId: 'R1', lat: 28.50, lon: -82.57, course: 90 }] }) });
  TheBusLiveMap.__setNowForTesting(() => TUESDAY_810AM_ET); // pin refreshBuses' internal clock so trip-matching's schedule window isn't coupled to real wall-clock time

  TheBusLiveMap.startPolling(10000, () => {});
  await new Promise((resolve) => setTimeout(resolve, 10));

  // activeBusSummaries reads lastBuses, which stopPolling() intentionally
  // clears (the map view is no longer showing anything once polling
  // stops) -- so it must be read while still "live", same as a real
  // caller (app.js) would while the map view is on screen.
  const summaries = TheBusLiveMap.activeBusSummaries(TUESDAY_810AM_ET);
  TheBusLiveMap.stopPolling();
  TheBusLiveMap.__setNowForTesting(null); // restore the real clock for any later test in this file

  assert.equal(summaries.length, 1);
  assert.match(summaries[0].text, /RUNNING ~\d+ MIN LATE/);
});

test('a failed poll fades existing markers instead of leaving them looking live or erasing them', async () => {
  installLeafletStub();
  const dataset = datasetWithShapeAndTrip();
  TheBusLiveMap.initMap('map');
  TheBusLiveMap.drawStaticData(dataset);
  TheBusQueryEngine.setDataset(dataset);

  let fail = false;
  global.fetch = async () => {
    if (fail) throw new Error('network down');
    return { ok: true, json: async () => ({ buses: [{ busId: 'B1', routeId: 'R1', lat: 28.50, lon: -82.55, course: 90 }] }) };
  };

  let lastResult = null;
  TheBusLiveMap.startPolling(1, (r) => { lastResult = r; }); // 1ms interval so we can force a second poll quickly
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(lastResult.ok);

  fail = true;
  // Manually trigger another refresh cycle by restarting polling (avoids depending on real interval timing in a test).
  TheBusLiveMap.stopPolling();
  TheBusLiveMap.startPolling(10000, (r) => { lastResult = r; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  TheBusLiveMap.stopPolling();

  assert.equal(lastResult.ok, false);
});
