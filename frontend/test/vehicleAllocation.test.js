const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('geoMath.js', 'vehicleAllocation.js');

// Two opposite-direction trips on the same route, sharing the same two
// stops in reverse order -- the exact ambiguous case heading disambiguation
// exists for (a bus at either stop, at a time both trips' windows cover,
// is geographically identical either way; only heading tells them apart).
function tripsIndexFixture() {
  const trips = new Map();
  trips.set('OUTBOUND', {
    routeId: 'R1', serviceId: 'WEEKDAY', headsign: 'Downtown',
    stops: [{ stopId: 'A', minutes: 480 }, { stopId: 'B', minutes: 500 }],
  });
  trips.set('INBOUND', {
    routeId: 'R1', serviceId: 'WEEKDAY', headsign: 'Uptown',
    stops: [{ stopId: 'B', minutes: 480 }, { stopId: 'A', minutes: 500 }],
  });
  // A trip on a different route entirely -- must never be a candidate for R1.
  trips.set('OTHER_ROUTE', {
    routeId: 'R9', serviceId: 'WEEKDAY', headsign: 'Elsewhere',
    stops: [{ stopId: 'A', minutes: 480 }, { stopId: 'B', minutes: 500 }],
  });
  return trips;
}

const stopsById = {
  A: { lat: 28.50, lon: -82.60 },
  B: { lat: 28.50, lon: -82.50 }, // due east of A
};

const alwaysActive = () => true;

test('candidateTrips: filters by routeId, active service, and the trip\'s own time window plus slack', () => {
  const trips = tripsIndexFixture();
  const now = new Date();

  const inWindow = TheBusVehicleAllocation.candidateTrips(trips, 'R1', 490, now, alwaysActive);
  assert.equal(inWindow.length, 2);
  assert.ok(inWindow.every((t) => t.routeId === 'R1'));

  // Well outside even the default 15-minute slack on both ends.
  const outOfWindow = TheBusVehicleAllocation.candidateTrips(trips, 'R1', 100, now, alwaysActive);
  assert.equal(outOfWindow.length, 0);

  // Inactive service excludes an otherwise-in-window trip.
  const noneActive = TheBusVehicleAllocation.candidateTrips(trips, 'R1', 490, now, () => false);
  assert.equal(noneActive.length, 0);
});

test('expectedPositionAt: interpolates linearly between the two bracketing stops', () => {
  const trip = { stops: [{ stopId: 'A', minutes: 480 }, { stopId: 'B', minutes: 500 }] };
  const halfway = TheBusVehicleAllocation.expectedPositionAt(trip, stopsById, 490);
  assert.ok(Math.abs(halfway.lat - 28.50) < 1e-6);
  assert.ok(Math.abs(halfway.lon - (-82.55)) < 1e-6); // halfway between -82.60 and -82.50
  assert.ok(Math.abs(halfway.expectedBearingDeg - 90) < 2); // heading due east, A -> B
});

test('expectedPositionAt: returns null when fewer than 2 stops have real coordinates', () => {
  const trip = { stops: [{ stopId: 'A', minutes: 480 }, { stopId: 'GHOST', minutes: 500 }] };
  assert.equal(TheBusVehicleAllocation.expectedPositionAt(trip, stopsById, 490), null);
});

test('findBestTrip: disambiguates two opposite-direction trips at the same place/time using heading', () => {
  const trips = tripsIndexFixture();
  const now = new Date();
  // At the midpoint time (490), OUTBOUND and INBOUND both expect the vehicle
  // at the exact same geographic midpoint of A/B -- position alone can't
  // tell them apart, so only heading can: OUTBOUND runs A->B (east),
  // INBOUND runs B->A (west).
  const midLat = 28.50;
  const midLon = -82.55;

  const eastbound = TheBusVehicleAllocation.findBestTrip({
    trips, stopsById, routeId: 'R1', lat: midLat, lon: midLon, course: 90, agencyMinutes: 490, now, isActiveFn: alwaysActive,
  });
  assert.equal(eastbound.tripId, 'OUTBOUND');

  const westbound = TheBusVehicleAllocation.findBestTrip({
    trips, stopsById, routeId: 'R1', lat: midLat, lon: midLon, course: 270, agencyMinutes: 490, now, isActiveFn: alwaysActive,
  });
  assert.equal(westbound.tripId, 'INBOUND');
});

test('findBestTrip: returns null when the vehicle is implausibly far from every candidate\'s expected position', () => {
  const trips = tripsIndexFixture();
  const now = new Date();
  const farAway = TheBusVehicleAllocation.findBestTrip({
    trips, stopsById, routeId: 'R1', lat: 30.0, lon: -85.0, course: 90, agencyMinutes: 490, now, isActiveFn: alwaysActive,
  });
  assert.equal(farAway, null);
});

test('findBestTrip: returns null when there are no candidate trips at all (e.g. unknown route)', () => {
  const trips = tripsIndexFixture();
  const now = new Date();
  const noRoute = TheBusVehicleAllocation.findBestTrip({
    trips, stopsById, routeId: 'R404', lat: 28.50, lon: -82.55, course: 90, agencyMinutes: 490, now, isActiveFn: alwaysActive,
  });
  assert.equal(noRoute, null);
});

test('estimateScheduleDeviationMinutes: 0 when the vehicle is exactly where the schedule says at exactly that time', () => {
  const trip = { stops: [{ stopId: 'A', minutes: 480 }, { stopId: 'B', minutes: 500 }] };
  // Halfway between A and B, at the halfway time -- perfectly on schedule.
  const deviation = TheBusVehicleAllocation.estimateScheduleDeviationMinutes(trip, stopsById, 28.50, -82.55, 490);
  assert.ok(Math.abs(deviation) < 0.5, `expected ~0, got ${deviation}`);
});

test('estimateScheduleDeviationMinutes: positive when the vehicle is behind where the schedule says it should be', () => {
  const trip = { stops: [{ stopId: 'A', minutes: 480 }, { stopId: 'B', minutes: 500 }] };
  // It's minute 490 (should be halfway, at the midpoint), but the vehicle is
  // still sitting back at stop A -- i.e. running late.
  const deviation = TheBusVehicleAllocation.estimateScheduleDeviationMinutes(trip, stopsById, 28.50, -82.60, 490);
  assert.ok(deviation > 5, `expected clearly late (positive), got ${deviation}`);
});

test('estimateScheduleDeviationMinutes: returns null with fewer than 2 usable stops', () => {
  const trip = { stops: [{ stopId: 'A', minutes: 480 }] };
  assert.equal(TheBusVehicleAllocation.estimateScheduleDeviationMinutes(trip, stopsById, 28.50, -82.60, 490), null);
});
