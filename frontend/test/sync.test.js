const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('sync.js');

/** Mirrors backend/src/compact.js's compactForWire() -- kept independent (not shared code) so this test genuinely exercises TheBusSync.expandDataset() against the exact wire shape the backend produces, rather than testing the two against each other. */
function compact(data) {
  const pool = [];
  const idx = new Map();
  function intern(s) {
    const key = s || '';
    if (idx.has(key)) return idx.get(key);
    const i = pool.length;
    pool.push(key);
    idx.set(key, i);
    return i;
  }
  const stops = {};
  for (const [stopId, stop] of Object.entries(data.stops)) {
    stops[stopId] = {
      ...stop,
      routes: stop.routes.map((r) => ({ ...r, arrivals: r.arrivals.map((a) => [intern(a.tripId), intern(a.serviceId), intern(a.headsign), a.minutes]) })),
    };
  }
  return { ...data, stops, stringPool: pool };
}

function sampleData() {
  return {
    agencyTimezone: 'America/New_York',
    routes: { R1: { id: 'R1' } },
    stops: {
      S1: {
        id: 'S1', name: 'First St',
        routes: [{ routeId: 'R1', arrivals: [
          { tripId: 'T1', serviceId: 'WEEKDAY', headsign: 'Downtown', minutes: 480 },
          { tripId: 'T2', serviceId: 'WEEKDAY', headsign: 'Downtown', minutes: 540 },
        ] }],
      },
    },
  };
}

test('expandDataset: reverses the backend\'s compact wire format back to the exact original shape', () => {
  const original = sampleData();
  const expanded = TheBusSync.expandDataset(compact(original));
  assert.deepEqual(expanded, original);
});

test('expandDataset: a dataset with no stringPool (not compacted, or a stale pre-compaction bundled snapshot on an existing install) passes through unchanged', () => {
  const plain = sampleData();
  assert.deepEqual(TheBusSync.expandDataset(plain), plain);
});

test('expandDataset: null/undefined input does not crash', () => {
  assert.equal(TheBusSync.expandDataset(null), null);
  assert.equal(TheBusSync.expandDataset(undefined), undefined);
});
