const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');
const { enrichAliases, buildPrompt, cacheKey } = require('../src/enrich');

function buildStop(overrides = {}) {
  return {
    id: 'S1',
    name: 'Walmart US19 Spring Hill',
    lat: 28.55,
    lon: -82.63,
    routes: [{ routeId: 'R1', shortName: '', longName: 'Route 1 Red' }],
    ...overrides,
  };
}

function withTempCache(fn) {
  const tmpPath = path.join(os.tmpdir(), `alias-cache-test-${Date.now()}-${Math.random()}.json`);
  const originalKey = config.geminiApiKey;
  const originalCachePath = config.aliasCachePath;
  config.aliasCachePath = tmpPath;
  return fn().finally(() => {
    config.geminiApiKey = originalKey;
    config.aliasCachePath = originalCachePath;
    fs.rmSync(tmpPath, { force: true });
  });
}

test('enrichAliases: with no API key configured, every stop gets aliases: [] and no network call is made', () => withTempCache(async () => {
  config.geminiApiKey = undefined;
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('fetch should never be called with no API key'); };

  try {
    const data = { stops: { S1: buildStop() } };
    await enrichAliases(data);
    assert.deepEqual(data.stops.S1.aliases, []);
  } finally {
    global.fetch = originalFetch;
  }
}));

test('enrichAliases: a successful Gemini response populates aliases, lowercased and trimmed', () => withTempCache(async () => {
  config.geminiApiKey = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: '["Walmart on 19 ", "walmart spring hill"]' }] } }],
    }),
  });

  try {
    const data = { stops: { S1: buildStop() } };
    await enrichAliases(data);
    assert.deepEqual(data.stops.S1.aliases, ['walmart on 19', 'walmart spring hill']);
  } finally {
    global.fetch = originalFetch;
  }
}));

test('enrichAliases: a cached entry is reused without calling the API again, even across a fresh call', () => withTempCache(async () => {
  config.geminiApiKey = 'test-key';
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount += 1;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '["walmart on 19"]' }] } }] }) };
  };

  try {
    const data1 = { stops: { S1: buildStop() } };
    await enrichAliases(data1);
    assert.equal(callCount, 1);

    // Same stop name + same served routes -- must hit the cache, not the API.
    const data2 = { stops: { S1: buildStop() } };
    await enrichAliases(data2);
    assert.equal(callCount, 1);
    assert.deepEqual(data2.stops.S1.aliases, ['walmart on 19']);
  } finally {
    global.fetch = originalFetch;
  }
}));

test('enrichAliases: a route change invalidates the cache for that stop (real schedule changes must never ship stale aliases)', () => withTempCache(async () => {
  config.geminiApiKey = 'test-key';
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount += 1;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '["walmart on 19"]' }] } }] }) };
  };

  try {
    await enrichAliases({ stops: { S1: buildStop() } });
    assert.equal(callCount, 1);

    const changedRoutes = buildStop({ routes: [{ routeId: 'R2', shortName: '', longName: 'Blue' }] });
    await enrichAliases({ stops: { S1: changedRoutes } });
    assert.equal(callCount, 2);
  } finally {
    global.fetch = originalFetch;
  }
}));

test('enrichAliases: an HTTP failure for one stop leaves it with aliases: [] instead of throwing and blocking the whole ETL run', () => withTempCache(async () => {
  config.geminiApiKey = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 429 });

  try {
    const data = { stops: { S1: buildStop() } };
    await enrichAliases(data);
    assert.deepEqual(data.stops.S1.aliases, []);
  } finally {
    global.fetch = originalFetch;
  }
}));

test('enrichAliases: a malformed (non-JSON) response leaves the stop with aliases: [] instead of throwing', () => withTempCache(async () => {
  config.geminiApiKey = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'not valid json' }] } }] }),
  });

  try {
    const data = { stops: { S1: buildStop() } };
    await enrichAliases(data);
    assert.deepEqual(data.stops.S1.aliases, []);
  } finally {
    global.fetch = originalFetch;
  }
}));

test('buildPrompt: grounds the model in the stop\'s own name/routes and explicitly forbids inventing unrelated landmarks', () => {
  const prompt = buildPrompt(buildStop());
  assert.match(prompt, /Walmart US19 Spring Hill/);
  assert.match(prompt, /Route 1 Red/);
  assert.match(prompt, /do not invent/i);
});

test('cacheKey: differs when a stop\'s served routes change, but is stable when nothing changes', () => {
  const stop = buildStop();
  const sameStop = buildStop();
  const differentRoutes = buildStop({ routes: [{ routeId: 'R2', shortName: '', longName: 'Blue' }] });
  assert.equal(cacheKey(stop), cacheKey(sameStop));
  assert.notEqual(cacheKey(stop), cacheKey(differentRoutes));
});
