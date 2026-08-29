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
