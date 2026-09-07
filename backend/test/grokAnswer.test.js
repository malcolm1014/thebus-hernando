const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { enhanceAnswer } = require('../src/grokAnswer');

function withXaiKey(key, fn) {
  const original = config.xaiApiKey;
  config.xaiApiKey = key;
  return fn().finally(() => { config.xaiApiKey = original; });
}

function xaiResponse(content) {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
}

test('enhanceAnswer: returns null immediately with no API key configured, and never calls fetch', () => withXaiKey(undefined, async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('fetch should never be called with no API key'); };
  try {
    const result = await enhanceAnswer('when is the next bus', 'NEXT ARRIVALS AT MAIN ST: ROUTE 5 -- 6 MIN');
    assert.equal(result, null);
  } finally {
    global.fetch = originalFetch;
  }
}));

test('enhanceAnswer: returns null when query or factualAnswer is missing/empty', () => withXaiKey('fake-key', async () => {
  assert.equal(await enhanceAnswer('', 'some answer'), null);
  assert.equal(await enhanceAnswer('some query', ''), null);
  assert.equal(await enhanceAnswer(null, 'some answer'), null);
}));

test('enhanceAnswer: returns the rephrased text on a successful response', () => withXaiKey('fake-key', async () => {
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return xaiResponse('  Your next Route 5 bus is just 6 minutes away!  ');
  };
  try {
    const result = await enhanceAnswer('when is the next bus', 'NEXT ARRIVALS: ROUTE 5 -- 6 MIN');
    assert.equal(result, 'Your next Route 5 bus is just 6 minutes away!'); // trimmed
    assert.equal(capturedBody.messages[0].content.includes('NEXT ARRIVALS: ROUTE 5 -- 6 MIN'), true);
    assert.equal(capturedBody.messages[0].content.includes('when is the next bus'), true);
  } finally {
    global.fetch = originalFetch;
  }
}));

test('enhanceAnswer: returns null on a non-ok HTTP response, without throwing', () => withXaiKey('fake-key', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401 });
  try {
    const result = await enhanceAnswer('when is the next bus', 'NEXT ARRIVALS: ROUTE 5 -- 6 MIN');
    assert.equal(result, null);
  } finally {
    global.fetch = originalFetch;
  }
}));

test('enhanceAnswer: returns null when the response has no usable message content', () => withXaiKey('fake-key', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [] }) });
  try {
    assert.equal(await enhanceAnswer('when is the next bus', 'NEXT ARRIVALS: ROUTE 5 -- 6 MIN'), null);
  } finally {
    global.fetch = originalFetch;
  }
}));

test('enhanceAnswer: returns null (never throws) when fetch itself rejects, e.g. a network failure or abort', () => withXaiKey('fake-key', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const result = await enhanceAnswer('when is the next bus', 'NEXT ARRIVALS: ROUTE 5 -- 6 MIN');
    assert.equal(result, null);
  } finally {
    global.fetch = originalFetch;
  }
}));
