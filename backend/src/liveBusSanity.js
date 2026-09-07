/**
 * Sanity-checks live vehicle positions before they reach the client.
 * Passio and PascoGo's own normalizeVehicle/parsing already drop entries
 * missing coordinates entirely (see passio.js, pascoRealtime.js) -- this
 * catches the class those don't: a numeric-looking but garbage value
 * (a non-numeric string coerced to NaN, or a vendor bug reporting
 * (0, 0) / coordinates on the other side of the country). Applied once
 * here at server.js's merge point rather than duplicated inside each
 * vendor-specific parser, since "is this a real position at all" is the
 * same question regardless of which vendor answered it.
 *
 * The bounding box is deliberately generous (all of Florida, not just
 * the tri-county service area) -- the goal is rejecting outright garbage
 * data, not second-guessing a real GPS fix just because it's a few
 * counties outside today's configured service area (a vehicle on a
 * highway shakedown run, a schedule change adding a new area, etc.
 * shouldn't get silently dropped by an overly-tight box).
 */
const FLORIDA_BOUNDS = { minLat: 24.3, maxLat: 31.1, minLon: -87.7, maxLon: -79.8 };

function isPlausiblePosition(bus) {
  if (!Number.isFinite(bus.lat) || !Number.isFinite(bus.lon)) return false;
  if (bus.lat === 0 && bus.lon === 0) return false; // the classic "unset GPS" sentinel value, not a real fix anywhere near Florida
  return (
    bus.lat >= FLORIDA_BOUNDS.minLat && bus.lat <= FLORIDA_BOUNDS.maxLat &&
    bus.lon >= FLORIDA_BOUNDS.minLon && bus.lon <= FLORIDA_BOUNDS.maxLon
  );
}

function filterPlausibleBuses(buses) {
  return buses.filter(isPlausiblePosition);
}

module.exports = { filterPlausibleBuses, isPlausiblePosition, FLORIDA_BOUNDS };
