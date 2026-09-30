const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('tileCache.js');
const tileCache = global.TheBusTileCache;

// Node has no Cache API, so this environment exercises the "unavailable"
// path: the module must degrade to safe no-ops rather than throwing, which
// is exactly how it must behave in a webview without the Cache API too.
test('tileCache reports unavailable and no-ops safely without the Cache API', async () => {
  assert.equal(typeof tileCache.available, 'function');
  assert.equal(tileCache.available(), false);
  // put() must not throw even with a body, and match() resolves to null.
  await assert.doesNotReject(() => tileCache.put('https://x/1/2/3.png', { size: 1 }));
  assert.equal(await tileCache.match('https://x/1/2/3.png'), null);
});

test('tileCache exposes a stable, versioned cache name', () => {
  assert.match(tileCache.CACHE_NAME, /tribus.*tiles/i);
});
