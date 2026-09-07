const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('sync.js', 'grokEnhance.js');

function withOnline(value, fn) {
  const original = global.navigator.onLine;
  global.navigator.onLine = value;
  return fn().finally(() => { global.navigator.onLine = original; });
}

test('enhance: returns null without ever calling fetch when offline', () => withOnline(false, async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('fetch should never be called while offline'); };
  try {
    const result = await TheBusGrokEnhance.enhance('when is the next bus', 'NEXT ARRIVALS: ROUTE 5 -- 6 MIN');
    assert.equal(result, null);
  } finally {
    global.fetch = originalFetch;
  }
}));

test('enhance: returns the trimmed rephrased text on a successful response', () => withOnline(true, async () => {
  const originalFetch = global.fetch;
  let capturedUrl = null;
  let capturedBody = null;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ enhanced: '  Your bus is 6 minutes out!  ' }) };
  };
  try {
    const result = await TheBusGrokEnhance.enhance('when is the next bus', 'NEXT ARRIVALS: ROUTE 5 -- 6 MIN');
    assert.equal(result, 'Your bus is 6 minutes out!');
    assert.match(capturedUrl, /\/api\/enhance-answer$/);
    assert.deepEqual(capturedBody, { query: 'when is the next bus', factualAnswer: 'NEXT ARRIVALS: ROUTE 5 -- 6 MIN' });
  } finally {
    global.fetch = originalFetch;
  }
}));

test('enhance: returns null when the backend responds with enhanced: null (feature not configured, or the upstream call failed)', () => withOnline(true, async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ enhanced: null }) });
  try {
    assert.equal(await TheBusGrokEnhance.enhance('q', 'a'), null);
  } finally {
    global.fetch = originalFetch;
  }
}));

test('enhance: returns null on a non-ok HTTP response, without throwing', () => withOnline(true, async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500 });
  try {
    assert.equal(await TheBusGrokEnhance.enhance('q', 'a'), null);
  } finally {
    global.fetch = originalFetch;
  }
}));

test('enhance: returns null (never throws) when fetch rejects, e.g. going offline mid-request or a timeout/abort', () => withOnline(true, async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    assert.equal(await TheBusGrokEnhance.enhance('q', 'a'), null);
  } finally {
    global.fetch = originalFetch;
  }
}));
