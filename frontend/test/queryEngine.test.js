const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules, buildMockDataset } = require('./helpers');

loadModules('intentParser.js', 'searchIndex.js', 'queryEngine.js');

// 9am Eastern on a Tuesday -- deliberately a UTC instant, not a local
// Date(), so this test suite's outcome doesn't depend on the machine's
// own timezone (matches how the real app must behave for a rider whose
// phone isn't set to America/New_York).
const TUESDAY_9AM_ET = new Date('2026-08-25T13:00:00Z');
const SUNDAY_9AM_ET = new Date('2026-08-23T13:00:00Z'); // WEEKDAY service does not run

test('FIND_NEXT_ARRIVAL: answers with upcoming arrivals, soonest first', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  const answer = await TheBusQueryEngine.answerQuery('when is the next bus at Avalon Publix', TUESDAY_9AM_ET);
  assert.match(answer, /NEXT ARRIVALS AT AVALON PUBLIX/);
  assert.match(answer, /ROUTE 1 RED/);
});

test('FIND_NEXT_ARRIVAL: a route that serves the stop but has no published times says so distinctly from "no more service today"', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  const answer = await TheBusQueryEngine.answerQuery('when is the next bus at Avalon Publix', TUESDAY_9AM_ET);
  assert.match(answer, /BLUE.*SERVES THIS STOP, BUT NO PUBLISHED TIMES ARE AVAILABLE/);
});

test('FIND_NEXT_ARRIVAL: asking about a route that does not serve the named stop says so directly', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  // Pine Island Park (S2) is only served by R1 in the mock dataset -- ask about R2 (Blue) instead.
  const answer = await TheBusQueryEngine.answerQuery('when is the blue bus at Pine Island Park', TUESDAY_9AM_ET);
  assert.match(answer, /DOES NOT SERVE PINE ISLAND PARK/);
});

test('FIND_NEXT_ARRIVAL: no service on a day the service does not run', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  const answer = await TheBusQueryEngine.answerQuery('when is the next bus at Avalon Publix', SUNDAY_9AM_ET);
  // Rolls forward to Monday and must label it -- a bare "AT 8:00 AM" would misleadingly read as today.
  assert.match(answer, /TOMORROW/);
});

// calendar_dates.txt exceptions -- distinct from the weekly-pattern test
// above, which never touches addedDates/removedDates at all. A real
// GTFS feed can override the weekly pattern in EITHER direction for a
// specific date (a holiday cancellation, or extra service added for an
// event); isServiceActiveForClock (queryEngine.js) checks both before
// ever consulting the weekday flags, and both directions need their own
// test -- "the weekly pattern says no" and "an exception says no even
// though the weekly pattern says yes" are different code paths that
// could each be broken independently.
test('FIND_NEXT_ARRIVAL: a calendar_dates.txt exception REMOVES service on a day the weekly pattern alone says should run (e.g. a holiday closure)', async () => {
  const dataset = buildMockDataset();
  // TUESDAY_9AM_ET's agency-local date -- WEEKDAY normally runs Tuesdays,
  // this exception cancels specifically THIS Tuesday.
  dataset.services.WEEKDAY.removedDates = ['20260825'];
  TheBusQueryEngine.setDataset(dataset);
  const answer = await TheBusQueryEngine.answerQuery('when is the next bus at Avalon Publix', TUESDAY_9AM_ET);
  // Every one of today's otherwise-scheduled R1 arrivals must roll to
  // tomorrow, exactly like the weekly-pattern-off case above -- proving
  // the exception, not just the weekday flag, is what's being honored.
  assert.match(answer, /TOMORROW/);
});

test('FIND_NEXT_ARRIVAL: a calendar_dates.txt exception ADDS service on a day the weekly pattern alone says should NOT run (e.g. a special-event shuttle)', async () => {
  const dataset = buildMockDataset();
  // A service that never runs on any weekday by its regular pattern --
  // only this one calendar_dates-added date brings it to life.
  dataset.services.SPECIAL = {
    monday: false, tuesday: false, wednesday: false, thursday: false,
    friday: false, saturday: false, sunday: false,
    startDate: null, endDate: null,
    addedDates: ['20260825'], removedDates: [],
  };
  dataset.stops.S1.routes[0].arrivals.push(
    { tripId: 'T4', serviceId: 'SPECIAL', headsign: 'Special Event Shuttle', minutes: 10 * 60 }
  );
  TheBusQueryEngine.setDataset(dataset);
  const answer = await TheBusQueryEngine.answerQuery('when is the next bus at Avalon Publix', TUESDAY_9AM_ET);
  assert.match(answer, /SPECIAL EVENT SHUTTLE/);
});

test('FIND_NEXT_ARRIVAL: ambiguous stop match asks for clarification instead of silently guessing', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  const answer = await TheBusQueryEngine.answerQuery('when is the next bus at spring hill dr', TUESDAY_9AM_ET);
  assert.match(answer, /MULTIPLE STOPS MATCH THAT/);
  assert.match(answer, /SPRING HILL DR NORTH/);
  assert.match(answer, /SPRING HILL DR SOUTH/);
});

