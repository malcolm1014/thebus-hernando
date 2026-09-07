const test = require('node:test');
const assert = require('node:assert/strict');

// fetchLiveBuses caches its result (and the route-id list) in
// module-level state, so each test needs a fresh require (Node caches
// modules by path) to avoid one test's cache bleeding into the next --
// same reasoning as passio.test.js's own freshPassioModule().
function freshPascoModule() {
  const path = require.resolve('../src/pascoRealtime');
  delete require.cache[path];
  return require('../src/pascoRealtime');
}

/** Mocks the 2-call sequence fetchLiveBuses() makes: GetVisibleRoutes first, then GetAllVehiclesForRoutes. */
function mockFetch({ routes, vehicles, vehiclesOk = true, vehiclesStatus = 200 }) {
  return async (url) => {
    if (String(url).includes('GetVisibleRoutes')) {
      return { ok: true, json: async () => routes };
    }
    if (String(url).includes('GetAllVehiclesForRoutes')) {
      return { ok: vehiclesOk, status: vehiclesStatus, json: async () => vehicles };
    }
    throw new Error(`unexpected URL in test mock: ${url}`);
  };
}

const SAMPLE_ROUTES = [{ RouteId: 14 }, { RouteId: 16 }];

test('shapes a raw Avail/myStop vehicle response into a clean bus array, and requests every known route id in one call', async () => {
  const originalFetch = global.fetch;
  let vehiclesUrl = null;
  global.fetch = async (url) => {
    if (String(url).includes('GetAllVehiclesForRoutes')) vehiclesUrl = String(url);
    return mockFetch({
      routes: SAMPLE_ROUTES,
      vehicles: [{ VehicleId: '501', RouteId: 14, RouteName: 'Route 14', Latitude: '28.2', Longitude: '-82.7', Heading: '180', GroundSpeed: '15' }],
    })(url);
  };

  try {
    const { fetchLiveBuses } = freshPascoModule();
    const result = await fetchLiveBuses();
    assert.equal(result.buses.length, 1);
    assert.deepEqual(result.buses[0], {
      busId: '501', routeId: '14', routeName: 'Route 14',
      lat: 28.2, lon: -82.7, course: 180, speed: 15,
    });
    assert.match(vehiclesUrl, /routeIDs=14,16/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('skips a vehicle entry with no coordinates rather than emitting NaN', async () => {
  const originalFetch = global.fetch;
  global.fetch = mockFetch({
    routes: SAMPLE_ROUTES,
    vehicles: [{ VehicleId: '502', RouteId: 14, Latitude: null, Longitude: null }],
  });

  try {
    const { fetchLiveBuses } = freshPascoModule();
    const result = await fetchLiveBuses();
    assert.equal(result.buses.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('throws when the upstream vehicle request fails, rather than silently returning empty', async () => {
  const originalFetch = global.fetch;
  global.fetch = mockFetch({ routes: SAMPLE_ROUTES, vehicles: null, vehiclesOk: false, vehiclesStatus: 503 });

  try {
    const { fetchLiveBuses } = freshPascoModule();
    await assert.rejects(() => fetchLiveBuses(), /503/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('normalizeVehicle: falls back across several plausible field-name casings rather than assuming one confirmed shape', () => {
  const { normalizeVehicle } = freshPascoModule();
  // Alternate casing/naming this same module defensively supports (see
  // its own file-level comment on why: unverified against a live payload).
  const alt = normalizeVehicle({ Id: '9', RouteID: 5, lat: 28.4, lon: -82.5, Direction: 45, Speed: 30 });
  assert.deepEqual(alt, { busId: '9', routeId: '5', routeName: null, lat: 28.4, lon: -82.5, course: 45, speed: 30 });
});
