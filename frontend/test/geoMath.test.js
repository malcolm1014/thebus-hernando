const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('geoMath.js');

test('nearestPointOnPolyline: returns null for a polyline with fewer than 2 points', () => {
  assert.equal(TheBusGeoMath.nearestPointOnPolyline(28.5, -82.6, []), null);
  assert.equal(TheBusGeoMath.nearestPointOnPolyline(28.5, -82.6, [[28.5, -82.6]]), null);
});

test('nearestPointOnPolyline: a point already ON the line snaps to itself with ~0 distance', () => {
  const polyline = [[28.50, -82.60], [28.50, -82.50]]; // due east segment
  const midpoint = [28.50, -82.55];
  const result = TheBusGeoMath.nearestPointOnPolyline(midpoint[0], midpoint[1], polyline);
  assert.ok(result.distMeters < 1, `expected ~0m, got ${result.distMeters}`);
  assert.equal(result.segmentIndex, 0);
  assert.ok(Math.abs(result.t - 0.5) < 0.01);
});

test('nearestPointOnPolyline: a point off to the side projects perpendicular onto the segment', () => {
  const polyline = [[28.50, -82.60], [28.50, -82.50]]; // due east segment
  // ~1km north of the midpoint -- should project straight down onto the line, not to either endpoint.
  const result = TheBusGeoMath.nearestPointOnPolyline(28.509, -82.55, polyline);
  assert.ok(result.distMeters > 900 && result.distMeters < 1100, `expected ~1000m, got ${result.distMeters}`);
  assert.ok(Math.abs(result.lat - 28.50) < 0.001);
  assert.ok(Math.abs(result.lon - (-82.55)) < 0.001);
});

test('nearestPointOnPolyline: picks the closer of two segments, and distAlongMeters accounts for the earlier segment', () => {
  const polyline = [[28.50, -82.60], [28.50, -82.55], [28.55, -82.55]]; // east, then north
  // Point near the start of the second (northward) segment.
  const result = TheBusGeoMath.nearestPointOnPolyline(28.501, -82.55, polyline);
  assert.equal(result.segmentIndex, 1);
  assert.ok(result.distAlongMeters > 0, 'distAlongMeters should include the first segment\'s length');
});

test('bearingDeg: due north is 0, due east is 90', () => {
  assert.ok(Math.abs(TheBusGeoMath.bearingDeg([28.0, -82.0], [28.1, -82.0]) - 0) < 1);
  assert.ok(Math.abs(TheBusGeoMath.bearingDeg([28.0, -82.0], [28.0, -81.9]) - 90) < 2);
});

test('bearingDiffDeg: handles wraparound (350 vs 10 is 20 apart, not 340)', () => {
  assert.equal(TheBusGeoMath.bearingDiffDeg(350, 10), 20);
  assert.equal(TheBusGeoMath.bearingDiffDeg(10, 350), 20);
  assert.equal(TheBusGeoMath.bearingDiffDeg(90, 270), 180);
});
