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
 * of crashing the query. See getLastFailureReason() for WHY the most
 * recent call returned null, when a caller wants to say something more
 * specific than "couldn't get your location."
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
  const LOW_ACCURACY_TIMEOUT_MS = 8000; // the balanced-accuracy indoor fallback below -- shorter than GPS_TIMEOUT_MS since a WiFi/cell-based fix either comes back quickly or not at all, no point waiting as long as a GPS-grade fix deserves

  function __setTimeoutMsForTesting(ms) { GPS_TIMEOUT_MS = ms == null ? 10000 : ms; }

  function plugin() {
    return (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.Geolocation) || null;
  }

  /**
   * WHY the most recent getCurrentPosition() call returned null:
   *   'unsupported'        -- no native Geolocation plugin at all (browser/test env)
   *   'permission-denied'  -- the app's own location permission was refused
   *   'services-disabled'  -- the DEVICE's location services are off entirely --
   *                           a real, confirmed distinct case: @capacitor/geolocation's
   *                           own Android source rejects checkPermissions()/
   *                           requestPermissions() with the literal message
   *                           "Location services are not enabled" in this situation,
   *                           which is NOT the same setting as the app's own permission
   *                           grant (Android exposes these as two separate toggles,
   *                           and a rider can easily have granted the app permission
   *                           while the device-wide location toggle is still off) --
   *                           confirmed by reading the plugin's actual Java source
   *                           after a real rider reported exactly this confusion.
   *   'no-fix'              -- permission + services are both fine, but no GPS fix
   *                           arrived in time (weak signal, indoors, etc.)
   *   null                  -- no failure on record yet, or the last call succeeded
   */
  let lastFailureReason = null;
  function getLastFailureReason() { return lastFailureReason; }

  /**
   * The raw native error text behind the most recent 'no-fix' (or any
   * otherwise-unexplained) failure -- surfaced all the way up into the
   * rider-facing answer for exactly this reason (see queryEngine.js's
   * locationFailureMessage()): a real rider hit "couldn't get your
   * location" even indoors where another app (Google Maps) found their
   * location fine, which means whatever's actually failing is a bug in
   * how this app asks for a fix, not a real signal problem -- and
   * that's only diagnosable with the ACTUAL underlying error text, not
   * another guess. Showing it in the app itself means a rider can just
   * relay it back verbatim, no remote-debugging tools required.
   */
  let lastFailureDetail = null;
  function getLastFailureDetail() { return lastFailureDetail; }

  function errorText(err) {
    if (!err) return 'unknown error';
    if (typeof err.message === 'string' && err.message) return err.message;
    try { return JSON.stringify(err); } catch { return String(err); }
  }

  function isServicesDisabledError(err) {
    return !!(err && typeof err.message === 'string' && /location services (are )?not enabled/i.test(err.message));
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
        if (watchId != null) Promise.resolve(Geolocation.clearWatch({ id: watchId })).catch(() => {});
        resolve(best);
      };

      const timer = setTimeout(finish, timeoutMs);

      const watchCall = Geolocation.watchPosition({ enableHighAccuracy: true, timeout: timeoutMs }, (pos, err) => {
        if (settled || err || !pos) return;
        const accuracy = pos.coords.accuracy;
        if (!best || (accuracy != null && accuracy < best.accuracy)) {
          best = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: accuracy != null ? accuracy : null };
        }
        if (accuracy != null && accuracy <= GOOD_ENOUGH_ACCURACY_METERS) {
          clearTimeout(timer);
          finish();
        }
      });
      // Real bug hit on a real device: "high-accuracy attempt:
      // Geolocation.watchPosition(...).then is not a function" -- unlike
      // every other Geolocation call in this file (always `await`ed,
      // which tolerates a non-promise return value), this is the one spot
      // that has to chain .then()/.catch() directly, since it needs the
      // watch ID without blocking. watchPosition's return value isn't
      // reliably a genuine thenable on every Capacitor/Android build, so
      // wrap it in Promise.resolve() to make chaining safe regardless of
      // what it actually handed back.
      Promise.resolve(watchCall).then((id) => { watchId = id; }).catch(() => {}); // a watch that fails to even start just means watchBestFix times out with whatever (nothing) it has -- getCurrentPosition() below still returns null in that case
    });
  }

  async function getCurrentPosition() {
    lastFailureReason = null;
    lastFailureDetail = null;
    const Geolocation = plugin();
    if (!Geolocation) {
      lastFailureReason = 'unsupported';
      return null;
    }

    try {
      const status = await Geolocation.checkPermissions();
      let granted = status.location === 'granted' || status.coarseLocation === 'granted';
      if (!granted) {
        const requested = await Geolocation.requestPermissions();
        granted = requested.location === 'granted' || requested.coarseLocation === 'granted';
      }
      if (!granted) {
        lastFailureReason = 'permission-denied';
        return null;
      }

      const best = await watchBestFix(Geolocation, GPS_TIMEOUT_MS);
      if (best) return { lat: best.lat, lon: best.lon };

      // Real bug hit indoors on a real device: @capacitor/geolocation's
      // Android implementation runs on Google's Fused Location Provider
      // (confirmed by reading its actual Java source), which CAN return
      // an approximate fix indoors via WiFi/cell triangulation -- but
      // only when asked for it. enableHighAccuracy:true (used above and
      // by every other call in this app) tells Fused to hold out for a
      // GPS-grade fix, which usually means waiting on satellite
      // visibility that simply isn't there indoors, until it times out
      // with nothing. Before giving up, try once more asking for
      // BALANCED accuracy instead -- Fused will settle for a coarser
      // WiFi/cell-based fix, typically available indoors in a couple of
      // seconds. Plenty good enough for "nearest stop"/"nearest place"/
      // walking directions, none of which need sub-10m precision.
      try {
        const lowAccuracyPos = await Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: LOW_ACCURACY_TIMEOUT_MS });
        return { lat: lowAccuracyPos.coords.latitude, lon: lowAccuracyPos.coords.longitude };
      } catch (lowAccuracyErr) {
        // Not the real failure yet -- fall through to the last resort
        // below. Keep this error's text though: if the final attempt
        // ALSO fails, both are worth showing -- the balanced-accuracy
        // one is often the more informative of the two.
        lastFailureDetail = `balanced-accuracy attempt: ${errorText(lowAccuracyErr)}`;
      }

      // watchPosition never delivered anything (some devices/emulators
      // don't implement it reliably) -- fall back to a single one-shot
      // read rather than reporting "no GPS" when one might still work.
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS });
      return { lat: pos.coords.latitude, lon: pos.coords.longitude };
    } catch (err) {
      console.error(err);
      lastFailureReason = isServicesDisabledError(err) ? 'services-disabled' : 'no-fix';
      const highAccuracyDetail = `high-accuracy attempt: ${errorText(err)}`;
      lastFailureDetail = lastFailureDetail ? `${lastFailureDetail}; ${highAccuracyDetail}` : highAccuracyDetail;
      return null;
    }
  }

  global.TheBusGeolocate = { getCurrentPosition, getLastFailureReason, getLastFailureDetail, __setTimeoutMsForTesting };
})(window);
