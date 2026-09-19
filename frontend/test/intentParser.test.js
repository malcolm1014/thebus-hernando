const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules, buildMockDataset } = require('./helpers');

loadModules('intentParser.js');

function buildIndex(dataset) {
  return {
    routes: Object.values(dataset.routes).map((r) => ({ id: r.id, shortName: r.shortName, longName: r.longName })),
    stops: Object.values(dataset.stops).map((s) => ({ id: s.id, name: s.name })),
  };
}
const index = buildIndex(buildMockDataset());

test('classifyIntent: basic triggers for each intent', () => {
  assert.equal(TheBusIntentParser.classifyIntent('when is the next bus at Publix'), 'FIND_NEXT_ARRIVAL');
  assert.equal(TheBusIntentParser.classifyIntent('where is Publix'), 'FIND_STOP_LOCATION');
  assert.equal(TheBusIntentParser.classifyIntent('list stops on route 10'), 'LIST_ROUTE_STOPS');
  assert.equal(TheBusIntentParser.classifyIntent('nearest stop to the school'), 'FIND_NEAREST_STOP');
  assert.equal(TheBusIntentParser.classifyIntent('what is the last bus at Publix'), 'FIND_FIRST_LAST_BUS');
  assert.equal(TheBusIntentParser.classifyIntent('asdf qwer zxcv'), 'UNKNOWN');
});

test('classifyIntent: weighted scoring resolves a query mentioning two different intents\' trigger words correctly (the collision the old first-match-wins design got wrong)', () => {
  // "when" (FIND_NEXT_ARRIVAL, +2) + "next" (+2) = 4, vs "where" (FIND_STOP_LOCATION, +2) = 2 -- arrival should win.
  assert.equal(TheBusIntentParser.classifyIntent('where and when is the next bus at Publix'), 'FIND_NEXT_ARRIVAL');
});

test('classifyIntent: "first bus"/"last bus" outscores a bare "when" in the same query', () => {
  assert.equal(TheBusIntentParser.classifyIntent('when is the last bus at Publix'), 'FIND_FIRST_LAST_BUS');
});

test('classifyIntent: "schedule" alone still resolves to LIST_ROUTE_STOPS, not FIND_NEXT_ARRIVAL (regression guard -- an earlier draft of the cue table nearly broke this)', () => {
  assert.equal(TheBusIntentParser.classifyIntent("what's the schedule for route 7"), 'LIST_ROUTE_STOPS');
});

test('classifyIntent: "timetable"/"all the times" resolves to SHOW_TIMETABLE, distinct from LIST_ROUTE_STOPS\' bare "schedule"', () => {
  assert.equal(TheBusIntentParser.classifyIntent('timetable for route 7'), 'SHOW_TIMETABLE');
  assert.equal(TheBusIntentParser.classifyIntent('give me all the times for route 7'), 'SHOW_TIMETABLE');
  assert.equal(TheBusIntentParser.classifyIntent("what's the full schedule for route 7"), 'SHOW_TIMETABLE');
  // The exact regression-guarded phrase above must still go to LIST_ROUTE_STOPS -- SHOW_TIMETABLE's cues
  // deliberately don't match bare "schedule" alone.
  assert.equal(TheBusIntentParser.classifyIntent("what's the schedule for route 7"), 'LIST_ROUTE_STOPS');
});

test('normalize: expands real road-type and directional abbreviations both ways', () => {
  assert.equal(TheBusIntentParser.normalize('Forest Oaks Boulevard'), 'forest oaks blvd');
  assert.equal(TheBusIntentParser.normalize('Forest Oaks Blvd'), 'forest oaks blvd');
  assert.equal(TheBusIntentParser.normalize('Spring Hill Dr Northeast'), 'spring hill dr ne');
});

test('jaroWinkler: identical strings score 1, totally different strings score low, shared-prefix typos score high', () => {
  assert.equal(TheBusIntentParser.jaroWinkler('walmart', 'walmart'), 1);
  assert.ok(TheBusIntentParser.jaroWinkler('walmart', 'publix') < 0.5);
  assert.ok(TheBusIntentParser.jaroWinkler('wallmart', 'walmart') > 0.9); // prefix-preserving typo
});

test('fuzzyMatch: exact substring match is fully confident (no alternatives) even with other candidates present', () => {
  const candidates = [{ id: 'A', name: 'Avalon Publix' }, { id: 'B', name: 'Downtown Publix' }];
  const result = TheBusIntentParser.fuzzyMatch('when is the next bus at avalon publix', candidates);
  assert.equal(result.id, 'A');
  assert.equal(result.score, 1);
  assert.deepEqual(result.alternatives, []);
});