test('FIND_NEXT_ARRIVAL: arrivals more than 30 minutes out show a clock time, not a countdown', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  const answer = await TheBusQueryEngine.answerQuery('when is the next bus at Avalon Publix', TUESDAY_9AM_ET);
  assert.match(answer, /AT 7:27 PM/); // the day's last arrival, ~10hr away
  assert.doesNotMatch(answer, /\d+ MIN \(7:27 PM\)/);
});

test('FIND_STOP_LOCATION: returns coordinates and served routes', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  const answer = await TheBusQueryEngine.answerQuery('where is Avalon Publix', TUESDAY_9AM_ET);
  assert.match(answer, /STOP: AVALON PUBLIX/);
  assert.match(answer, /28\.50000, -82\.60000/);
});

// getLastLocation() is a side channel, not part of answerQuery()'s own
// return value -- app.js reads it right after awaiting answerQuery() to
// optionally show a small static map image alongside a location-bearing
// answer, without changing answerQuery()'s plain-string contract every
// other test above already depends on.
test('getLastLocation: a stop-location answer exposes that stop\'s coordinates for the caller to optionally show a map', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  await TheBusQueryEngine.answerQuery('where is Avalon Publix', TUESDAY_9AM_ET);
  assert.deepEqual(TheBusQueryEngine.getLastLocation(), { lat: 28.50, lon: -82.60, label: 'Avalon Publix' });
});

test('getLastLocation: a query with no specific location (e.g. listing a route\'s stops) clears it, not leaving a stale previous location attached', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  await TheBusQueryEngine.answerQuery('where is Avalon Publix', TUESDAY_9AM_ET);
  assert.notEqual(TheBusQueryEngine.getLastLocation(), null);

  await TheBusQueryEngine.answerQuery('list stops on route 1', TUESDAY_9AM_ET);
  assert.equal(TheBusQueryEngine.getLastLocation(), null);
});

test('LIST_ROUTE_STOPS: lists every stop on a route in order', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  const answer = await TheBusQueryEngine.answerQuery('list stops on route 1', TUESDAY_9AM_ET);
  assert.match(answer, /1\. AVALON PUBLIX/);
  assert.match(answer, /2\. PINE ISLAND PARK/);
});

test('FIND_FIRST_LAST_BUS: first and last bus answer from the whole day\'s schedule, not just what\'s upcoming', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  const first = await TheBusQueryEngine.answerQuery('what is the first bus at Avalon Publix', TUESDAY_9AM_ET);
  assert.match(first, /FIRST BUS TODAY/);
  assert.match(first, /8:00 AM/);

  const last = await TheBusQueryEngine.answerQuery('what is the last bus at Avalon Publix', TUESDAY_9AM_ET);
  assert.match(last, /LAST BUS TODAY/);
  assert.match(last, /7:27 PM/);
});

test('FIND_NEAREST_STOP: resolves a geocoded place to the actual closest stop by distance', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  TheBusSearchIndex.resetForTests();
  global.TheBusGeocode = {
    // Essentially on top of S1 (28.50,-82.60) -- unambiguously closer to
    // it than to any other mock stop (S2/S3/S4 are all much farther).
    lookup: async () => ({ lat: 28.5001, lon: -82.6001, displayName: 'Test Landmark' }),
  };
  try {
    const answer = await TheBusQueryEngine.answerQuery('nearest stop to the test landmark', TUESDAY_9AM_ET);
    assert.match(answer, /NEAREST STOP TO THE TEST LANDMARK/);
    assert.match(answer, /AVALON PUBLIX/);
    // getLastLocation() must expose the resolved STOP's coordinates (for
    // a map centered on where the bus actually is), not the landmark's
    // raw geocoded point -- those can differ by a real distance.
    assert.deepEqual(TheBusQueryEngine.getLastLocation(), { lat: 28.50, lon: -82.60, label: 'Avalon Publix' });
  } finally {
    delete global.TheBusGeocode;
  }
});

test('FIND_NEAREST_STOP: a place the geocoder can\'t find gets an honest "couldn\'t find" answer, not a crash', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  TheBusSearchIndex.resetForTests();
  global.TheBusGeocode = { lookup: async () => null };
  try {
    const answer = await TheBusQueryEngine.answerQuery('nearest stop to some obscure business', TUESDAY_9AM_ET);
    assert.match(answer, /COULDN'T FIND/);
  } finally {
    delete global.TheBusGeocode;
  }
});

test('FIND_NEAREST_STOP: an informal landmark phrase that matches a known stop name resolves directly, offline, without ever calling the geocoder (regression guard for "walmart on 19" losing its definitive answer)', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset({
    stops: {
      W1: { id: 'W1', name: 'Walmart US19 Spring Hill', lat: 28.55, lon: -82.63, routes: [] },
      W2: { id: 'W2', name: 'US19 Applegate Dr N/E', lat: 28.56, lon: -82.64, routes: [] },
    },
  }));
  TheBusSearchIndex.resetForTests();
  // global.TheBusGeocode is deliberately left undefined here -- if the
  // code fell through to the geocoder instead of matching internally
  // first, this would throw a ReferenceError instead of answering.
  const answer = await TheBusQueryEngine.answerQuery('closest bus to walmart on 19', TUESDAY_9AM_ET);
  assert.match(answer, /IS A KNOWN STOP/);
  assert.match(answer, /WALMART US19 SPRING HILL/);
});

