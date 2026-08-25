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
 */
(function (global) {
  const GPS_TIMEOUT_MS = 10000;

  function plugin() {
    return (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.Geolocation) || null;
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

      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS });
      return { lat: pos.coords.latitude, lon: pos.coords.longitude };
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  global.TheBusGeolocate = { getCurrentPosition };
})(window);
