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

// Real bug hit indoors on a real device: a high-accuracy GPS request
// consistently failed to get any fix at all indoors, even though
// @capacitor/geolocation runs on Google's Fused Location Provider,
// which CAN resolve an approximate fix indoors via WiFi/cell -- but
// only when asked for balanced accuracy instead of GPS-grade accuracy.
test('getCurrentPosition: when watchPosition times out, tries a BALANCED-accuracy one-shot before the high-accuracy one-shot -- a coarser WiFi/cell fix indoors beats no fix at all', async () => {
  const requestedAccuracy = [];
  const fake = {
    checkPermissions: async () => ({ location: 'granted' }),
    watchPosition: async () => { throw new Error('no fix'); }, // caught silently inside watchBestFix itself
    getCurrentPosition: async (opts) => {
      requestedAccuracy.push(opts.enableHighAccuracy);
      if (opts.enableHighAccuracy === false) return fixedPosition(28.55, -82.65, 800); // coarse WiFi/cell fix -- exactly what's available indoors
      throw new Error('no GPS fix available'); // a real high-accuracy request genuinely fails indoors
    },
  };
  await withFakeCapacitor(fake, async () => {
    const result = await TheBusGeolocate.getCurrentPosition();
    assert.deepEqual(result, { lat: 28.55, lon: -82.65 });
    // Resolved on the low-accuracy attempt -- the high-accuracy one-shot fallback was never even reached.
    assert.deepEqual(requestedAccuracy, [false]);
  });
});

test('getCurrentPosition: if the balanced-accuracy fallback ALSO fails, still tries the original high-accuracy one-shot as a last resort rather than giving up early', async () => {
  const requestedAccuracy = [];
  const fake = {
    checkPermissions: async () => ({ location: 'granted' }),
    watchPosition: async () => { throw new Error('no fix'); },
    getCurrentPosition: async (opts) => {
      requestedAccuracy.push(opts.enableHighAccuracy);
      if (opts.enableHighAccuracy === false) throw new Error('no network/WiFi fix available either');
      return fixedPosition(28.5, -82.6, 15);
    },
  };
  await withFakeCapacitor(fake, async () => {
    const result = await TheBusGeolocate.getCurrentPosition();
    assert.deepEqual(result, { lat: 28.5, lon: -82.6 });
    assert.deepEqual(requestedAccuracy, [false, true]);
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

// getLastFailureDetail(): a real rider hit "couldn't get your location"
// indoors in a spot where another app (Google Maps) found their
// location fine -- meaning the failure is a genuine bug in how this app
// requests a fix, not a real signal problem, and only the actual native
// error text can diagnose it further. Surfacing it directly in the
// app's own answer (see queryEngine.js's locationFailureMessage) means
// a rider can relay it back with no remote-debugging setup needed.

test('getLastFailureDetail: null when there has been no failure at all (or none yet)', async () => {
  await withFakeCapacitor(fakeGeolocation({ fixes: [] }), async () => {
    await TheBusGeolocate.getCurrentPosition();
    assert.equal(TheBusGeolocate.getLastFailureDetail(), null);
  });
});

test('getLastFailureDetail: captures the real error text when only the high-accuracy last resort fails (balanced-accuracy attempt succeeded, so it never even ran)', async () => {
  const fake = {
    checkPermissions: async () => ({ location: 'granted' }),
    watchPosition: async () => { throw new Error('no fix'); },
    getCurrentPosition: async (opts) => {
      if (opts.enableHighAccuracy === false) return fixedPosition(28.55, -82.65, 800);
      throw new Error('should not be reached');
    },
  };
  await withFakeCapacitor(fake, async () => {
    const result = await TheBusGeolocate.getCurrentPosition();
    assert.deepEqual(result, { lat: 28.55, lon: -82.65 });
    assert.equal(TheBusGeolocate.getLastFailureDetail(), null); // no failure at all -- succeeded on the balanced-accuracy attempt
  });
});

test('getLastFailureDetail: captures BOTH the balanced-accuracy and high-accuracy attempts\' real error text when both fail, so neither clue is lost', async () => {
  const fake = {
    checkPermissions: async () => ({ location: 'granted' }),
    watchPosition: async () => { throw new Error('no fix'); },
    getCurrentPosition: async (opts) => {
      if (opts.enableHighAccuracy === false) throw new Error('PERMISSION_DENIED: fine location required');
      throw new Error('TIMEOUT: no fix within deadline');
    },
  };
  await withFakeCapacitor(fake, async () => {
    await TheBusGeolocate.getCurrentPosition();
    const detail = TheBusGeolocate.getLastFailureDetail();
    assert.match(detail, /balanced-accuracy attempt: PERMISSION_DENIED: fine location required/);
    assert.match(detail, /high-accuracy attempt: TIMEOUT: no fix within deadline/);
  });
});

test('getLastFailureDetail: cleared back to null by a subsequent successful call', async () => {
  const broken = {
    checkPermissions: async () => ({ location: 'granted' }),
    watchPosition: async () => { throw new Error('no fix'); },
    getCurrentPosition: async () => { throw new Error('genuinely no fix available'); },
  };
  await withFakeCapacitor(broken, async () => {
    await TheBusGeolocate.getCurrentPosition();
    assert.notEqual(TheBusGeolocate.getLastFailureDetail(), null);
  });
  await withFakeCapacitor(fakeGeolocation({ fixes: [] }), async () => {
    await TheBusGeolocate.getCurrentPosition();
    assert.equal(TheBusGeolocate.getLastFailureDetail(), null);
  });
});