test('fuzzyMatch: two candidates tied at the best word-overlap score are BOTH flagged as alternatives, not silently resolved (git "did you mean" precedent)', () => {
  const candidates = [{ id: 'N', name: 'Spring Hill Dr North' }, { id: 'S', name: 'Spring Hill Dr South' }];
  const result = TheBusIntentParser.fuzzyMatch('spring hill dr', candidates);
  assert.equal(result.alternatives.length, 1);
  const allNames = [result.name, ...result.alternatives.map((a) => a.name)].sort();
  assert.deepEqual(allNames, ['Spring Hill Dr North', 'Spring Hill Dr South']);
});

test('fuzzyMatch: two name variants of the SAME stop (its official name plus a learned alias) tying on score never register as a false ambiguity between "two" candidates', () => {
  // Both candidates share id S1 -- as index.stops now does for a stop with
  // aliases (queryEngine.js's setDataset) -- and both score identically
  // via word overlap (neither name is a literal substring of the query,
  // so pass 1 can't shortcut past the tie logic pass 2 is meant to test).
  const candidates = [
    { id: 'S1', name: 'Walmart Depot' },
    { id: 'S1', name: 'Depot Plaza' },
  ];
  const result = TheBusIntentParser.fuzzyMatch('near the depot', candidates);
  assert.equal(result.id, 'S1');
  assert.deepEqual(result.alternatives, []);
});

test('fuzzyMatch: Jaro-Winkler pass aggregates across ALL matched words, not just the single best word-pair (regression guard for a real bug found during development -- a typo\'d query used to match a wrong candidate via one incidental shared word)', () => {
  const candidates = [
    { id: 'TARGET', name: 'Lakewood Plaza by Publix' },
    { id: 'DECOY', name: 'Briarwood Plaza North West' }, // shares only "Plaza"-ish with the typo'd query
  ];
  const result = TheBusIntentParser.fuzzyMatch('lakewud plaz by publiks', candidates);
  assert.equal(result.id, 'TARGET');
});

test('fuzzyMatch: a bare highway number in the query ("on 19") matches a name that has it prefixed ("US19"), and a real distinctive word wins outright over decoy stops that only share the road number (regression guard for "walmart on 19" losing its definitive answer)', () => {
  const candidates = [
    { id: 'TARGET', name: 'Walmart US19 Spring Hill' },
    { id: 'DECOY1', name: 'US19 Applegate Dr N/E' },
    { id: 'DECOY2', name: 'US19 Brandy Dr N/W' },
  ];
  const result = TheBusIntentParser.fuzzyMatch(TheBusIntentParser.normalize('walmart on 19'), candidates);
  assert.equal(result.id, 'TARGET');
  assert.deepEqual(result.alternatives, []);
});

test('fuzzyMatch: a bare highway number with NO other distinguishing word is still genuinely ambiguous and gets flagged, not silently guessed', () => {
  const candidates = [
    { id: 'DECOY1', name: 'US19 Applegate Dr N/E' },
    { id: 'DECOY2', name: 'US19 Brandy Dr N/W' },
  ];
  const result = TheBusIntentParser.fuzzyMatch(TheBusIntentParser.normalize('stop on 19'), candidates);
  assert.equal(result.alternatives.length, 1);
});

test('parseQuery: extracts a free-text landmark for FIND_NEAREST_STOP without matching it against known stop names', () => {
  const parsed = TheBusIntentParser.parseQuery('nearest stop to Springstead High School', index);
  assert.equal(parsed.intent, 'FIND_NEAREST_STOP');
  assert.equal(parsed.landmark, 'Springstead High School');
});

test('parseQuery: extracts first-vs-last for FIND_FIRST_LAST_BUS', () => {
  assert.equal(TheBusIntentParser.parseQuery('what is the first bus at Publix', index).firstOrLast, 'first');
  assert.equal(TheBusIntentParser.parseQuery('what is the last bus at Publix', index).firstOrLast, 'last');
});

test('parseQuery: route "N" number matches even when route_short_name is blank and the number lives in route_long_name (real Hernando County feed quirk)', () => {
  const parsed = TheBusIntentParser.parseQuery('when is route 1 at Publix', index);
  assert.equal(parsed.route.id, 'R1');
});

test('classifyIntent: "from X to Y" resolves to PLAN_TRIP even when the query also contains other intents\' trigger words ("when"/"next")', () => {
  assert.equal(TheBusIntentParser.classifyIntent('I need to go from Publix Lakewood Plaza to Kass Circle'), 'PLAN_TRIP');
  assert.equal(TheBusIntentParser.classifyIntent('what\'s the next bus from Publix to Kass Circle'), 'PLAN_TRIP');
  assert.equal(TheBusIntentParser.classifyIntent('how do I get from the school to the mall'), 'PLAN_TRIP');
});

test('classifyIntent: a bare "to" with no "from" does not false-positive into PLAN_TRIP (e.g. "nearest stop to X" stays FIND_NEAREST_STOP)', () => {
  assert.equal(TheBusIntentParser.classifyIntent('nearest stop to the school'), 'FIND_NEAREST_STOP');
});