test('FIND_NEAREST_STOP: a known-stop answer includes each served route\'s own next arrival, not just the route names (riders need arrival times to actually catch a bus, not just a route list)', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  TheBusSearchIndex.resetForTests();
  const answer = await TheBusQueryEngine.answerQuery('nearest stop to Avalon Publix', TUESDAY_9AM_ET);
  assert.match(answer, /IS A KNOWN STOP/);
  assert.match(answer, /NEXT ARRIVALS:/);
  assert.match(answer, /ROUTE 1 RED/);
  // R2 (Blue) has zero published arrivals for this stop in the mock data --
  // must say so distinctly rather than silently omitting the route.
  assert.match(answer, /BLUE.*SERVES THIS STOP, BUT NO PUBLISHED TIMES ARE AVAILABLE/);
});

test('FIND_NEAREST_STOP: a geocoded-place answer also includes next-arrival times for the nearest stop, not just when the landmark IS the stop', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  TheBusSearchIndex.resetForTests();
  global.TheBusGeocode = {
    lookup: async () => ({ lat: 28.5001, lon: -82.6001, displayName: 'Test Landmark' }),
  };
  try {
    const answer = await TheBusQueryEngine.answerQuery('nearest stop to the test landmark', TUESDAY_9AM_ET);
    assert.match(answer, /NEXT ARRIVALS:/);
    assert.match(answer, /ROUTE 1 RED/);
  } finally {
    delete global.TheBusGeocode;
  }
});

test('FIND_NEAREST_STOP: a pre-seeded alias (from backend enrichment) resolves a stop directly, even though the official GTFS name shares no words with it -- and works fine on a stop that predates the aliases field entirely', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset({
    stops: {
      W1: {
        id: 'W1', name: 'US19 & Applegate Dr', lat: 28.55, lon: -82.63,
        aliases: ['wally world'],
        routes: [],
      },
      W2: {
        // No aliases field at all -- must not crash on a dataset synced
        // before backend/src/enrich.js existed.
        id: 'W2', name: 'US19 Brandy Dr', lat: 28.56, lon: -82.64, routes: [],
      },
    },
  }));
  TheBusSearchIndex.resetForTests();
  const answer = await TheBusQueryEngine.answerQuery('nearest stop to wally world', TUESDAY_9AM_ET);
  assert.match(answer, /IS A KNOWN STOP/);
  assert.match(answer, /US19 & APPLEGATE DR/);
});

test('FIND_NEAREST_STOP: a place looked up once is remembered (TIER 3) -- asking the exact same thing again works even if the geocoder would now fail, and never touches it', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  TheBusSearchIndex.resetForTests();
  global.TheBusGeocode = { lookup: async () => ({ lat: 28.5001, lon: -82.6001, displayName: 'Murphys Deli' }) };
  try {
    const first = await TheBusQueryEngine.answerQuery('nearest stop to murphys deli', TUESDAY_9AM_ET);
    assert.match(first, /AVALON PUBLIX/);

    // If the app fell through to the geocoder again instead of using the
    // learned alias, this would throw and the test would fail.
    global.TheBusGeocode = { lookup: async () => { throw new Error('should not be called again'); } };
    const second = await TheBusQueryEngine.answerQuery('nearest stop to murphys deli', TUESDAY_9AM_ET);
    assert.match(second, /AVALON PUBLIX/);
  } finally {
    delete global.TheBusGeocode;
  }
});

test('FIND_NEAREST_STOP: a DIFFERENT phrasing for a place looked up before still resolves offline via the local places cache (TIER 2), not just an exact-phrase alias hit (TIER 3)', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  TheBusSearchIndex.resetForTests();
  global.TheBusGeocode = { lookup: async () => ({ lat: 28.5001, lon: -82.6001, displayName: 'Test Landmark Plaza' }) };
  try {
    await TheBusQueryEngine.answerQuery('nearest stop to Test Landmark Plaza', TUESDAY_9AM_ET);

    // Different enough wording that it won't hit the exact-phrase TIER 3
    // alias for "test landmark plaza" -- must fall through to fuzzy
    // matching against the TIER 2 place cache instead. Geocoder removed
    // entirely to prove this path never needs the network.
    delete global.TheBusGeocode;
    const answer = await TheBusQueryEngine.answerQuery('closest stop near test landmark', TUESDAY_9AM_ET);
    assert.match(answer, /AVALON PUBLIX/);
  } finally {
    delete global.TheBusGeocode;
  }
});

test('FIND_NEAREST_STOP: "nearest stop to me" pulls the device\'s GPS position instead of trying to geocode the word "me"', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  TheBusSearchIndex.resetForTests();
  global.TheBusGeolocate = {
    // Essentially on top of S1 (28.50,-82.60), same as the geocoded-place test above.
    getCurrentPosition: async () => ({ lat: 28.5001, lon: -82.6001 }),
  };
  try {
    const answer = await TheBusQueryEngine.answerQuery('nearest stop to me', TUESDAY_9AM_ET);
    assert.match(answer, /NEAREST STOP TO YOU/);
    assert.match(answer, /AVALON PUBLIX/);
  } finally {
    delete global.TheBusGeolocate;
  }
});

