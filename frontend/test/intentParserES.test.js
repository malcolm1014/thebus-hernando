const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules, buildMockDataset } = require('./helpers');

loadModules('intentParser.js');

function buildIndex(dataset) {
  return {
    routes: Object.values(dataset.routes).map((r) => ({ id: r.id, shortName: r.shortName, longName: r.longName })),
    stops: Object.values(dataset.stops).map((s) => ({ id: s.id, name: s.name })),
    places: [],
    roads: [],
  };
}
const index = buildIndex(buildMockDataset());

// Spanish speakers type Spanish. The parser's cue table and endpoint/
// destination extractors learned Spanish connectors; entity names still
// fuzzy-match regardless of language, so only classification + connectors
// are exercised here. English classification is covered by intentParser.test.js
// and must stay unaffected (Spanish keywords don't appear in English queries).

test('classifyIntent: Spanish triggers land on the right intent', () => {
  assert.equal(TheBusIntentParser.classifyIntent('próximo autobús en Avalon Publix'), 'FIND_NEXT_ARRIVAL');
  assert.equal(TheBusIntentParser.classifyIntent('¿a qué hora llega el bus a Publix?'), 'FIND_NEXT_ARRIVAL');
  assert.equal(TheBusIntentParser.classifyIntent('¿dónde está Publix?'), 'FIND_STOP_LOCATION');
  assert.equal(TheBusIntentParser.classifyIntent('paradas de la ruta 10'), 'LIST_ROUTE_STOPS');
  assert.equal(TheBusIntentParser.classifyIntent('parada más cercana a la escuela'), 'FIND_NEAREST_STOP');
  assert.equal(TheBusIntentParser.classifyIntent('primer autobús en Publix'), 'FIND_FIRST_LAST_BUS');
  assert.equal(TheBusIntentParser.classifyIntent('último autobús en Publix'), 'FIND_FIRST_LAST_BUS');
  assert.equal(TheBusIntentParser.classifyIntent('horario completo de la ruta 7'), 'SHOW_TIMETABLE');
  assert.equal(TheBusIntentParser.classifyIntent('cómo llego a pie a Publix'), 'FIND_WALKING_DIRECTIONS');
  assert.equal(TheBusIntentParser.classifyIntent('desde Publix hasta la escuela'), 'PLAN_TRIP');
});

test('parseQuery: Spanish "desde X hasta Y" fills trip endpoints', () => {
  const parsed = TheBusIntentParser.parseQuery('cómo llego desde Avalon Publix hasta la escuela', index);
  assert.equal(parsed.intent, 'PLAN_TRIP');
  assert.ok(parsed.origin && /publix/i.test(parsed.origin), `origin was ${parsed.origin}`);
  assert.ok(parsed.destination && /escuela/i.test(parsed.destination), `destination was ${parsed.destination}`);
});

test('parseQuery: Spanish "de X a Y" also fills trip endpoints', () => {
  const parsed = TheBusIntentParser.parseQuery('viaje de Publix a la escuela', index);
  assert.equal(parsed.intent, 'PLAN_TRIP');
  assert.ok(parsed.origin && /publix/i.test(parsed.origin), `origin was ${parsed.origin}`);
  assert.ok(parsed.destination && /escuela/i.test(parsed.destination), `destination was ${parsed.destination}`);
});

test('parseQuery: Spanish walking destination is extracted', () => {
  const parsed = TheBusIntentParser.parseQuery('cómo camino a pie a la escuela', index);
  assert.equal(parsed.intent, 'FIND_WALKING_DIRECTIONS');
  assert.ok(parsed.walkingDestination && /escuela/i.test(parsed.walkingDestination),
    `walkingDestination was ${parsed.walkingDestination}`);
});

test('parseQuery: Spanish first/last direction is detected', () => {
  const first = TheBusIntentParser.parseQuery('primer autobús en Publix', index);
  assert.equal(first.intent, 'FIND_FIRST_LAST_BUS');
  assert.equal(first.firstOrLast, 'first');

  const last = TheBusIntentParser.parseQuery('último autobús en Publix', index);
  assert.equal(last.intent, 'FIND_FIRST_LAST_BUS');
  assert.equal(last.firstOrLast, 'last');
});
