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

test('fuzzyMatch: Jaro-Winkler pass aggregates across ALL matched words, not just the single best word-pair (regression guard for a real bug found during development -- a typo\'d query used to match a wrong candidate via one incidental shared word)', () => {
  const candidates = [
    { id: 'TARGET', name: 'Lakewood Plaza by Publix' },
    { id: 'DECOY', name: 'Briarwood Plaza North West' }, // shares only "Plaza"-ish with the typo'd query
  ];
  const result = TheBusIntentParser.fuzzyMatch('lakewud plaz by publiks', candidates);
  assert.equal(result.id, 'TARGET');
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
