const test = require('node:test');
const assert = require('node:assert/strict');

function freshModule(env = {}) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/swiftlyGtfsRt')];
  const mod = require('../src/swiftlyGtfsRt');
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

function jsonRes(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

// ---- pure parsers (no network) ----

test('normalizeAlert parses a GTFS-RT alert entity, English text, routes and stops', () => {
  const { mod, restore } = freshModule();
  try {
    const alert = mod.normalizeAlert({
      id: 'A1',
      alert: {
        cause: 'CONSTRUCTION', effect: 'DETOUR', severityLevel: 'WARNING',
        headerText: { translation: [{ language: 'es', text: 'Desvío' }, { language: 'en', text: 'Route 5 detour' }] },
        descriptionText: { translation: [{ language: 'en', text: 'Buses skip Main & 1st' }] },
        informedEntity: [{ routeId: '5' }, { stopId: '1234' }],
        activePeriod: [{ start: 100, end: 200 }],
      },
    });
    assert.equal(alert.id, 'A1');
    assert.equal(alert.header, 'Route 5 detour'); // English preferred over the first (Spanish) translation
    assert.equal(alert.description, 'Buses skip Main & 1st');
    assert.equal(alert.effect, 'DETOUR');
    assert.deepEqual(alert.routes, ['5']);
    assert.deepEqual(alert.stops, ['1234']);
    assert.deepEqual(alert.activePeriods, [{ start: 100, end: 200 }]);
  } finally { restore(); }
});

test('isAlertActive: no active period = always active; otherwise honors start/end', () => {
  const { mod, restore } = freshModule();
  try {
    assert.equal(mod.isAlertActive({ activePeriods: [] }, 500), true);
    assert.equal(mod.isAlertActive({ activePeriods: [{ start: 100, end: 200 }] }, 150), true);
    assert.equal(mod.isAlertActive({ activePeriods: [{ start: 100, end: 200 }] }, 250), false);
    assert.equal(mod.isAlertActive({ activePeriods: [{ start: 100, end: null }] }, 1e9), true);
  } finally { restore(); }
});

test('parseTripUpdates builds a by-stop index and tolerates snake_case', () => {
  const { mod, restore } = freshModule();
  try {
    const feed = {
      entity: [
        { id: 'tu1', tripUpdate: { trip: { routeId: '5', tripId: 'T1' }, stopTimeUpdate: [
          { stopId: '1234', arrival: { time: 1000, delay: 60 } },
          { stopId: '5678', departure: { time: 1200 } },
        ] } },
        // snake_case variant
        { id: 'tu2', trip_update: { trip: { route_id: '9', trip_id: 'T2' }, stop_time_update: [
          { stop_id: '1234', arrival: { time: 1500 } },
        ] } },
      ],
    };
    const { byStop } = mod.parseTripUpdates(feed, 0);
    assert.equal(byStop['1234'].length, 2);
    assert.equal(byStop['1234'][0].routeId, '5');
    assert.equal(byStop['1234'][0].time, 1000);
    assert.equal(byStop['5678'][0].time, 1200);
    assert.equal(byStop['1234'][1].routeId, '9'); // the snake_case entity parsed too
  } finally { restore(); }
});

test('rawStopId strips a namespaced agency prefix', () => {
  const { mod, restore } = freshModule();
  try {
    assert.equal(mod.rawStopId('hart:1234'), '1234');
    assert.equal(mod.rawStopId('1234'), '1234');
  } finally { restore(); }
});

// ---- networked paths (mocked fetch) ----

test('fetchServiceAlerts requests JSON with auth, and drops inactive + textless alerts', async () => {
  const original = global.fetch;
  let sawUrl = null;
  let sawAuth = null;
  const { mod, restore } = freshModule({ SWIFTLY_API_KEY: 'k', SWIFTLY_HART_AGENCY_KEY: 'hart' });
  const now = 150 * 1000; // ms; nowSecs = 150
  global.fetch = async (url, opts) => {
    sawUrl = String(url);
    sawAuth = opts && opts.headers && opts.headers.Authorization;
    return jsonRes({ entity: [
      { id: 'active', alert: { headerText: { translation: [{ language: 'en', text: 'Live detour' }] }, activePeriod: [{ start: 100, end: 200 }] } },
      { id: 'expired', alert: { headerText: { translation: [{ language: 'en', text: 'Old alert' }] }, activePeriod: [{ start: 0, end: 50 }] } },
      { id: 'textless', alert: { activePeriod: [] } },
    ] });
  };
  try {
    const result = await mod.fetchServiceAlerts('hart', now);
    assert.match(sawUrl, /\/real-time\/hart\/gtfs-rt-alerts\?format=json$/);
    assert.equal(sawAuth, 'k');
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0].header, 'Live detour');
  } finally {
    global.fetch = original;
    restore();
  }
});

test('predictionsForStop returns upcoming arrivals soonest-first, stripping the stop prefix', async () => {
  const original = global.fetch;
  const { mod, restore } = freshModule({ SWIFTLY_API_KEY: 'k' });
  const now = 1_000_000; // ms
  const nowSecs = now / 1000; // 1000
  global.fetch = async () => jsonRes({ entity: [
    { tripUpdate: { trip: { routeId: '5' }, stopTimeUpdate: [
      { stopId: '1234', arrival: { time: nowSecs + 600 } },   // +10 min
      { stopId: '1234', arrival: { time: nowSecs + 120 } },   // +2 min (should sort first)
      { stopId: '1234', arrival: { time: nowSecs - 300 } },   // 5 min ago -> dropped
    ] } },
  ] });
  try {
    const result = await mod.predictionsForStop('hart', 'hart:1234', { now });
    assert.equal(result.stopId, '1234');
    assert.equal(result.predictions.length, 2);
    assert.equal(result.predictions[0].minutesUntil, 2);
    assert.equal(result.predictions[1].minutesUntil, 10);
  } finally {
    global.fetch = original;
    restore();
  }
});

test('throws a clear error (no request) when no Swiftly key is configured', async () => {
  const original = global.fetch;
  const { mod, restore } = freshModule({ SWIFTLY_API_KEY: undefined });
  let called = false;
  global.fetch = async () => { called = true; return jsonRes({}); };
  try {
    await assert.rejects(() => mod.fetchServiceAlerts('hart'), /SWIFTLY_API_KEY/);
    assert.equal(called, false);
  } finally {
    global.fetch = original;
    restore();
  }
});
