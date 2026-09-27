const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('tripPlanner.js');

test('parseCommand extracts origin and destination from PLAN / TRIP phrasings', () => {
  assert.deepEqual(TheBusTripPlanner.parseCommand('PLAN Tampa to Orlando'), { origin: 'Tampa', dest: 'Orlando' });
  assert.deepEqual(TheBusTripPlanner.parseCommand('plan from Brooksville to Atlanta'), { origin: 'Brooksville', dest: 'Atlanta' });
  assert.deepEqual(TheBusTripPlanner.parseCommand('trip a trip from Spring Hill to Tampa'), { origin: 'Spring Hill', dest: 'Tampa' });
});

test('parseCommand ignores non-trip questions so the offline engine still handles them', () => {
  assert.equal(TheBusTripPlanner.parseCommand('when is the next bus at avalon publix'), null);
  assert.equal(TheBusTripPlanner.parseCommand('nearest stop to walmart'), null);
  // The offline engine owns bare "from X to Y" -- only the PLAN/TRIP verb routes here.
  assert.equal(TheBusTripPlanner.parseCommand('from avalon publix to pine island'), null);
});

test('buildPlanQuery encodes preferences and coordinate overrides', () => {
  const withPrefs = TheBusTripPlanner.buildPlanQuery('Tampa', 'Orlando', { fewerTransfers: true, lessWalking: true, wheelchair: true });
  assert.match(withPrefs, /from=Tampa/);
  assert.match(withPrefs, /to=Orlando/);
  assert.match(withPrefs, /maxTransfers=1/);
  assert.match(withPrefs, /maxWalk=10/);
  assert.match(withPrefs, /wheelchair=1/);

  const bare = TheBusTripPlanner.buildPlanQuery('A', 'B', {});
  assert.doesNotMatch(bare, /maxTransfers|maxWalk|wheelchair/);

  const coords = TheBusTripPlanner.buildPlanQuery('MY LOCATION', 'Publix', {}, { fromCoords: { lat: 28.5, lon: -82.6 } });
  assert.match(coords, /fromLat=28\.5/);
  assert.match(coords, /fromLon=-82\.6/);
  assert.match(coords, /to=Publix/);
  assert.match(coords, /from=MY%20LOCATION/); // name label kept alongside the coords
});

test('formatResult renders a retro itinerary with walk + bus legs', () => {
  const out = TheBusTripPlanner.formatResult({
    from: { name: 'Tampa, FL' }, to: { name: 'Orlando, FL' },
    itineraries: [{
      durationMinutes: 120, transfers: 1,
      departure: '2026-09-27T14:00:00Z', arrival: '2026-09-27T16:00:00Z',
      legs: [
        { mode: 'WALK', to: 'Marion Transit Ctr', durationMinutes: 10, distanceMeters: 750 },
        { mode: 'BUS', routeName: '200', agency: 'HART', headsign: 'Orlando', from: 'Marion Transit Ctr', to: 'Orlando Amtrak', departure: '2026-09-27T14:20:00Z', arrival: '2026-09-27T16:00:00Z' },
      ],
    }],
  });
  assert.match(out, /TRIP: TAMPA, FL -> ORLANDO, FL/);
  assert.match(out, /OPTION 1:/);
  assert.match(out, /1 TRANSFER/);
  assert.match(out, /WALK 0\.47 MI TO MARION TRANSIT CTR/);
  assert.match(out, /BUS 200 \(HART\) -> ORLANDO/);
});

test('formatResult states plainly when no route is found', () => {
  const out = TheBusTripPlanner.formatResult({ from: { name: 'A' }, to: { name: 'B' }, itineraries: [] });
  assert.match(out, /NO TRANSIT ROUTE FOUND/);
});

test('plan() short-circuits with a clear message when offline, making no request', async () => {
  const prevOnline = global.navigator.onLine;
  const prevFetch = global.fetch;
  let fetched = false;
  global.navigator.onLine = false;
  global.fetch = async () => { fetched = true; return { ok: true, json: async () => ({}) }; };
  try {
    const msg = await TheBusTripPlanner.plan('Tampa', 'Orlando');
    assert.match(msg, /NEEDS A CONNECTION/);
    assert.equal(fetched, false);
  } finally {
    global.navigator.onLine = prevOnline;
    global.fetch = prevFetch;
  }
});

test('plan() formats a successful backend response', async () => {
  const prevOnline = global.navigator.onLine;
  const prevFetch = global.fetch;
  global.navigator.onLine = true;
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ from: { name: 'Tampa' }, to: { name: 'Orlando' }, itineraries: [{ durationMinutes: 90, transfers: 0, departure: '2026-09-27T14:00:00Z', arrival: '2026-09-27T15:30:00Z', legs: [{ mode: 'BUS', routeName: '5', from: 'A', to: 'B', departure: '2026-09-27T14:00:00Z', arrival: '2026-09-27T15:30:00Z' }] }] }),
  });
  try {
    const msg = await TheBusTripPlanner.plan('Tampa', 'Orlando');
    assert.match(msg, /TRIP: TAMPA -> ORLANDO/);
    assert.match(msg, /DIRECT/);
  } finally {
    global.navigator.onLine = prevOnline;
    global.fetch = prevFetch;
  }
});

test('planStructured() returns { result } on success and { error } on failure', async () => {
  const prevOnline = global.navigator.onLine;
  const prevFetch = global.fetch;
  global.navigator.onLine = true;
  try {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ from: { name: 'A' }, to: { name: 'B' }, itineraries: [] }) });
    const ok = await TheBusTripPlanner.planStructured('A', 'B');
    assert.ok(ok.result && Array.isArray(ok.result.itineraries));
    assert.equal(ok.error, undefined);

    global.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
    const bad = await TheBusTripPlanner.planStructured('A', 'B');
    assert.match(bad.error, /UNAVAILABLE/);
    assert.equal(bad.result, undefined);
  } finally {
    global.navigator.onLine = prevOnline;
    global.fetch = prevFetch;
  }
});

test('plan() gives a friendly message when a place cannot be found (422)', async () => {
  const prevOnline = global.navigator.onLine;
  const prevFetch = global.fetch;
  global.navigator.onLine = true;
  global.fetch = async () => ({ ok: false, status: 422, json: async () => ({ text: 'Nowheresville' }) });
  try {
    const msg = await TheBusTripPlanner.plan('Nowheresville', 'Orlando');
    assert.match(msg, /COULDN'T FIND ONE OF THOSE PLACES/);
    assert.match(msg, /NOWHERESVILLE/);
  } finally {
    global.navigator.onLine = prevOnline;
    global.fetch = prevFetch;
  }
});
