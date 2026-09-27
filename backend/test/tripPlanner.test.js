const test = require('node:test');
const assert = require('node:assert/strict');

// planTrip/geocodePlace cache in module-level state, so each test gets a
// fresh require (same pattern as passio/pasco/swiftly tests).
function freshModule() {
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/tripPlanner')];
  return require('../src/tripPlanner');
}

// One MOTIS-shaped itinerary: a walk leg, then a bus leg.
const SAMPLE_PLAN = {
  from: { name: 'Tampa', lat: 27.95, lon: -82.46 },
  to: { name: 'Orlando', lat: 28.54, lon: -81.38 },
  itineraries: [
    {
      duration: 7200, startTime: '2026-09-27T14:00:00Z', endTime: '2026-09-27T16:00:00Z', transfers: 1,
      legs: [
        { mode: 'WALK', from: { name: 'Origin' }, to: { name: 'Marion Transit Ctr' },
          startTime: '2026-09-27T14:00:00Z', endTime: '2026-09-27T14:10:00Z', duration: 600, distance: 750 },
        { mode: 'BUS', routeShortName: '200', headsign: 'Orlando', agencyName: 'HART',
          from: { name: 'Marion Transit Ctr' }, to: { name: 'Orlando Amtrak' },
          startTime: '2026-09-27T14:20:00Z', endTime: '2026-09-27T16:00:00Z', duration: 6000 },
      ],
    },
  ],
};

function jsonRes(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

test('plans with explicit coords: builds the MOTIS plan URL, sends a User-Agent, and normalizes itineraries', async () => {
  const original = global.fetch;
  let planUrl = null;
  let ua = null;
  global.fetch = async (url, opts) => {
    planUrl = String(url);
    ua = opts && opts.headers && opts.headers['User-Agent'];
    return jsonRes(SAMPLE_PLAN);
  };
  try {
    const tp = freshModule();
    const result = await tp.planTrip({
      fromCoords: { name: 'Tampa', lat: 27.95, lon: -82.46 },
      toCoords: { name: 'Orlando', lat: 28.54, lon: -81.38 },
    });
    assert.match(planUrl, /\/api\/v1\/plan\?/);
    assert.match(planUrl, /fromPlace=27\.95%2C-82\.46/);
    assert.match(planUrl, /toPlace=28\.54%2C-81\.38/);
    assert.ok(ua && ua.includes('TriBus'), 'sends a meaningful User-Agent');
    assert.equal(result.itineraries.length, 1);
    const it = result.itineraries[0];
    assert.equal(it.durationMinutes, 120);
    assert.equal(it.transfers, 1);
    assert.equal(it.legs.length, 2);
    assert.deepEqual(it.legs[1], {
      mode: 'BUS', geometry: [], rental: null, routeName: '200', headsign: 'Orlando', agency: 'HART',
      from: 'Marion Transit Ctr', to: 'Orlando Amtrak',
      departure: '2026-09-27T14:20:00Z', arrival: '2026-09-27T16:00:00Z',
      durationMinutes: 100, distanceMeters: null,
    });
    assert.equal(result.legs, undefined); // top-level shape is {from,to,itineraries}
  } finally {
    global.fetch = original;
  }
});

test('decodePolyline decodes a standard Google-encoded polyline', () => {
  const tp = freshModule();
  // The canonical precision-5 example from Google's polyline docs.
  const pts = tp.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
  assert.equal(pts.length, 3);
  assert.deepEqual(pts[0].map((n) => Math.round(n * 1000) / 1000), [38.5, -120.2]);
  assert.deepEqual(pts[2].map((n) => Math.round(n * 1000) / 1000), [43.252, -126.453]);
  assert.deepEqual(tp.decodePolyline('', 7), []);
});

test('buildPlanUrl maps rider preferences to MOTIS params', () => {
  const tp = freshModule();
  const url = String(tp.buildPlanUrl({
    fromLatLon: '1,2', toLatLon: '3,4',
    prefs: { maxTransfers: 1, maxWalkSeconds: 600, wheelchair: true },
  }));
  assert.match(url, /maxTransfers=1/);
  assert.match(url, /maxPreTransitTime=600/);
  assert.match(url, /maxPostTransitTime=600/);
  assert.match(url, /pedestrianProfile=WHEELCHAIR/);
  // No prefs -> none of those params present (MOTIS defaults apply).
  const bare = String(tp.buildPlanUrl({ fromLatLon: '1,2', toLatLon: '3,4' }));
  assert.doesNotMatch(bare, /maxTransfers|pedestrianProfile|maxPreTransitTime/);
});

test('buildPlanUrl enables GBFS shared mobility when rental is requested', () => {
  const tp = freshModule();
  const url = String(tp.buildPlanUrl({ fromLatLon: '1,2', toLatLon: '3,4', prefs: { rental: true } }));
  assert.match(url, /preTransitModes=WALK%2CRENTAL/);
  assert.match(url, /postTransitModes=WALK%2CRENTAL/);
  assert.match(url, /directModes=WALK%2CRENTAL/);
});

test('a rental plan that MOTIS rejects falls back to a walk-only plan (never worse)', async () => {
  const original = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    const s = String(url);
    seen.push(s);
    if (s.includes('RENTAL')) return jsonRes(null, false, 400); // MOTIS rejects the rental mode
    return jsonRes(SAMPLE_PLAN); // walk-only retry succeeds
  };
  try {
    const tp = freshModule();
    const result = await tp.planTrip({
      fromCoords: { lat: 1, lon: 2 }, toCoords: { lat: 3, lon: 4 }, prefs: { rental: true },
    });
    assert.equal(result.itineraries.length, 1); // got a plan anyway
    assert.ok(seen.some((u) => u.includes('RENTAL')), 'tried rental first');
    assert.ok(seen.some((u) => !u.includes('RENTAL')), 'fell back without rental');
  } finally {
    global.fetch = original;
  }
});