test('classifyIntent: broad, no-stop-named phrasings that never say "when"/"next" still resolve to FIND_NEXT_ARRIVAL instead of UNKNOWN (regression guard -- "any buses nearby" used to score 0 on every intent)', () => {
  assert.equal(TheBusIntentParser.classifyIntent('any buses nearby'), 'FIND_NEXT_ARRIVAL');
  assert.equal(TheBusIntentParser.classifyIntent('is the bus close'), 'FIND_NEXT_ARRIVAL');
  assert.equal(TheBusIntentParser.classifyIntent('what time is the next bus near me'), 'FIND_NEXT_ARRIVAL');
});

test('parseQuery: extracts origin/destination for "from X to Y", stopping at the FIRST "to" after "from" even when an earlier "to" appears before it', () => {
  const parsed = TheBusIntentParser.parseQuery('I need to go from Publix Lakewood Plaza to Kass Circle', index);
  assert.equal(parsed.intent, 'PLAN_TRIP');
  assert.equal(parsed.origin, 'Publix Lakewood Plaza');
  assert.equal(parsed.destination, 'Kass Circle');
});

test('parseQuery: extracts origin/destination for the reverse "to Y from X" phrasing', () => {
  const parsed = TheBusIntentParser.parseQuery('how do I get to Kass Circle from Publix Lakewood Plaza', index);
  assert.equal(parsed.intent, 'PLAN_TRIP');
  assert.equal(parsed.origin, 'Publix Lakewood Plaza');
  assert.equal(parsed.destination, 'Kass Circle');
});

test('classifyIntent: "nearest <category>" resolves to FIND_NEAREST_PLACE, distinct from FIND_NEAREST_STOP\'s bare "nearest stop"', () => {
  assert.equal(TheBusIntentParser.classifyIntent('nearest pharmacy'), 'FIND_NEAREST_PLACE');
  assert.equal(TheBusIntentParser.classifyIntent('closest gas station to Publix'), 'FIND_NEAREST_PLACE');
  assert.equal(TheBusIntentParser.classifyIntent('is there a grocery store nearby'), 'FIND_NEAREST_PLACE');
  // Regression guard: a bare "nearest stop" (no category word) must NOT be hijacked by the new intent.
  assert.equal(TheBusIntentParser.classifyIntent('nearest stop'), 'FIND_NEAREST_STOP');
  assert.equal(TheBusIntentParser.classifyIntent('nearest stop to the school'), 'FIND_NEAREST_STOP');
});

test('extractPlaceCategory: maps a spoken category phrase to its OSM tag value(s), preferring the longest matching phrase', () => {
  assert.deepEqual(TheBusIntentParser.extractPlaceCategory('nearest gas station'), ['amenity:fuel']);
  assert.deepEqual(TheBusIntentParser.extractPlaceCategory('nearest grocery store'), ['shop:supermarket', 'shop:grocery']);
  assert.equal(TheBusIntentParser.extractPlaceCategory('nearest bus stop'), null);
});

test('parseQuery: FIND_NEAREST_PLACE populates placeCategory and, when a connector is present, landmark -- same extractLandmark() shape FIND_NEAREST_STOP already uses', () => {
  const parsed = TheBusIntentParser.parseQuery('nearest pharmacy to Publix', index);
  assert.equal(parsed.intent, 'FIND_NEAREST_PLACE');
  assert.deepEqual(parsed.placeCategory, ['amenity:pharmacy', 'shop:chemist']);
  assert.equal(parsed.landmark, 'Publix');
});

test('parseQuery: a bare "nearest pharmacy" (no connector) has no landmark -- callers fall back to GPS, same as FIND_NEAREST_STOP\'s own bare "nearest stop"', () => {
  const parsed = TheBusIntentParser.parseQuery('nearest pharmacy', index);
  assert.equal(parsed.intent, 'FIND_NEAREST_PLACE');
  assert.equal(parsed.landmark, null);
});

test('parseQuery: extracts a bundled OSM place/road match when the index carries them, independent of which intent the query classified as', () => {
  const indexWithOsm = { ...index, places: [{ id: 'osm:node:1', name: 'Walgreens' }], roads: [{ id: 'osm:road:0', name: 'Main St' }] };
  const placeParsed = TheBusIntentParser.parseQuery('where is walgreens', indexWithOsm);
  assert.equal(placeParsed.place && placeParsed.place.id, 'osm:node:1');
  const roadParsed = TheBusIntentParser.parseQuery('where is main st', indexWithOsm);
  assert.equal(roadParsed.road && roadParsed.road.id, 'osm:road:0');
});

test('parseQuery: a PLAN_TRIP-classified query with no extractable "from X to Y" shape yields null origin/destination instead of throwing', () => {
  const parsed = TheBusIntentParser.parseQuery('plan my trip', index);
  assert.equal(parsed.intent, 'PLAN_TRIP');
  assert.equal(parsed.origin, null);
  assert.equal(parsed.destination, null);
});
