const test = require('node:test');
const assert = require('node:assert/strict');

function freshStaticmapModule() {
  const configPath = require.resolve('../src/config');
  const staticmapPath = require.resolve('../src/staticmap');
  delete require.cache[configPath];
  delete require.cache[staticmapPath];
  return { staticmap: require('../src/staticmap'), config: require('../src/config') };
}

test('returns null (feature disabled) when no API key is configured -- never an error', async () => {
  const originalKey = process.env.GEOAPIFY_API_KEY;
  delete process.env.GEOAPIFY_API_KEY;
  try {
    const { staticmap } = freshStaticmapModule();
    const result = await staticmap.fetchStaticMap(28.5, -82.6);
    assert.equal(result, null);
  } finally {
    if (originalKey === undefined) delete process.env.GEOAPIFY_API_KEY;
    else process.env.GEOAPIFY_API_KEY = originalKey;
  }
});

test('fetches and caches an image when configured -- a second call for the same rounded location never hits fetch again', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  const { staticmap } = freshStaticmapModule();
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
  };
  try {
    const first = await staticmap.fetchStaticMap(28.5, -82.6);
    const second = await staticmap.fetchStaticMap(28.5, -82.6);
    assert.equal(fetchCalls, 1);
    assert.deepEqual(first.buffer, second.buffer);
    assert.equal(first.contentType, 'image/png');
  } finally {
    global.fetch = originalFetch;
    delete process.env.GEOAPIFY_API_KEY;
  }
});

test('a failed upstream request throws, rather than silently caching nothing as if it were configured-off', async () => {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  const { staticmap } = freshStaticmapModule();
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500 });
  try {
    await assert.rejects(() => staticmap.fetchStaticMap(28.5, -82.6));
  } finally {
    global.fetch = originalFetch;
    delete process.env.GEOAPIFY_API_KEY;
  }
});