test('FIND_NEAREST_STOP: "me" with GPS unavailable gets an honest message, not a crash', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  TheBusSearchIndex.resetForTests();
  global.TheBusGeolocate = { getCurrentPosition: async () => null };
  try {
    const answer = await TheBusQueryEngine.answerQuery('nearest stop to me', TUESDAY_9AM_ET);
    assert.match(answer, /COULDN'T GET YOUR LOCATION/);
  } finally {
    delete global.TheBusGeolocate;
  }
});

test('FIND_NEXT_ARRIVAL: no stop named at all falls back to GPS and answers for the nearest stop', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  global.TheBusGeolocate = { getCurrentPosition: async () => ({ lat: 28.5001, lon: -82.6001 }) };
  try {
    const answer = await TheBusQueryEngine.answerQuery('when is the next bus', TUESDAY_9AM_ET);
    assert.match(answer, /NEXT ARRIVALS AT AVALON PUBLIX \(NEAREST TO YOU\)/);
  } finally {
    delete global.TheBusGeolocate;
  }
});

// Broad, no-location-named phrasings ("when is the next stop?", "any
// buses nearby") -- these all mean the same thing as "when is the next
// bus at me" but never say "me"/a stop explicitly. Regression-guards
// both the classifyIntent cue coverage (a phrase like "any buses
// nearby" used to score 0 on every intent and fall to the generic
// "COMMAND NOT RECOGNIZED" help text) and the GPS fallback actually
// firing once classified.
test('FIND_NEXT_ARRIVAL: broad "when is the next stop?" phrasing (not "bus") still resolves via GPS to the nearest stop\'s real arrivals', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  global.TheBusGeolocate = { getCurrentPosition: async () => ({ lat: 28.5001, lon: -82.6001 }) };
  try {
    const answer = await TheBusQueryEngine.answerQuery('when is the next stop?', TUESDAY_9AM_ET);
    assert.match(answer, /NEXT ARRIVALS AT AVALON PUBLIX \(NEAREST TO YOU\)/);
  } finally {
    delete global.TheBusGeolocate;
  }
});

test('FIND_NEXT_ARRIVAL: "any buses nearby" and "is the bus close" -- broad phrasings with no "when"/"next" at all -- still classify as FIND_NEXT_ARRIVAL and resolve via GPS instead of falling to the generic help text', async () => {
  global.TheBusGeolocate = { getCurrentPosition: async () => ({ lat: 28.5001, lon: -82.6001 }) };
  try {
    for (const q of ['any buses nearby', 'is the bus close']) {
      // Fresh dataset (and so fresh conversational context) per query --
      // otherwise the second iteration would correctly pick up the first
      // query's resolved stop as a follow-up (a real, separate feature;
      // see queryEngine.test.js's own "SAME STOP AS BEFORE" tests) and
      // never take the GPS path this test means to isolate.
      TheBusQueryEngine.setDataset(buildMockDataset());
      const answer = await TheBusQueryEngine.answerQuery(q, TUESDAY_9AM_ET);
      assert.match(answer, /NEXT ARRIVALS AT AVALON PUBLIX \(NEAREST TO YOU\)/, `for query: "${q}"`);
    }
  } finally {
    delete global.TheBusGeolocate;
  }
});

test('FIND_NEAREST_STOP: a bare "nearest stop?"/"closest bus" with no place named at all falls back to GPS instead of demanding a place name', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  global.TheBusGeolocate = { getCurrentPosition: async () => ({ lat: 28.5001, lon: -82.6001 }) };
  try {
    const a1 = await TheBusQueryEngine.answerQuery('nearest stop?', TUESDAY_9AM_ET);
    assert.match(a1, /NEAREST STOP TO YOU:\nAVALON PUBLIX/);
    const a2 = await TheBusQueryEngine.answerQuery('closest bus', TUESDAY_9AM_ET);
    assert.match(a2, /NEAREST STOP TO YOU:\nAVALON PUBLIX/);
  } finally {
    delete global.TheBusGeolocate;
  }
});

test('FIND_NEAREST_STOP: a bare "nearest stop?" with GPS unavailable gets an honest message, not a crash', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  global.TheBusGeolocate = { getCurrentPosition: async () => null };
  try {
    const answer = await TheBusQueryEngine.answerQuery('nearest stop?', TUESDAY_9AM_ET);
    assert.match(answer, /DIDN'T CATCH A PLACE NAME/);
  } finally {
    delete global.TheBusGeolocate;
  }
});

