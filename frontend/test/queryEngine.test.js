const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules, buildMockDataset } = require('./helpers');

loadModules('intentParser.js', 'queryEngine.js');

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
  global.TheBusGeocode = {
    // Essentially on top of S1 (28.50,-82.60) -- unambiguously closer to
    // it than to any other mock stop (S2/S3/S4 are all much farther).
    lookup: async () => ({ lat: 28.5001, lon: -82.6001, displayName: 'Test Landmark' }),
  };
  try {
    const answer = await TheBusQueryEngine.answerQuery('nearest stop to the test landmark', TUESDAY_9AM_ET);
    assert.match(answer, /NEAREST STOP TO THE TEST LANDMARK/);
    assert.match(answer, /AVALON PUBLIX/);
  } finally {
    delete global.TheBusGeocode;
  }
});

test('FIND_NEAREST_STOP: a place the geocoder can\'t find gets an honest "couldn\'t find" answer, not a crash', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
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
  // global.TheBusGeocode is deliberately left undefined here -- if the
  // code fell through to the geocoder instead of matching internally
  // first, this would throw a ReferenceError instead of answering.
  const answer = await TheBusQueryEngine.answerQuery('closest bus to walmart on 19', TUESDAY_9AM_ET);
  assert.match(answer, /IS A KNOWN STOP/);
  assert.match(answer, /WALMART US19 SPRING HILL/);
});

test('FIND_NEAREST_STOP: "nearest stop to me" pulls the device\'s GPS position instead of trying to geocode the word "me"', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());
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
