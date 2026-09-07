/**
 * Thin wrapper around @capacitor/geolocation's device GPS API. Used as a
 * fallback when a query names no stop/landmark at all ("when's the next
 * bus", "nearest stop") so those can still resolve, from the rider's
 * actual current position, instead of requiring an explicit place name
 * every time. Same guarded-access pattern as storage.js (Filesystem/
 * Preferences): reads the plugin off `Capacitor.Plugins`, the same way
 * every other native plugin in this app is reached from plain JS with no
 * bundler. Returns null (never throws) on anything short of an actual
 * fix -- no native bridge (browser/test env), permission refused, GPS
 * timeout -- so callers can fall back to asking for a place name instead
 * of crashing the query.
 *
 * GPS refinement: a single getCurrentPosition() call can return a fix
 * with 50m+ of error on the very first callback, especially indoors or
 * just after the GPS radio wakes up -- easily enough to pick the wrong
 * one of two nearby stops. Rather than a Kalman-style filter (which
 * needs a continuous stream of readings to smooth between -- not what
 * this app has, since GPS is only ever read once per rider query, not
 * continuously tracked), this watches for up to GPS_TIMEOUT_MS and keeps
 * whichever fix reports the SMALLEST accuracy radius, returning early
 * the moment a fix is "good enough" instead of always waiting out the
 * full timeout.
 */
(function (global) {
  let GPS_TIMEOUT_MS = 10000; // overridable ONLY for tests, via __setTimeoutMsForTesting -- so a "no fix ever arrives" test doesn't have to wait out a real 10s timer
  const GOOD_ENOUGH_ACCURACY_METERS = 20; // stop watching early once a fix reports at least this good

  function __setTimeoutMsForTesting(ms) { GPS_TIMEOUT_MS = ms == null ? 10000 : ms; }

  function plugin() {
    return (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.Geolocation) || null;
  }

  /** Watches for up to `timeoutMs`, keeping the best (smallest-accuracy) fix seen; resolves early once one is "good enough". Never rejects -- resolves null if no fix arrives at all. */
  function watchBestFix(Geolocation, timeoutMs) {
    return new Promise((resolve) => {
      let best = null;
      let watchId = null;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (watchId != null) Geolocation.clearWatch({ id: watchId }).catch(() => {});
        resolve(best);
      };

      const timer = setTimeout(finish, timeoutMs);

      Geolocation.watchPosition({ enableHighAccuracy: true, timeout: timeoutMs }, (pos, err) => {
        if (settled || err || !pos) return;
        const accuracy = pos.coords.accuracy;
        if (!best || (accuracy != null && accuracy < best.accuracy)) {
          best = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: accuracy != null ? accuracy : null };
        }
        if (accuracy != null && accuracy <= GOOD_ENOUGH_ACCURACY_METERS) {
          clearTimeout(timer);
          finish();
        }
      }).then((id) => { watchId = id; }).catch(() => {}); // a watch that fails to even start just means watchBestFix times out with whatever (nothing) it has -- getCurrentPosition() below still returns null in that case
    });
  }

  async function getCurrentPosition() {
    const Geolocation = plugin();
    if (!Geolocation) return null;

    try {
      const status = await Geolocation.checkPermissions();
      let granted = status.location === 'granted' || status.coarseLocation === 'granted';
      if (!granted) {
        const requested = await Geolocation.requestPermissions();
        granted = requested.location === 'granted' || requested.coarseLocation === 'granted';
      }
      if (!granted) return null;

      const best = await watchBestFix(Geolocation, GPS_TIMEOUT_MS);
      if (best) return { lat: best.lat, lon: best.lon };

      // watchPosition never delivered anything (some devices/emulators
      // don't implement it reliably) -- fall back to a single one-shot
      // read rather than reporting "no GPS" when one might still work.
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS });
      return { lat: pos.coords.latitude, lon: pos.coords.longitude };
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  global.TheBusGeolocate = { getCurrentPosition, __setTimeoutMsForTesting };
})(window);