test('FIND_NEAREST_STOP (via GPS): a route with no published times at the nearest stop falls back to the same route\'s real next departure at the nearest OTHER stop that has one, instead of just admitting defeat', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset({
    routes: {
      R1: { id: 'R1', shortName: '', longName: 'Route 1 Red', color: '#ff0000', textColor: null, stopIds: ['S1', 'S2'], shapePoints: [] },
    },
    stops: {
      S1: {
        id: 'S1', name: 'No-Data Stop', lat: 28.50, lon: -82.60,
        routes: [{ routeId: 'R1', shortName: '', longName: 'Route 1 Red', color: '#ff0000', arrivals: [] }],
      },
      S2: {
        id: 'S2', name: 'Has-Data Stop', lat: 28.501, lon: -82.601,
        routes: [{
          routeId: 'R1', shortName: '', longName: 'Route 1 Red', color: '#ff0000',
          arrivals: [{ tripId: 'T1', serviceId: 'WEEKDAY', headsign: 'Downtown', minutes: 10 * 60 }],
        }],
      },
    },
  }));
  TheBusSearchIndex.resetForTests();
  global.TheBusGeolocate = { getCurrentPosition: async () => ({ lat: 28.50, lon: -82.60 }) }; // on top of S1
  try {
    const answer = await TheBusQueryEngine.answerQuery('nearest stop to me', TUESDAY_9AM_ET);
    assert.match(answer, /NO-DATA STOP/); // GPS still resolves to the actual nearest stop
    assert.match(answer, /NO PUBLISHED TIME HERE; NEXT DEPARTURE VIA HAS-DATA STOP/);
    assert.match(answer, /AT 10:00 AM/); // TUESDAY_9AM_ET -> S2's 10am R1 arrival, still today
  } finally {
    delete global.TheBusGeolocate;
  }
});

test('FIND_NEAREST_STOP: when NO nearby stop on the route has published times either (a single-stop route, e.g.), the plain fallback message is unchanged -- regression guard for the mock dataset\'s existing Blue-route case', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  TheBusSearchIndex.resetForTests();
  const answer = await TheBusQueryEngine.answerQuery('nearest stop to Avalon Publix', TUESDAY_9AM_ET);
  assert.match(answer, /BLUE.*SERVES THIS STOP, BUT NO PUBLISHED TIMES ARE AVAILABLE/);
  assert.doesNotMatch(answer, /VIA/);
});

test('FIND_NEXT_ARRIVAL: no stop named and GPS unavailable asks for a stop name instead of crashing', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  global.TheBusGeolocate = { getCurrentPosition: async () => null };
  try {
    const answer = await TheBusQueryEngine.answerQuery('when is the next bus', TUESDAY_9AM_ET);
    assert.match(answer, /DIDN'T CATCH A STOP NAME/);
  } finally {
    delete global.TheBusGeolocate;
  }
});

test('answerQuery: an unrecognized query gets the help text, not a crash', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  const answer = await TheBusQueryEngine.answerQuery('asdf qwer zxcv', TUESDAY_9AM_ET);
  assert.match(answer, /COMMAND NOT RECOGNIZED/);
});

test('answerQuery: a bare stop name with no command keyword at all still answers with its arrivals (onboarding promises this works, no "when"/"where" required)', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  const answer = await TheBusQueryEngine.answerQuery('Avalon Publix', TUESDAY_9AM_ET);
  assert.match(answer, /NEXT ARRIVALS AT AVALON PUBLIX/);
  assert.match(answer, /ROUTE 1 RED/);
});

test('answerQuery: a bare route name with no command keyword at all (not even the word "route") still lists its stops', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  const answer = await TheBusQueryEngine.answerQuery('Blue', TUESDAY_9AM_ET);
  assert.match(answer, /STOPS:/);
});

// PLAN_TRIP -- "from X to Y" multi-leg itinerary planning.
test('PLAN_TRIP: a direct ride (both stops on the same route, same trip) is answered with a single leg and no transfer note', async () => {
  const dataset = buildMockDataset();
  dataset.stops.S1.routes[0].arrivals.push({ tripId: 'TDIRECT', serviceId: 'WEEKDAY', headsign: 'Pine Island Park', minutes: 9 * 60 });
  dataset.stops.S2.routes[0].arrivals.push({ tripId: 'TDIRECT', serviceId: 'WEEKDAY', headsign: 'Pine Island Park', minutes: 9 * 60 + 15 });
  TheBusQueryEngine.setDataset(dataset);
  TheBusSearchIndex.resetForTests();
  const answer = await TheBusQueryEngine.answerQuery('from Avalon Publix to Pine Island Park', TUESDAY_9AM_ET);
  assert.match(answer, /TRIP FROM AVALON PUBLIX TO PINE ISLAND PARK/);
  assert.match(answer, /BOARD ROUTE 1 RED TOWARD PINE ISLAND PARK AT AVALON PUBLIX/);
  assert.match(answer, /ARRIVE 15 MIN \(9:15 AM\)/);
  assert.doesNotMatch(answer, /TRANSFER/);
  assert.match(answer, /TOTAL TRAVEL TIME: ~15 MIN \(DIRECT\)/);
});

