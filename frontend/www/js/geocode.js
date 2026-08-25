/**
 * Thin client for the backend's /api/geocode proxy (see
 * backend/src/geocode.js for why this goes through our own server
 * rather than calling Nominatim directly). Resolves a free-text place
 * name to coordinates -- requires network, same as live bus positions.
 */
(function (global) {
  async function lookup(query) {
    const res = await fetch(`${TheBusSync.API_BASE}/api/geocode?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`geocode request failed: HTTP ${res.status}`);
    const { result } = await res.json();
    return result; // {lat, lon, displayName} or null if nothing found
  }

  global.TheBusGeocode = { lookup };
})(window);
