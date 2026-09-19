const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('geolocate.js');
TheBusGeolocate.__setTimeoutMsForTesting(50); // real GPS_TIMEOUT_MS is 10s -- these tests exercise the "timeout expires" path deliberately, and shouldn't take 10s each to do it

function fixedPosition(lat, lon, accuracy) {
  return { coords: { latitude: lat, longitude: lon, accuracy } };
}

/** A fake Geolocation plugin whose watchPosition delivers a scripted sequence of fixes, one per `setInterval`-free microtask tick (fast, deterministic -- no real timers). */
function fakeGeolocation({ fixes = [], permission = 'granted' } = {}) {
  let cleared = false;
  return {
    checkPermissions: async () => ({ location: permission }),
    requestPermissions: async () => ({ location: permission }),
    watchPosition: async (options, callback) => {
      // Deliver every scripted fix on its own microtask tick, same shape
      // watchPosition's real repeated-callback behavior has, but without
      // real GPS timing delays -- keeps the test fast and deterministic.
      (async () => {
        for (const fix of fixes) {
          await Promise.resolve();
          if (!cleared) callback(fix, null);
        }
      })();
      return 'watch-1';
    },
    clearWatch: async () => { cleared = true; },
    getCurrentPosition: async () => fixedPosition(28.5, -82.6, 15), // one-shot fallback path
  };
}

function withFakeCapacitor(geolocation, fn) {
  const originalCapacitor = global.Capacitor;
  global.Capacitor = { Plugins: { Geolocation: geolocation } };
  return fn().finally(() => { global.Capacitor = originalCapacitor; });
}

test('getCurrentPosition: returns null when no native Geolocation plugin is present (browser/test env)', async () => {
  const originalCapacitor = global.Capacitor;
  delete global.Capacitor;
  try {
    assert.equal(await TheBusGeolocate.getCurrentPosition(), null);
  } finally {
    global.Capacitor = originalCapacitor;
  }
});

test('getCurrentPosition: returns null when permission is refused', async () => {
  await withFakeCapacitor(fakeGeolocation({ permission: 'denied' }), async () => {
    assert.equal(await TheBusGeolocate.getCurrentPosition(), null);
  });
});

test('getCurrentPosition: GPS refinement keeps the most accurate of several fixes, not just the first one', async () => {
  const fixes = [
    fixedPosition(28.501, -82.601, 80), // first callback: poor accuracy
    fixedPosition(28.500, -82.600, 12), // second: much better -- and under the "good enough" threshold, so it should stop watching here
    fixedPosition(28.509, -82.609, 5), // would never arrive in real life once watchBestFix stops early, but proves the fake harness could deliver a 3rd fix if not stopped
  ];
  await withFakeCapacitor(fakeGeolocation({ fixes }), async () => {
    const result = await TheBusGeolocate.getCurrentPosition();
    assert.deepEqual(result, { lat: 28.500, lon: -82.600 });
  });
});

test('getCurrentPosition: falls back to a one-shot read when watchPosition never delivers a fix', async () => {
  await withFakeCapacitor(fakeGeolocation({ fixes: [] }), async () => {
    const result = await TheBusGeolocate.getCurrentPosition();
    assert.deepEqual(result, { lat: 28.5, lon: -82.6 });
  });
});

test('getCurrentPosition: an error thrown mid-flow resolves to null rather than rejecting', async () => {
  const broken = {
    checkPermissions: async () => { throw new Error('plugin not ready'); },
  };
  await withFakeCapacitor(broken, async () => {
    assert.equal(await TheBusGeolocate.getCurrentPosition(), null);
  });
});

// getLastFailureReason(): a real rider reported being confused by a
// generic "check that location is turned on" message when they'd
// already granted the app's own location permission -- the actual
// problem was the DEVICE's location services toggle, a separate Android
// setting @capacitor/geolocation's own Android source rejects
// checkPermissions()/requestPermissions() for with the literal message
// "Location services are not enabled". These tests lock in that this
// app can tell the two apart, so a caller can finally say which one.

test('getLastFailureReason: "unsupported" when there is no native plugin at all', async () => {
  const originalCapacitor = global.Capacitor;
  delete global.Capacitor;
  try {
    await TheBusGeolocate.getCurrentPosition();
    assert.equal(TheBusGeolocate.getLastFailureReason(), 'unsupported');
  } finally {
    global.Capacitor = originalCapacitor;
  }
});

test('getLastFailureReason: "permission-denied" when the app\'s own permission is refused', async () => {
  await withFakeCapacitor(fakeGeolocation({ permission: 'denied' }), async () => {
    await TheBusGeolocate.getCurrentPosition();
    assert.equal(TheBusGeolocate.getLastFailureReason(), 'permission-denied');
  });
});

test('getLastFailureReason: "services-disabled" -- distinct from "permission-denied" -- when the DEVICE\'s location services are off, matching the exact rejection message the real Android plugin throws for this', async () => {
  const servicesDisabled = {
    checkPermissions: async () => { throw new Error('Location services are not enabled'); },
  };
  await withFakeCapacitor(servicesDisabled, async () => {
    await TheBusGeolocate.getCurrentPosition();
    assert.equal(TheBusGeolocate.getLastFailureReason(), 'services-disabled');
  });
});

test('getLastFailureReason: "no-fix" for a genuine GPS timeout with permission and services both fine', async () => {
  const broken = {
    checkPermissions: async () => ({ location: 'granted' }),
    watchPosition: async () => { throw new Error('timeout'); },
    getCurrentPosition: async () => { throw new Error('timeout'); },
  };
  await withFakeCapacitor(broken, async () => {
    await TheBusGeolocate.getCurrentPosition();
    assert.equal(TheBusGeolocate.getLastFailureReason(), 'no-fix');
  });
});

test('getLastFailureReason: cleared back to null by a subsequent successful call, never stays stuck on a stale failure', async () => {
  await withFakeCapacitor(fakeGeolocation({ permission: 'denied' }), async () => {
    await TheBusGeolocate.getCurrentPosition();
    assert.equal(TheBusGeolocate.getLastFailureReason(), 'permission-denied');
  });
  await withFakeCapacitor(fakeGeolocation({ fixes: [] }), async () => {
    const result = await TheBusGeolocate.getCurrentPosition();
    assert.deepEqual(result, { lat: 28.5, lon: -82.6 });
    assert.equal(TheBusGeolocate.getLastFailureReason(), null);
  });
});
