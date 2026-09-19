const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

/**
 * valhallaTiles.js captures Capacitor.Plugins.* into module-level
 * consts AT LOAD TIME (same pattern storage.js already uses), so each
 * scenario below sets global.Capacitor BEFORE calling loadModules()
 * again -- loadModules() re-evals the file fresh every call, letting
 * one test file exercise several different plugin-presence scenarios.
 */
function withCapacitor(capacitor, fn) {
  const original = global.Capacitor;
  const originalFilesystemDir = global.CapacitorFilesystem;
  global.Capacitor = capacitor;
  return Promise.resolve()
    .then(() => {
      loadModules('valhallaTiles.js');
      return fn();
    })
    .finally(() => {
      global.Capacitor = original;
      global.CapacitorFilesystem = originalFilesystemDir;
    });
}

test('isSupported/isDownloaded: false outside the Android app (no ValhallaRouting plugin) -- never throws', async () => {
  const original = global.Capacitor;
  delete global.Capacitor;
  try {
    loadModules('valhallaTiles.js');
    assert.equal(TheBusValhallaTiles.isSupported(), false);
    assert.equal(await TheBusValhallaTiles.isDownloaded(), false);
  } finally {
    global.Capacitor = original;
  }
});

test('isSupported: true when the native plugin is present', async () => {
  await withCapacitor({ Plugins: { ValhallaRouting: { tilesAvailable: async () => ({ available: false }) } } }, () => {
    assert.equal(TheBusValhallaTiles.isSupported(), true);
  });
});

test('isDownloaded: reflects the native plugin\'s own tilesAvailable() check exactly -- it\'s the only source of truth for the path this module writes to', async () => {
  await withCapacitor({ Plugins: { ValhallaRouting: { tilesAvailable: async () => ({ available: true }) } } }, async () => {
    assert.equal(await TheBusValhallaTiles.isDownloaded(), true);
  });
});

test('isDownloaded: a native error is treated as "not downloaded" rather than throwing', async () => {
  await withCapacitor({ Plugins: { ValhallaRouting: { tilesAvailable: async () => { throw new Error('native error'); } } } }, async () => {
    assert.equal(await TheBusValhallaTiles.isDownloaded(), false);
  });
});

test('download: reports unsupported outside the Android app instead of throwing', async () => {
  const original = global.Capacitor;
  delete global.Capacitor;
  try {
    loadModules('valhallaTiles.js');
    const result = await TheBusValhallaTiles.download();
    assert.equal(result.ok, false);
    assert.match(result.error, /NOT SUPPORTED/);
  } finally {
    global.Capacitor = original;
  }
});

test('download: a successful native download reports ok:true, using Directory.Data and the exact path the native plugin reads from', async () => {
  let calledWith = null;
  await withCapacitor({
    Plugins: {
      ValhallaRouting: { tilesAvailable: async () => ({ available: false }) },
      Filesystem: {
        downloadFile: async (opts) => { calledWith = opts; },
        addListener: async () => ({ remove: async () => {} }),
      },
    },
  }, async () => {
    const result = await TheBusValhallaTiles.download();
    assert.equal(result.ok, true);
    assert.equal(calledWith.path, 'valhalla/tiles.tar');
    assert.equal(calledWith.url, TheBusValhallaTiles.TILES_URL);
  });
});

test('download: a failed native download reports ok:false with the real error message, and still removes its progress listener', async () => {
  let listenerRemoved = false;
  await withCapacitor({
    Plugins: {
      ValhallaRouting: { tilesAvailable: async () => ({ available: false }) },
      Filesystem: {
        downloadFile: async () => { throw new Error('disk full'); },
        addListener: async () => ({ remove: async () => { listenerRemoved = true; } }),
      },
    },
  }, async () => {
    const result = await TheBusValhallaTiles.download(() => {});
    assert.equal(result.ok, false);
    assert.match(result.error, /disk full/);
    assert.equal(listenerRemoved, true);
  });
});

test('download: progress callback receives a 0-100 percent derived from the native progress event\'s bytes/contentLength', async () => {
  const percents = [];
  let progressHandler = null;
  await withCapacitor({
    Plugins: {
      ValhallaRouting: { tilesAvailable: async () => ({ available: false }) },
      Filesystem: {
        downloadFile: async () => {
          // Simulate two progress events arriving mid-download before the download itself resolves.
          progressHandler({ bytes: 50, contentLength: 200 });
          progressHandler({ bytes: 200, contentLength: 200 });
        },
        addListener: async (eventName, handler) => {
          assert.equal(eventName, 'progress');
          progressHandler = handler;
          return { remove: async () => {} };
        },
      },
    },
  }, async () => {
    await TheBusValhallaTiles.download((pct) => percents.push(pct));
    assert.deepEqual(percents, [25, 100]);
  });
});