test('PLAN_TRIP: a trip needing one transfer at a shared hub stop is planned correctly, and correctly labeled as a transfer', async () => {
  const dataset = buildMockDataset({
    routes: {
      R1: { id: 'R1', shortName: '', longName: 'Route 1 Red', color: '#f00', textColor: null, stopIds: ['S1', 'HUB'], shapePoints: [] },
      R2: { id: 'R2', shortName: '', longName: 'Route 2 Blue', color: '#00f', textColor: null, stopIds: ['HUB', 'S2'], shapePoints: [] },
    },
    stops: {
      S1: {
        id: 'S1', name: 'Avalon Publix', lat: 28.50, lon: -82.60,
        routes: [{ routeId: 'R1', shortName: '', longName: 'Route 1 Red', color: '#f00', arrivals: [
          { tripId: 'T1', serviceId: 'WEEKDAY', headsign: 'Downtown Hub', minutes: 9 * 60 },
        ] }],
      },
      HUB: {
        id: 'HUB', name: 'Downtown Transfer Hub', lat: 28.52, lon: -82.58,
        routes: [
          { routeId: 'R1', shortName: '', longName: 'Route 1 Red', color: '#f00', arrivals: [
            { tripId: 'T1', serviceId: 'WEEKDAY', headsign: 'Downtown Hub', minutes: 9 * 60 + 20 },
          ] },
          { routeId: 'R2', shortName: '', longName: 'Route 2 Blue', color: '#00f', arrivals: [
            { tripId: 'T2', serviceId: 'WEEKDAY', headsign: 'Pine Island Park', minutes: 9 * 60 + 30 },
          ] },
        ],
      },
      S2: {
        id: 'S2', name: 'Pine Island Park', lat: 28.60, lon: -82.70,
        routes: [{ routeId: 'R2', shortName: '', longName: 'Route 2 Blue', color: '#00f', arrivals: [
          { tripId: 'T2', serviceId: 'WEEKDAY', headsign: 'Pine Island Park', minutes: 9 * 60 + 45 },
        ] }],
      },
    },
  });
  TheBusQueryEngine.setDataset(dataset);
  TheBusSearchIndex.resetForTests();
  const answer = await TheBusQueryEngine.answerQuery('from Avalon Publix to Pine Island Park', TUESDAY_9AM_ET);
  assert.match(answer, /1\. BOARD ROUTE 1 RED TOWARD DOWNTOWN HUB AT AVALON PUBLIX/);
  assert.match(answer, /TRANSFER \(3\+ MIN\)/);
  assert.match(answer, /2\. BOARD ROUTE 2 BLUE TOWARD PINE ISLAND PARK AT DOWNTOWN TRANSFER HUB/);
  assert.match(answer, /TOTAL TRAVEL TIME: ~45 MIN \(1 TRANSFER\)/);
});

test('PLAN_TRIP: two real-world places (resolved via the geocoder, not named stops) plan a trip through their nearest stops, including a walking line for each end', async () => {
  const dataset = buildMockDataset();
  // Departs 10 min after "now" -- unlike the exact-named-stop test above
  // (walkMinutes: 0), a geocoded point is a fraction of a mile OFF its
  // nearest stop, so it needs a little real buffer to walk there first.
  dataset.stops.S1.routes[0].arrivals.push({ tripId: 'TDIRECT', serviceId: 'WEEKDAY', headsign: 'Pine Island Park', minutes: 9 * 60 + 10 });
  dataset.stops.S2.routes[0].arrivals.push({ tripId: 'TDIRECT', serviceId: 'WEEKDAY', headsign: 'Pine Island Park', minutes: 9 * 60 + 25 });
  TheBusQueryEngine.setDataset(dataset);
  TheBusSearchIndex.resetForTests();
  // Just off S1's real coordinates (28.50, -82.60) and S2's (28.60, -82.70) --
  // close enough that each resolves to that stop as its nearest, but not an
  // exact match, so this exercises the NETWORK/walking-distance path rather
  // than the "named stop" case the direct-ride test above already covers.
  let call = 0;
  global.TheBusGeocode = {
    lookup: async () => {
      call += 1;
      return call === 1 ? { lat: 28.5005, lon: -82.6005 } : { lat: 28.6005, lon: -82.7005 };
    },
  };
  try {
    const answer = await TheBusQueryEngine.answerQuery('from Some Random Shop to Another Random Place', TUESDAY_9AM_ET);
    assert.match(answer, /WALK .* MI TO AVALON PUBLIX/);
    assert.match(answer, /WALK .* MI FROM PINE ISLAND PARK TO YOUR DESTINATION/);
  } finally {
    delete global.TheBusGeocode;
  }
});

test('PLAN_TRIP: no bus connection exists between the two places gives an honest message, not a crash', async () => {
  const dataset = buildMockDataset();
  dataset.stops.ISOLATED = { id: 'ISOLATED', name: 'Isolated Stop', lat: 29.0, lon: -83.0, routes: [] };
  TheBusQueryEngine.setDataset(dataset);
  TheBusSearchIndex.resetForTests();
  const answer = await TheBusQueryEngine.answerQuery('from Avalon Publix to Isolated Stop', TUESDAY_9AM_ET);
  assert.match(answer, /COULDN'T FIND A BUS CONNECTION/);
});

test('PLAN_TRIP: an origin and destination that are barely apart suggest walking instead of proposing a bus itinerary', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  TheBusSearchIndex.resetForTests();
  const answer = await TheBusQueryEngine.answerQuery('from Avalon Publix to Avalon Publix', TUESDAY_9AM_ET);
  assert.match(answer, /WALKING IS PROBABLY FASTER THAN A BUS/);
});

test('PLAN_TRIP: a query classified as PLAN_TRIP but missing an extractable origin/destination asks for both instead of crashing', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
  const answer = await TheBusQueryEngine.answerQuery('plan my trip', TUESDAY_9AM_ET);
  assert.match(answer, /DIDN'T CATCH BOTH A START AND AN END/);
});

