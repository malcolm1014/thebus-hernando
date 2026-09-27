const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('localPlaces.js');

const DATASET = {
  stops: {
    'hart:1': { id: 'hart:1', name: 'Marion Transit Center', lat: 27.95, lon: -82.46 },
  },
  places: {
    'osm:node:1': { id: 'osm:node:1', name: 'Avalon Publix', lat: 28.50, lon: -82.60, aliases: ['publix on 50'] },
    'osm:node:2': { id: 'osm:node:2', name: 'Springstead High School', lat: 28.49, lon: -82.58, aliases: [] },
  },
  roads: {
    'osm:road:1': { id: 'osm:road:1', name: 'Cortez Boulevard', lat: 28.53, lon: -82.55 },
  },
};

test('resolves an exact place name to coordinates', () => {
  TheBusLocalPlaces.setDataset(DATASET);
  const r = TheBusLocalPlaces.resolve('avalon publix');
  assert.equal(r.source, 'place');
  assert.equal(r.lat, 28.50);
  assert.equal(r.name, 'Avalon Publix');
});

test('resolves an alias and a stop and a road by exact name', () => {
  TheBusLocalPlaces.setDataset(DATASET);
  assert.equal(TheBusLocalPlaces.resolve('publix on 50').source, 'place');
  assert.equal(TheBusLocalPlaces.resolve('Marion Transit Center').source, 'stop');
  assert.equal(TheBusLocalPlaces.resolve('cortez boulevard').source, 'road');
});

test('resolves a clear prefix (>=4 chars) but not a vague short query', () => {
  TheBusLocalPlaces.setDataset(DATASET);
  const r = TheBusLocalPlaces.resolve('springstead');
  assert.equal(r.name, 'Springstead High School');
  // Too short / vague -> null so it falls through to the online geocoder.
  assert.equal(TheBusLocalPlaces.resolve('sp'), null);
  assert.equal(TheBusLocalPlaces.resolve('tampa'), null); // not in the corpus -> online geocoder handles cities
});

test('returns null when no dataset is set', () => {
  TheBusLocalPlaces.setDataset(null);
  assert.equal(TheBusLocalPlaces.resolve('avalon publix'), null);
});
