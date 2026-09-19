const test = require('node:test');
const assert = require('node:assert/strict');
const { compactForWire, expandFromWire } = require('../src/compact');

function sampleData() {
  return {
    generatedAt: '2026-09-06T00:00:00.000Z',
    agencyTimezone: 'America/New_York',
    services: { WEEKDAY: { monday: true } },
    routes: { R1: { id: 'R1', shortName: '', longName: 'Blue', stopIds: ['S1', 'S2'], shapePoints: [] } },
    stops: {
      S1: {
        id: 'S1', name: 'First St', lat: 28.5, lon: -82.6,
        routes: [{
          routeId: 'R1', shortName: '', longName: 'Blue', color: '#00f',
          arrivals: [
            { tripId: 'T1', serviceId: 'WEEKDAY', headsign: 'Downtown', minutes: 480 },
            { tripId: 'T2', serviceId: 'WEEKDAY', headsign: 'Downtown', minutes: 540 },
          ],
        }],
      },
      S2: {
        id: 'S2', name: 'Second St', lat: 28.6, lon: -82.7,
        routes: [{
          routeId: 'R1', shortName: '', longName: 'Blue', color: '#00f',
          arrivals: [{ tripId: 'T1', serviceId: 'WEEKDAY', headsign: 'Uptown', minutes: 495 }],
        }],
      },
    },
  };
}

test('compactForWire: replaces object-shaped arrivals with [tripIdx, serviceIdx, headsignIdx, minutes] arrays, and adds a stringPool', () => {
  const compact = compactForWire(sampleData());
  assert.ok(Array.isArray(compact.stringPool));
  const s1Arrivals = compact.stops.S1.routes[0].arrivals;
  assert.equal(s1Arrivals.length, 2);
  for (const a of s1Arrivals) assert.ok(Array.isArray(a) && a.length === 4);
});

test('compactForWire: interns repeated strings ONCE -- "WEEKDAY" (serviceId) and "Downtown" (headsign) each appear only once in the pool despite repeating across 2 arrivals', () => {
  const compact = compactForWire(sampleData());
  assert.equal(compact.stringPool.filter((s) => s === 'WEEKDAY').length, 1);
  assert.equal(compact.stringPool.filter((s) => s === 'Downtown').length, 1);
  // Both S1 arrivals (T1 and T2) share the same serviceId/headsign pool indices.
  const [t1, t2] = compact.stops.S1.routes[0].arrivals;
  assert.equal(t1[1], t2[1]); // serviceId index
  assert.equal(t1[2], t2[2]); // headsign index
  assert.notEqual(t1[0], t2[0]); // tripId index -- T1 and T2 are genuinely different trips
});

test('compactForWire -> expandFromWire round-trips back to the exact original object shape', () => {
  const original = sampleData();
  const roundTripped = expandFromWire(compactForWire(original));
  assert.deepEqual(roundTripped, original);
});

test('expandFromWire: a dataset with no stringPool (not compacted, or a stale pre-compaction bundled snapshot) is returned unchanged rather than corrupted', () => {
  const plain = sampleData();
  assert.deepEqual(expandFromWire(plain), plain);
  assert.equal(expandFromWire(null), null);
});

test('compactForWire: an empty headsign (falsy) still round-trips correctly rather than being conflated with a genuinely missing value', () => {
  const data = sampleData();
  data.stops.S1.routes[0].arrivals[0].headsign = '';
  const roundTripped = expandFromWire(compactForWire(data));
  assert.equal(roundTripped.stops.S1.routes[0].arrivals[0].headsign, '');
});

test('compactForWire: a dataset with no places/roads (pre-OSM-merge, or the feature just unconfigured) round-trips with no places/roads key at all -- never gains an empty one', () => {
  const original = sampleData();
  assert.ok(!('places' in original) && !('roads' in original));
  const roundTripped = expandFromWire(compactForWire(original));
  assert.deepEqual(roundTripped, original);
  assert.ok(!('places' in roundTripped) && !('roads' in roundTripped));
});

test('compactForWire: interns OSM places.category and roads.highway into the SAME shared stringPool as GTFS arrivals, and round-trips exactly', () => {
  const data = sampleData();
  data.places = {
    'osm:node:1': { id: 'osm:node:1', name: 'Publix', category: 'shop:supermarket', lat: 28.5, lon: -82.6, address: '123 Main St', aliases: [] },
    'osm:node:2': { id: 'osm:node:2', name: 'CVS', category: 'shop:chemist', lat: 28.51, lon: -82.61, address: null, aliases: ['CVS Pharmacy'] },
  };
  data.roads = {
    'osm:road:0': { id: 'osm:road:0', name: 'Main St', highway: 'residential', lat: 28.5, lon: -82.6, segments: 3 },
  };

  const compact = compactForWire(data);
  assert.equal(typeof compact.places['osm:node:1'].category, 'number');
  assert.equal(typeof compact.roads['osm:road:0'].highway, 'number');
  assert.ok(compact.stringPool.includes('shop:supermarket'));
  assert.ok(compact.stringPool.includes('residential'));

  const roundTripped = expandFromWire(compact);
  assert.deepEqual(roundTripped, data);
});
