const test = require('node:test');
const assert = require('node:assert/strict');

// fetchLiveBuses caches its result in module-level state, so each test
// needs a fresh require of the module (Node caches modules by path, so
// deleting the cache entry forces a clean instance) to avoid one test's
// cache bleeding into the next.
function freshPassioModule() {
  const path = require.resolve('../src/passio');
  delete require.cache[path];
  return require('../src/passio');
}

test('shapes a raw Passio getBuses response into a clean bus array', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      buses: {
        '-1': [{ '-1': [] }], // sentinel "no buses" entry Passio always includes -- must be skipped
        '12345': [{
          busId: '12345', busName: 'Bus 1', routeId: '8210', route: 'Route 9',
          latitude: '28.55', longitude: '-82.6', calculatedCourse: '90', speed: '22',
        }],
      },
    }),
  });

  try {
    const { fetchLiveBuses } = freshPassioModule();
    const result = await fetchLiveBuses();
    assert.equal(result.buses.length, 1);
    assert.deepEqual(result.buses[0], {
      busId: '12345', routeId: '8210', routeName: 'Route 9',
      lat: 28.55, lon: -82.6, course: 90, speed: 22,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('skips a vehicle entry with no coordinates rather than emitting NaN', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ buses: { '1': [{ busId: '1', latitude: null, longitude: null }] } }),
  });

  try {
    const { fetchLiveBuses } = freshPassioModule();
    const result = await fetchLiveBuses();
    assert.equal(result.buses.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('throws when the upstream request fails, rather than silently returning empty', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503 });

  try {
    const { fetchLiveBuses } = freshPassioModule();
    await assert.rejects(() => fetchLiveBuses(), /503/);
  } finally {
    global.fetch = originalFetch;
  }
});