// Cross-agency trip planning: two counties' feeds never share a literal
// stop id, so a real regional transfer only exists as "get off here,
// walk a short distance, board a different agency's bus over there" --
// this is what getNearbyStopsIndex()/relaxRound's nearby-stop seeding
// exists for. HERN_HUB and PASCO_HUB below are two DIFFERENT physical
// stops (different agencyId) ~0.18 mi apart -- no route serves both, so
// this itinerary is only findable via that walking-transfer mechanism.
test('FIND_NEXT_ARRIVAL: a route with an agencyLabel (a merged multi-agency dataset) gets it prefixed onto every mention, disambiguating two agencies that both happen to have a "Route 1"', async () => {
  const dataset = buildMockDataset({
    stops: {
      S1: {
        id: 'S1', name: 'Shared-Named Stop', lat: 28.50, lon: -82.60,
        routes: [{
          routeId: 'P1', shortName: '', longName: 'Route 1', color: '#00f', agencyId: 'pasco', agencyLabel: 'PascoGo',
          arrivals: [{ tripId: 'T1', serviceId: 'WEEKDAY', headsign: 'Somewhere', minutes: 9 * 60 + 10 }],
        }],
      },
    },
  });
  TheBusQueryEngine.setDataset(dataset);
  const answer = await TheBusQueryEngine.answerQuery('when is the next bus at Shared-Named Stop', TUESDAY_9AM_ET);
  assert.match(answer, /PASCOGO ROUTE 1/);
});

test('FIND_NEXT_ARRIVAL: a route whose long name is just "Route " + its short name is NOT shown as a redundant "ROUTE 14 (ROUTE 14)" (regression guard for a real bug found by running the ETL against PascoGo\'s actual feed, which populates both fields this way -- unlike Hernando\'s blank-shortName style)', async () => {
  const dataset = buildMockDataset({
    stops: {
      S1: {
        id: 'S1', name: 'Pasco Stop', lat: 28.50, lon: -82.60,
        routes: [{
          routeId: 'P14', shortName: '14', longName: 'Route 14', color: '#002395', agencyId: 'pasco', agencyLabel: 'PascoGo',
          arrivals: [{ tripId: 'T1', serviceId: 'WEEKDAY', headsign: 'Somewhere', minutes: 9 * 60 + 10 }],
        }],
      },
    },
  });
  TheBusQueryEngine.setDataset(dataset);
  const answer = await TheBusQueryEngine.answerQuery('when is the next bus at Pasco Stop', TUESDAY_9AM_ET);
  assert.match(answer, /PASCOGO ROUTE 14 --/);
  assert.doesNotMatch(answer, /ROUTE 14 \(ROUTE 14\)/);
});

test('FIND_NEXT_ARRIVAL: a route with genuinely different short/long names (e.g. HART\'s "1"/"Florida Avenue") still shows both -- the redundancy fix must not swallow real information', async () => {
  const dataset = buildMockDataset({
    stops: {
      S1: {
        id: 'S1', name: 'HART Stop', lat: 28.50, lon: -82.60,
        routes: [{
          routeId: 'H1', shortName: '1', longName: 'Florida Avenue', color: '#09346D', agencyId: 'hart', agencyLabel: 'HART',
          arrivals: [{ tripId: 'T1', serviceId: 'WEEKDAY', headsign: 'Somewhere', minutes: 9 * 60 + 10 }],
        }],
      },
    },
  });
  TheBusQueryEngine.setDataset(dataset);
  const answer = await TheBusQueryEngine.answerQuery('when is the next bus at HART Stop', TUESDAY_9AM_ET);
  assert.match(answer, /HART ROUTE 1 \(FLORIDA AVENUE\)/);
});

