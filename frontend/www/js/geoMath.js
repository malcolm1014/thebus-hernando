/**
 * Small, dependency-free geometry helpers shared by the live map's GPS
 * refinement (snapping a raw vehicle fix onto its route shape instead of
 * showing it floating off the road) and vehicle-allocation trip matching
 * (which needs a bearing at the matched point to disambiguate two
 * opposite-direction trips sharing the same stops).
 *
 * Deliberately hand-rolled rather than pulling in turf.js: this app is
 * offline-first with no bundler (see sync.js/geolocate.js's own doc
 * comments), and the actual math needed -- project a point onto a
 * polyline -- is a few dozen lines. Uses the same flat local-plane
 * projection transform.js's Douglas-Peucker shape simplifier already
 * uses server-side (accurate enough at single-county/tri-county scale,
 * see transform.js's own comment on that choice).
 */
(function (global) {
  const METERS_PER_DEG_LAT = 111320;

  function metersPerDegLon(atLat) {
    return METERS_PER_DEG_LAT * Math.cos((atLat * Math.PI) / 180);
  }

  function toXY(lat, lon, refLat) {
    return { x: lon * metersPerDegLon(refLat), y: lat * METERS_PER_DEG_LAT };
  }

  function fromXY(x, y, refLat) {
    return { lat: y / METERS_PER_DEG_LAT, lon: x / metersPerDegLon(refLat) };
  }

  /** Initial compass bearing (0-360, 0 = north) from point a to point b, both [lat, lon]. */
  function bearingDeg(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const dLon = toRad(b[1] - a[1]);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /** Smallest absolute difference between two compass bearings (0-180). */
  function bearingDiffDeg(a, b) {
    const diff = Math.abs(a - b) % 360;
    return diff > 180 ? 360 - diff : diff;
  }

  /**
   * Projects {lat, lon} onto the nearest point of a [[lat, lon], ...]
   * polyline (a route's `shapePoints`). Returns null when the polyline
   * has fewer than 2 points (nothing to project onto).
   *
   * Returns { lat, lon, distMeters, segmentIndex, t, distAlongMeters,
   * bearingDeg }: `distMeters` is how far the raw fix was from the
   * shape (a large value is a sign the vendor's routeId match is
   * probably wrong, or the bus has genuinely left its route);
   * `distAlongMeters` is the running distance from the start of the
   * polyline to the projected point, for ordering/progress comparisons;
   * `bearingDeg` is the direction of travel along the matched segment,
   * for disambiguating two trips that share the same road in opposite
   * directions.
   */
  function nearestPointOnPolyline(lat, lon, polyline) {
    if (!polyline || polyline.length < 2) return null;
    const ref = toXY(lat, lon, lat);
    let best = null;
    let cumulativeMeters = 0;

    for (let i = 0; i < polyline.length - 1; i++) {
      const a = toXY(polyline[i][0], polyline[i][1], lat);
      const b = toXY(polyline[i + 1][0], polyline[i + 1][1], lat);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const segLenMeters = Math.hypot(dx, dy);

      let t = 0;
      if (dx !== 0 || dy !== 0) {
        t = ((ref.x - a.x) * dx + (ref.y - a.y) * dy) / (dx * dx + dy * dy);
        t = Math.max(0, Math.min(1, t));
      }
      const projX = a.x + t * dx;
      const projY = a.y + t * dy;
      const distMeters = Math.hypot(ref.x - projX, ref.y - projY);

      if (!best || distMeters < best.distMeters) {
        const proj = fromXY(projX, projY, lat);
        best = {
          lat: proj.lat,
          lon: proj.lon,
          distMeters,
          segmentIndex: i,
          t,
          distAlongMeters: cumulativeMeters + t * segLenMeters,
          bearingDeg: bearingDeg(polyline[i], polyline[i + 1]),
        };
      }
      cumulativeMeters += segLenMeters;
    }
    return best;
  }

  global.TheBusGeoMath = { nearestPointOnPolyline, bearingDeg, bearingDiffDeg };
})(window);
