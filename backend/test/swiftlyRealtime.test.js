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

// A minimal slice of Swiftly's documented JSON /vehicles response shape:
// { data: { vehicles: [ { id, routeId, routeShortName, tripId, loc: {...} } ] } }.
function mockOk(vehicles) {
  return async () => ({ ok: true, status: 200, json: async () => ({ data: { vehicles } }) });
}

test('shapes Swiftly JSON into the shared bus shape and sends the key as an Authorization header', async () => {
  const originalFetch = global.fetch;
  let sawUrl = null;
  let sawAuth = null;
  const { mod, restore } = freshSwiftlyModule({ SWIFTLY_API_KEY: 'test-key', SWIFTLY_HART_AGENCY_KEY: undefined });
  global.fetch = async (url, opts) => {
    sawUrl = String(url);
    sawAuth = opts && opts.headers && opts.headers.Authorization;
    return mockOk([
      { id: '4021', routeId: '6', routeShortName: '6', tripId: 'T-99', headsign: 'Downtown',
        loc: { lat: 27.95, lon: -82.46, heading: 90, speed: 12.5, time: 1700000000 } },
    ])(url, opts);
  };

  try {
    const result = await mod.fetchLiveBuses();
    assert.equal(result.buses.length, 1);
    assert.deepEqual(result.buses[0], {
      busId: '4021', routeId: '6', routeName: '6',
      lat: 27.95, lon: -82.46, course: 90, speed: 12.5, tripId: 'T-99',
    });
    assert.equal(sawAuth, 'test-key');
    assert.match(sawUrl, /\/real-time\/hart\/vehicles$/); // default agency key
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});

test('uses an overridden Swiftly agency key when set', async () => {
  const originalFetch = global.fetch;
  let sawUrl = null;
  const { mod, restore } = freshSwiftlyModule({ SWIFTLY_API_KEY: 'k', SWIFTLY_HART_AGENCY_KEY: 'tampa' });
  global.fetch = async (url, opts) => { sawUrl = String(url); return mockOk([])(url, opts); };
  try {
    await mod.fetchLiveBuses();
    assert.match(sawUrl, /\/real-time\/tampa\/vehicles$/);
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});

test('falls back to headsign for routeName, and skips a vehicle missing coordinates', async () => {
  const originalFetch = global.fetch;
  const { mod, restore } = freshSwiftlyModule({ SWIFTLY_API_KEY: 'k' });
  global.fetch = mockOk([
    { id: '1', routeId: '9', headsign: 'Airport', loc: { lat: 28.0, lon: -82.5 } }, // no routeShortName -> headsign
    { id: '2', routeId: '9', loc: { lat: null, lon: null } },                        // no coords -> dropped
  ]);
  try {
    const result = await mod.fetchLiveBuses();
    assert.equal(result.buses.length, 1);
    assert.equal(result.buses[0].routeName, 'Airport');
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
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
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
  global.fetch = async () => { called = true; return mockOk([])(); };
  try {
    await assert.rejects(() => mod.fetchLiveBuses(), /SWIFTLY_API_KEY/);
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});