test('PLAN_TRIP: connects two different agencies via a short walk between their nearest stops (the core "multi-county" mechanism)', async () => {
  const dataset = buildMockDataset({
    routes: {
      H1: { id: 'H1', shortName: '', longName: 'Hernando Route 1', color: '#f00', textColor: null, stopIds: ['HERN_A', 'HERN_HUB'], shapePoints: [] },
      P1: { id: 'P1', shortName: '', longName: 'Pasco Route 1', color: '#00f', textColor: null, stopIds: ['PASCO_HUB', 'PASCO_B'], shapePoints: [] },
    },
    stops: {
      HERN_A: {
        id: 'HERN_A', name: 'Hernando Start', lat: 28.40, lon: -82.70, agencyId: 'hernando', agencyLabel: 'Hernando County Transit',
        routes: [{ routeId: 'H1', shortName: '', longName: 'Hernando Route 1', color: '#f00', arrivals: [
          { tripId: 'TH1', serviceId: 'WEEKDAY', headsign: 'Hernando Hub', minutes: 9 * 60 },
        ] }],
      },
      HERN_HUB: {
        id: 'HERN_HUB', name: 'County Line Hub (Hernando Side)', lat: 28.50, lon: -82.60, agencyId: 'hernando', agencyLabel: 'Hernando County Transit',
        routes: [{ routeId: 'H1', shortName: '', longName: 'Hernando Route 1', color: '#f00', arrivals: [
          { tripId: 'TH1', serviceId: 'WEEKDAY', headsign: 'Hernando Hub', minutes: 9 * 60 + 20 },
        ] }],
      },
      // ~0.18 mi from HERN_HUB -- a DIFFERENT agency's stop, close enough to walk, too far to be the "same place."
      PASCO_HUB: {
        id: 'PASCO_HUB', name: 'County Line Hub (Pasco Side)', lat: 28.502, lon: -82.598, agencyId: 'pasco', agencyLabel: 'PascoGo',
        routes: [{ routeId: 'P1', shortName: '', longName: 'Pasco Route 1', color: '#00f', arrivals: [
          { tripId: 'TP1', serviceId: 'WEEKDAY', headsign: 'Pasco Destination', minutes: 9 * 60 + 35 },
        ] }],
      },
      PASCO_B: {
        id: 'PASCO_B', name: 'Pasco Destination', lat: 28.55, lon: -82.55, agencyId: 'pasco', agencyLabel: 'PascoGo',
        routes: [{ routeId: 'P1', shortName: '', longName: 'Pasco Route 1', color: '#00f', arrivals: [
          { tripId: 'TP1', serviceId: 'WEEKDAY', headsign: 'Pasco Destination', minutes: 9 * 60 + 50 },
        ] }],
      },
    },
  });
  TheBusQueryEngine.setDataset(dataset);
  TheBusSearchIndex.resetForTests();
  const answer = await TheBusQueryEngine.answerQuery('from Hernando Start to Pasco Destination', TUESDAY_9AM_ET);
  assert.match(answer, /1\. BOARD ROUTE HERNANDO ROUTE 1 TOWARD HERNANDO HUB AT HERNANDO START/);
  assert.match(answer, /RIDE TO COUNTY LINE HUB \(HERNANDO SIDE\)/);
  assert.doesNotMatch(answer, /\n   TRANSFER \(/, 'a walking transfer should show its own WALK line, not the plain same-stop TRANSFER note');
  assert.match(answer, /WALK 0\.1[0-9] MI TO COUNTY LINE HUB \(PASCO SIDE\)/);
  assert.match(answer, /2\. BOARD ROUTE PASCO ROUTE 1 TOWARD PASCO DESTINATION AT COUNTY LINE HUB \(PASCO SIDE\)/);
  assert.match(answer, /TOTAL TRAVEL TIME: ~50 MIN \(1 TRANSFER\)/);
});

test('PLAN_TRIP: never proposes a cross-agency-style walking transfer between two stops of the SAME agency (that would just be an ordinary same-stop transfer, not a new capability)', async () => {
  // Same shape as the cross-agency test above (a far origin/destination,
  // each one ride away from a "hub" pair ~0.18 mi apart) but BOTH hub
  // stops share the same agencyId this time -- getNearbyStopsIndex()
  // must exclude same-agency pairs, so no walking transfer is ever
  // offered between them and this trip should have no real connection.
  const dataset = buildMockDataset({
    routes: {
      H1: { id: 'H1', shortName: '', longName: 'Route 1', color: '#f00', textColor: null, stopIds: ['A', 'HUB1'], shapePoints: [] },
      H2: { id: 'H2', shortName: '', longName: 'Route 2', color: '#00f', textColor: null, stopIds: ['HUB2', 'B'], shapePoints: [] },
    },
    stops: {
      A: {
        id: 'A', name: 'Far Stop A', lat: 28.40, lon: -82.70, agencyId: 'hernando', agencyLabel: 'Hernando County Transit',
        routes: [{ routeId: 'H1', shortName: '', longName: 'Route 1', color: '#f00', arrivals: [
          { tripId: 'TA', serviceId: 'WEEKDAY', headsign: 'Hub One', minutes: 9 * 60 },
        ] }],
      },
      HUB1: {
        id: 'HUB1', name: 'Hub One', lat: 28.50, lon: -82.60, agencyId: 'hernando', agencyLabel: 'Hernando County Transit',
        routes: [{ routeId: 'H1', shortName: '', longName: 'Route 1', color: '#f00', arrivals: [
          { tripId: 'TA', serviceId: 'WEEKDAY', headsign: 'Hub One', minutes: 9 * 60 + 20 },
        ] }],
      },
      // ~0.18 mi from HUB1, but the SAME agencyId -- must NOT be offered as a walking transfer.
      HUB2: {
        id: 'HUB2', name: 'Hub Two', lat: 28.502, lon: -82.598, agencyId: 'hernando', agencyLabel: 'Hernando County Transit',
        routes: [{ routeId: 'H2', shortName: '', longName: 'Route 2', color: '#00f', arrivals: [
          { tripId: 'TB', serviceId: 'WEEKDAY', headsign: 'Far Stop B', minutes: 9 * 60 + 35 },
        ] }],
      },
      B: {
        id: 'B', name: 'Far Stop B', lat: 28.55, lon: -82.55, agencyId: 'hernando', agencyLabel: 'Hernando County Transit',
        routes: [{ routeId: 'H2', shortName: '', longName: 'Route 2', color: '#00f', arrivals: [
          { tripId: 'TB', serviceId: 'WEEKDAY', headsign: 'Far Stop B', minutes: 9 * 60 + 50 },
        ] }],
      },
    },
  });
  TheBusQueryEngine.setDataset(dataset);
  TheBusSearchIndex.resetForTests();
  const answer = await TheBusQueryEngine.answerQuery('from Far Stop A to Far Stop B', TUESDAY_9AM_ET);
  assert.match(answer, /COULDN'T FIND A BUS CONNECTION/);
});
