/**
 * Offline-friendly basemap tiles via a runtime cache. Every basemap tile the
 * rider actually views is stored (via the Cache API) and re-served when the
 * network is gone -- so a route you looked at with signal still shows its
 * streets later underground / in a dead zone, instead of the black void a
 * missing tile leaves. liveMap.js wraps its Leaflet tile layer around this.
 *
 * This is the achievable, no-new-dependency slice of "offline maps": it
 * covers wherever you've been. A FULL pre-bundled tri-county basemap (so the
 * whole area works offline on a fresh install, before you've panned there)
 * needs a generated tile archive shipped like the Valhalla routing tiles --
 * a separate, larger follow-up.
 *
 * Entirely feature-detected and best-effort: where the Cache API isn't
 * available (or throws -- private mode, storage pressure), every method is a
 * safe no-op and the map behaves exactly as before (online-only tiles).
 */
(function (global) {
  const CACHE_NAME = 'tribus-basemap-tiles-v1';

  function available() {
    return !!(global.caches && global.fetch && global.Response
      && global.URL && typeof URL.createObjectURL === 'function');
  }

  async function put(url, blob) {
    if (!available() || !blob) return;
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(url, new Response(blob));
    } catch (e) { /* storage full / unavailable -> just skip caching this tile */ }
  }

  async function match(url) {
    if (!global.caches) return null;
    try {
      const cache = await caches.open(CACHE_NAME);
      const res = await cache.match(url);
      return res ? await res.blob() : null;
    } catch (e) {
      return null;
    }
  }

  global.TheBusTileCache = { available, put, match, CACHE_NAME };
})(typeof window !== 'undefined' ? window : this);
