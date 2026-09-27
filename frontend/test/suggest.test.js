const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('intentParser.js', 'suggest.js');

const DATA = {
  stops: {
    's1': { id: 's1', name: 'Avalon Publix', lat: 28.5, lon: -82.6, routes: [{ shortName: '5' }, { shortName: '9' }] },
    's2': { id: 's2', name: 'Marion Transit Center', lat: 27.9, lon: -82.4, routes: [{ shortName: '1' }] },
  },
  routes: {
    'r5': { id: 'r5', shortName: '5', longName: 'Spring Hill Express' },
  },
  places: {
    'p1': { id: 'p1', name: 'Avalon Park', lat: 28.51, lon: -82.61, category: 'leisure:park', aliases: [] },
  },
  roads: {
    'rd1': { id: 'rd1', name: 'Cortez Boulevard', lat: 28.53, lon: -82.55 },
  },
};

test('ranks an exact stop match first and runs the next-bus query', () => {
  TheBusSuggest.setDataset(DATA);
  const out = TheBusSuggest.suggest('avalon publix');
  assert.equal(out[0].type, 'stop');
  assert.equal(out[0].label, 'Avalon Publix');
  assert.equal(out[0].run, 'WHEN IS THE NEXT BUS AT Avalon Publix');
  assert.match(out[0].hint, /RT 5, 9/);
});

test('prefix matches surface stops and places; a place runs the nearest-stop query', () => {
  TheBusSuggest.setDataset(DATA);
  const out = TheBusSuggest.suggest('avalon');
  const labels = out.map((o) => o.label);
  assert.ok(labels.includes('Avalon Publix'));
  assert.ok(labels.includes('Avalon Park'));
  const park = out.find((o) => o.label === 'Avalon Park');
  assert.equal(park.type, 'place');
  assert.equal(park.run, 'NEAREST STOP TO Avalon Park');
});

test('a route is found by its short name and runs its timetable', () => {
  TheBusSuggest.setDataset(DATA);
  const out = TheBusSuggest.suggest('spring hill');
  const route = out.find((o) => o.type === 'route');
  assert.ok(route, 'route surfaced');
  assert.equal(route.run, 'TIMETABLE FOR ROUTE 5');
});

test('command templates surface (fares runs directly; others fill the box)', () => {
  TheBusSuggest.setDataset(DATA);
  const fares = TheBusSuggest.suggest('fares').find((o) => o.type === 'command');
  assert.ok(fares);
  assert.equal(fares.run, 'FARES');

  const nearest = TheBusSuggest.suggest('nearest').find((o) => o.type === 'command');
  assert.ok(nearest);
  assert.equal(nearest.fill, 'NEAREST STOP TO ');
});

test('empty / whitespace query returns nothing', () => {
  TheBusSuggest.setDataset(DATA);
  assert.deepEqual(TheBusSuggest.suggest('   '), []);
  assert.deepEqual(TheBusSuggest.suggest(''), []);
});
