const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('offlineMap.js');
const om = global.TheBusOfflineMap;

test('lonToTileX / latToTileY match the standard slippy-map formulas', () => {
  // Tampa-ish point at z12; known-good reference values from the OSM wiki formula.
  assert.equal(om.lonToTileX(-82.46, 12), 1109);
  assert.equal(om.latToTileY(27.95, 12), 1716);
});

test('tilesForBounds covers the box at every zoom, growing ~4x per level', () => {
  const bbox = { minLat: 28.0, maxLat: 28.1, minLon: -82.5, maxLon: -82.4 };
  const z10 = om.tilesForBounds(bbox, 10, 10).length;
  const z12 = om.tilesForBounds(bbox, 12, 12).length;
  assert.ok(z10 >= 1);
  assert.ok(z12 > z10, 'a higher zoom must need at least as many tiles');
  // A combined range returns the union of each level.
  const combined = om.tilesForBounds(bbox, 10, 12).length;
  assert.equal(combined, z10 + om.tilesForBounds(bbox, 11, 11).length + z12);
  // Every entry is a valid, in-range tile coordinate.
  for (const t of om.tilesForBounds(bbox, 10, 12)) {
    const max = Math.pow(2, t.z) - 1;
    assert.ok(t.x >= 0 && t.x <= max && t.y >= 0 && t.y <= max);
  }
});

test('boundsFromDataset spans all stops, padded, and is null when there are none', () => {
  const dataset = {
    stops: {
      a: { lat: 28.0, lon: -82.5 },
      b: { lat: 28.4, lon: -82.1 },
      c: { lat: null, lon: null }, // ignored
    },
  };
  const b = om.boundsFromDataset(dataset, 0.02);
  assert.ok(Math.abs(b.minLat - 27.98) < 1e-9);
  assert.ok(Math.abs(b.maxLat - 28.42) < 1e-9);
  assert.ok(Math.abs(b.minLon - -82.52) < 1e-9);
  assert.ok(Math.abs(b.maxLon - -82.08) < 1e-9);
  assert.equal(om.boundsFromDataset({ stops: {} }), null);
});

test('downloadRegion fetches each tile, caches the ok ones, and reports progress', async () => {
  const originalFetch = global.fetch;
  const prevCache = global.TheBusTileCache;
  const stored = [];
  global.TheBusTileCache = { put: async (url) => { stored.push(url); }, available: () => true };
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    // Fail one tile to prove it's skipped, not fatal.
    if (String(url).includes('/2/')) return { ok: false, status: 500 };
    return { ok: true, blob: async () => ({ size: 10 }) };
  };
  try {
    const tiles = [{ z: 10, x: 1, y: 1 }, { z: 10, x: 2, y: 1 }, { z: 10, x: 3, y: 1 }];
    const res = await om.downloadRegion({ apiBase: 'https://b', tiles, concurrency: 2 });
    assert.equal(res.ok, true);
    assert.equal(res.total, 3);
    assert.equal(res.cached, 2);   // the /2/ tile failed
    assert.equal(calls, 3);
    assert.equal(stored.length, 2);
  } finally {
    global.fetch = originalFetch;
    global.TheBusTileCache = prevCache;
  }
});
