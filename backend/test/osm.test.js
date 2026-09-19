const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadOsmExtract } = require('../src/osm');

test('loadOsmExtract: missing files return empty places/roads rather than throwing -- OSM data is optional, exactly like Groq/Geoapify/Grok', () => {
  const result = loadOsmExtract({ placesPath: '/nonexistent/places.json', roadsPath: '/nonexistent/roads.json' });
  assert.deepEqual(result, { places: {}, roads: {} });
});

test('loadOsmExtract: keys the returned dicts by each entry\'s own id, matching stops/routes\' own dict shape', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-test-'));
  const placesPath = path.join(tmpDir, 'places.json');
  const roadsPath = path.join(tmpDir, 'roads.json');
  const places = [{ id: 'osm:node:1', name: 'Publix', category: 'shop:supermarket', lat: 28.5, lon: -82.6, address: null, aliases: [] }];
  const roads = [{ id: 'osm:road:0', name: 'Main St', highway: 'residential', lat: 28.5, lon: -82.6, segments: 1 }];
  fs.writeFileSync(placesPath, JSON.stringify(places));
  fs.writeFileSync(roadsPath, JSON.stringify(roads));

  const result = loadOsmExtract({ placesPath, roadsPath });
  assert.deepEqual(result.places['osm:node:1'], places[0]);
  assert.deepEqual(result.roads['osm:road:0'], roads[0]);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loadOsmExtract: a malformed/truncated JSON file is treated as empty rather than crashing the whole ETL run', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-test-'));
  const placesPath = path.join(tmpDir, 'places.json');
  fs.writeFileSync(placesPath, '{not valid json');

  const result = loadOsmExtract({ placesPath, roadsPath: '/nonexistent/roads.json' });
  assert.deepEqual(result, { places: {}, roads: {} });

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
