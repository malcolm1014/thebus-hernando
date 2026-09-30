const test = require('node:test');
const assert = require('node:assert/strict');

// fetchLiveBuses caches its result in module-level state, and the module
// reads config (SWIFTLY_API_KEY) once at require time via ./src/config,
// so each test needs a fresh require of BOTH -- same reasoning as
// passio.test.js / pascoRealtime.test.js's own fresh-module helpers.
function freshSwiftlyModule(env = {}) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve('../src/config')];
  const modPath = require.resolve('../src/swiftlyRealtime');
  delete require.cache[modPath];
  const mod = require('../src/swiftlyRealtime');
  return {
    mod,
    restore() {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

// A minimal slice of Swiftly's JSON serialization of the GTFS-realtime
// vehicle-positions FeedMessage: { entity: [ { id, vehicle: { trip, vehicle,
// position } } ] } -- the licensed feed (NOT the unlicensed /vehicles JSON).
function feedRes(entities) {
  return async () => ({ ok: true, status: 200, json: async () => ({ entity: entities }) });
}

test('shapes a GTFS-rt VehiclePosition into the shared bus shape and sends the key as an Authorization header', async () => {
  const originalFetch = global.fetch;
  let sawUrl = null;
  let sawAuth = null;
  const { mod, restore } = freshSwiftlyModule({ SWIFTLY_API_KEY: 'test-key', SWIFTLY_HART_AGENCY_KEY: undefined });
  global.fetch = async (url, opts) => {
    sawUrl = String(url);
    sawAuth = opts && opts.headers && opts.headers.Authorization;
    return feedRes([
      {
        id: 'v1',
        vehicle: {
          trip: { routeId: '6', tripId: 'T-99' },
          vehicle: { id: '4021' },
          position: { latitude: 27.95, longitude: -82.46, bearing: 90, speed: 12.5 },
        },
      },
    ])(url, opts);
  };

  try {
    const result = await mod.fetchLiveBuses();
    assert.equal(result.buses.length, 1);
    assert.deepEqual(result.buses[0], {
      busId: '4021', routeId: '6', routeName: null,
      lat: 27.95, lon: -82.46, course: 90, speed: 12.5, tripId: 'T-99',
    });
    assert.equal(sawAuth, 'test-key');
    // The licensed GTFS-rt feed, JSON serialization, default agency key 'tampa'.
    assert.match(sawUrl, /\/real-time\/tampa\/gtfs-rt-vehicle-positions\?format=json$/);
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});

test('uses an overridden Swiftly agency key when set', async () => {
  const originalFetch = global.fetch;
  let sawUrl = null;
  const { mod, restore } = freshSwiftlyModule({ SWIFTLY_API_KEY: 'k', SWIFTLY_HART_AGENCY_KEY: 'other-agency' });
  global.fetch = async (url, opts) => { sawUrl = String(url); return feedRes([])(url, opts); };
  try {
    await mod.fetchLiveBuses();
    assert.match(sawUrl, /\/real-time\/other-agency\/gtfs-rt-vehicle-positions\?format=json$/);
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});

test('tolerates snake_case fields, falls back to entity id, and skips a vehicle missing coordinates', async () => {
  const originalFetch = global.fetch;
  const { mod, restore } = freshSwiftlyModule({ SWIFTLY_API_KEY: 'k' });
  global.fetch = feedRes([
    // snake_case serializer variant; no vehicle.vehicle.id -> falls back to entity id; no bearing/speed.
    { id: 'e2', vehicle: { trip: { route_id: '9', trip_id: 'T2' }, position: { latitude: 28.0, longitude: -82.5 } } },
    // no position -> dropped
    { id: 'e3', vehicle: { trip: { routeId: '9' } } },
  ]);
  try {
    const result = await mod.fetchLiveBuses();
    assert.equal(result.buses.length, 1);
    assert.equal(result.buses[0].busId, 'e2');
    assert.equal(result.buses[0].routeId, '9');
    assert.equal(result.buses[0].tripId, 'T2');
    assert.equal(result.buses[0].routeName, null); // GTFS-rt has no rider-facing short name
    assert.equal(result.buses[0].course, null);
    assert.equal(result.buses[0].speed, null);
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});

test('throws when the upstream request fails, rather than silently returning empty', async () => {
  const originalFetch = global.fetch;
  const { mod, restore } = freshSwiftlyModule({ SWIFTLY_API_KEY: 'k' });
  global.fetch = async () => ({ ok: false, status: 503, text: async () => 'upstream down' });
  try {
    await assert.rejects(() => mod.fetchLiveBuses(), /503/);
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});

test('throws a clear error (and makes no request) when no key is configured', async () => {
  const originalFetch = global.fetch;
  const { mod, restore } = freshSwiftlyModule({ SWIFTLY_API_KEY: undefined });
  let called = false;
  global.fetch = async () => { called = true; return feedRes([])(); };
  try {
    await assert.rejects(() => mod.fetchLiveBuses(), /SWIFTLY_API_KEY/);
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});