test('geocodes text endpoints, biasing the destination search toward the origin', async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    const s = String(url);
    calls.push(s);
    if (s.includes('/geocode') && s.includes('Tampa')) return jsonRes([{ name: 'Tampa, FL', lat: 27.95, lon: -82.46 }]);
    if (s.includes('/geocode') && s.includes('Orlando')) return jsonRes([{ name: 'Orlando, FL', lat: 28.54, lon: -81.38 }]);
    if (s.includes('/plan')) return jsonRes(SAMPLE_PLAN);
    throw new Error(`unexpected URL: ${s}`);
  };
  try {
    const tp = freshModule();
    const result = await tp.planTrip({ from: 'Tampa', to: 'Orlando' });
    assert.equal(result.from.name, 'Tampa, FL');
    assert.equal(result.to.name, 'Orlando, FL');
    const orlandoGeocode = calls.find((c) => c.includes('/geocode') && c.includes('Orlando'));
    assert.match(orlandoGeocode, /place=27\.95%2C-82\.46/, 'destination geocode is biased to the origin');
  } finally {
    global.fetch = original;
  }
});

test('throws PlaceNotFoundError (naming which end) when a place cannot be resolved', async () => {
  const original = global.fetch;
  global.fetch = async (url) => (String(url).includes('/geocode') ? jsonRes([]) : jsonRes(SAMPLE_PLAN));
  try {
    const tp = freshModule();
    await assert.rejects(
      () => tp.planTrip({ from: 'Nowheresville XYZ', to: 'Orlando' }),
      (err) => err instanceof tp.PlaceNotFoundError && err.which === 'from',
    );
  } finally {
    global.fetch = original;
  }
});

test('returns an empty itinerary list (not an error) when no route connects two real places', async () => {
  const original = global.fetch;
  global.fetch = async () => jsonRes({ from: {}, to: {}, itineraries: [] });
  try {
    const tp = freshModule();
    const result = await tp.planTrip({ fromCoords: { lat: 1, lon: 2 }, toCoords: { lat: 3, lon: 4 } });
    assert.deepEqual(result.itineraries, []);
  } finally {
    global.fetch = original;
  }
});

test('throws on an upstream failure rather than returning empty', async () => {
  const original = global.fetch;
  global.fetch = async () => jsonRes(null, false, 503);
  try {
    const tp = freshModule();
    await assert.rejects(
      () => tp.planTrip({ fromCoords: { lat: 1, lon: 2 }, toCoords: { lat: 3, lon: 4 } }),
      /503/,
    );
  } finally {
    global.fetch = original;
  }
});
