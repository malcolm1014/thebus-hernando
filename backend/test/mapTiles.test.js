const test = require('node:test');
const assert = require('node:assert/strict');

function freshModule(env = {}) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/mapTiles')];
  const mod = require('../src/mapTiles');
  return {
    mod,
    restore() {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

test('isValidTileCoord accepts real slippy coords and rejects junk', () => {
  const { mod, restore } = freshModule();
  try {
    assert.equal(mod.isValidTileCoord(0, 0, 0), true);
    assert.equal(mod.isValidTileCoord(12, 1100, 1600), true);
    assert.equal(mod.isValidTileCoord(19, 0, 0), true);
    assert.equal(mod.isValidTileCoord(-1, 0, 0), false); // negative zoom
    assert.equal(mod.isValidTileCoord(21, 0, 0), false); // beyond max zoom
    assert.equal(mod.isValidTileCoord(1, 2, 0), false);  // x out of range (max 2 at z=1)
    assert.equal(mod.isValidTileCoord(2, 1.5, 0), false); // non-integer
  } finally { restore(); }
});

test('fetchTile returns null (no request) when GEOAPIFY_API_KEY is unset', async () => {
  const original = global.fetch;
  const { mod, restore } = freshModule({ GEOAPIFY_API_KEY: undefined });
  let called = false;
  global.fetch = async () => { called = true; return { ok: true }; };
  try {
    const tile = await mod.fetchTile(12, 1100, 1600);
    assert.equal(tile, null);
    assert.equal(called, false);
  } finally {
    global.fetch = original;
    restore();
  }
});

test('fetchTile fetches from Geoapify with the key + style, and caches the second call', async () => {
  const original = global.fetch;
  const { mod, restore } = freshModule({ GEOAPIFY_API_KEY: 'test-key', MAP_TILE_STYLE: 'osm-carto' });
  let calls = 0;
  let sawUrl = null;
  global.fetch = async (url) => {
    calls += 1;
    sawUrl = String(url);
    return {
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      headers: { get: () => 'image/png' },
    };
  };
  try {
    const a = await mod.fetchTile(12, 1100, 1600);
    assert.ok(Buffer.isBuffer(a.buffer));
    assert.equal(a.contentType, 'image/png');
    assert.match(sawUrl, /maps\.geoapify\.com\/v1\/tile\/osm-carto\/12\/1100\/1600\.png\?apiKey=test-key$/);
    // Second call for the same tile is served from cache -- no new request.
    const b = await mod.fetchTile(12, 1100, 1600);
    assert.equal(b.buffer, a.buffer);
    assert.equal(calls, 1);
  } finally {
    global.fetch = original;
    restore();
  }
});

test('fetchTile throws on an invalid coordinate rather than requesting it', async () => {
  const original = global.fetch;
  const { mod, restore } = freshModule({ GEOAPIFY_API_KEY: 'k' });
  let called = false;
  global.fetch = async () => { called = true; return { ok: true }; };
  try {
    await assert.rejects(() => mod.fetchTile(1, 5, 0), /invalid tile coordinate/);
    assert.equal(called, false);
  } finally {
    global.fetch = original;
    restore();
  }
});

test('fetchTile throws on an upstream non-2xx', async () => {
  const original = global.fetch;
  const { mod, restore } = freshModule({ GEOAPIFY_API_KEY: 'k' });
  global.fetch = async () => ({ ok: false, status: 429 });
  try {
    await assert.rejects(() => mod.fetchTile(12, 1100, 1600), /HTTP 429/);
  } finally {
    global.fetch = original;
    restore();
  }
});
