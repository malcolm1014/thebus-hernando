const test = require('node:test');
const assert = require('node:assert/strict');

// geocode.js caches results in module-level state, so each test needs a
// fresh require (same pattern as passio.test.js) to avoid one test's
// cache entries bleeding into the next.
function freshGeocodeModule() {
  const path = require.resolve('../src/geocode');
  delete require.cache[path];
  return require('../src/geocode');
}

test('caches a successful lookup -- a second call for the same query never hits fetch again', async () => {
  const { geocode } = freshGeocodeModule();
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => [{ lat: '28.5', lon: '-82.6', display_name: 'Test Place' }] };
  };
  try {
    const first = await geocode('Test Place');
    const second = await geocode('Test Place');
    assert.deepEqual(first, second);
    assert.equal(fetchCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

// Exercises cacheSet directly (not through geocode()) so this doesn't
// have to pay for 500+ real trips through the 1.1s-per-request Nominatim
// throttle just to prove eviction works.
test('cacheSet evicts the oldest entry once at its cap, not just growing forever', () => {
  const { cacheSet } = freshGeocodeModule();
  const map = new Map();
  const cap = 3;

  cacheSet(map, cap, 'a', 1);
  cacheSet(map, cap, 'b', 2);
  cacheSet(map, cap, 'c', 3);
  assert.deepEqual([...map.keys()], ['a', 'b', 'c']);

  cacheSet(map, cap, 'd', 4); // over the cap -- 'a' (oldest) must go
  assert.equal(map.size, cap);
  assert.deepEqual([...map.keys()], ['b', 'c', 'd']);
});

test('cacheSet re-setting an existing key never evicts anything, even already at the cap', () => {
  const { cacheSet } = freshGeocodeModule();
  const map = new Map();
  const cap = 2;

  cacheSet(map, cap, 'a', 1);
  cacheSet(map, cap, 'b', 2);
  cacheSet(map, cap, 'a', 'updated'); // refreshing an existing key, already at the cap
  assert.equal(map.size, cap);
  assert.equal(map.get('a'), 'updated');
  assert.ok(map.has('b'));
});
