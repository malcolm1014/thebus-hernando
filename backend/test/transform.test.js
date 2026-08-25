const test = require('node:test');
const assert = require('node:assert/strict');
const { transform } = require('../src/transform');

/** Minimal hand-built GTFS row objects -- same shape csv-parse/sync produces from real CSV text, so transform() is exercised exactly as the real ETL would call it, without touching the filesystem. */
function baseTables(overrides = {}) {
  return {
    agency: [{ agency_id: '1', agency_timezone: 'America/New_York' }],
    routes: [{ route_id: 'R1', route_short_name: '', route_long_name: 'Blue', route_color: '0034E4', route_text_color: 'FFFFFF' }],
    trips: [
      { route_id: 'R1', service_id: 'WEEKDAY', trip_id: 'T1', trip_headsign: '' },
    ],
    stops: [
      { stop_id: 'S1', stop_name: 'First St', stop_lat: '28.5', stop_lon: '-82.6' },
      { stop_id: 'S2', stop_name: 'Second St', stop_lat: '28.6', stop_lon: '-82.7' },
    ],
    stopTimes: [
      { trip_id: 'T1', stop_id: 'S1', stop_sequence: '1', arrival_time: '08:00:00' },
      { trip_id: 'T1', stop_id: 'S2', stop_sequence: '2', arrival_time: '08:15:00' },
    ],
    calendar: [
      { service_id: 'WEEKDAY', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '0', sunday: '0', start_date: '20260101', end_date: '20261231' },
    ],
    calendarDates: [],
    frequencies: [],
    shapes: [],
    ...overrides,
  };
}

test('flattens routes/stops/stop_times into the stop-keyed shape', () => {
  const data = transform(baseTables());
  assert.equal(data.agencyTimezone, 'America/New_York');
  assert.deepEqual(Object.keys(data.stops).sort(), ['S1', 'S2']);
  assert.deepEqual(data.routes.R1.stopIds, ['S1', 'S2']);

  const s1RouteEntry = data.stops.S1.routes[0];
  assert.equal(s1RouteEntry.routeId, 'R1');
  assert.equal(s1RouteEntry.arrivals[0].minutes, 8 * 60);
});

test('derives a headsign from the trip\'s final stop when trip_headsign is blank', () => {
  const data = transform(baseTables());
  // Real Hernando County quirk: trip_headsign is blank feed-wide.
  const s1Arrival = data.stops.S1.routes[0].arrivals[0];
  assert.equal(s1Arrival.headsign, 'Second St'); // T1's last stop is S2
});

test('keeps a real trip_headsign when the feed actually provides one', () => {
  const data = transform(baseTables({
    trips: [{ route_id: 'R1', service_id: 'WEEKDAY', trip_id: 'T1', trip_headsign: 'Downtown Express' }],
  }));
  assert.equal(data.stops.S1.routes[0].arrivals[0].headsign, 'Downtown Express');
});

test('folds calendar_dates.txt exceptions into the service record', () => {
  const data = transform(baseTables({
    calendarDates: [
      { service_id: 'WEEKDAY', date: '20260704', exception_type: '2' }, // removed (holiday)
      { service_id: 'WEEKDAY', date: '20260704', exception_type: '' },
    ].slice(0, 1),
  }));
  assert.deepEqual(data.services.WEEKDAY.removedDates, ['20260704']);
});

test('throws rather than silently dropping arrivals when frequencies.txt is present', () => {
  assert.throws(
    () => transform(baseTables({ frequencies: [{ trip_id: 'T1', start_time: '06:00:00', end_time: '09:00:00', headway_secs: '1200' }] })),
    /frequencies\.txt/
  );
});

test('falls back to America/New_York when agency.txt is missing agency_timezone', () => {
  const data = transform(baseTables({ agency: [] }));
  assert.equal(data.agencyTimezone, 'America/New_York');
});

test('attaches a route\'s shape polyline (sorted by sequence) from shapes.txt via the trip\'s shape_id', () => {
  const data = transform(baseTables({
    trips: [{ route_id: 'R1', service_id: 'WEEKDAY', trip_id: 'T1', trip_headsign: '', shape_id: 'SH1' }],
    shapes: [
      { shape_id: 'SH1', shape_pt_lat: '28.51', shape_pt_lon: '-82.61', shape_pt_sequence: '2' },
      { shape_id: 'SH1', shape_pt_lat: '28.50', shape_pt_lon: '-82.60', shape_pt_sequence: '1' },
    ],
  }));
  assert.deepEqual(data.routes.R1.shapePoints, [[28.50, -82.60], [28.51, -82.61]]);
});

test('simplifies a shape polyline: drops a mid-point that lies exactly on the line between its neighbors', () => {
  const data = transform(baseTables({
    trips: [{ route_id: 'R1', service_id: 'WEEKDAY', trip_id: 'T1', trip_headsign: '', shape_id: 'SH1' }],
    shapes: [
      { shape_id: 'SH1', shape_pt_lat: '28.50', shape_pt_lon: '-82.60', shape_pt_sequence: '1' },
      { shape_id: 'SH1', shape_pt_lat: '28.505', shape_pt_lon: '-82.60', shape_pt_sequence: '2' }, // exactly on the line, zero deviation
      { shape_id: 'SH1', shape_pt_lat: '28.51', shape_pt_lon: '-82.60', shape_pt_sequence: '3' },
    ],
  }));
  assert.deepEqual(data.routes.R1.shapePoints, [[28.50, -82.60], [28.51, -82.60]]);
});

test('simplifies a shape polyline: KEEPS a mid-point that deviates well beyond the simplification tolerance', () => {
  const data = transform(baseTables({
    trips: [{ route_id: 'R1', service_id: 'WEEKDAY', trip_id: 'T1', trip_headsign: '', shape_id: 'SH1' }],
    shapes: [
      { shape_id: 'SH1', shape_pt_lat: '28.50', shape_pt_lon: '-82.60', shape_pt_sequence: '1' },
      { shape_id: 'SH1', shape_pt_lat: '28.505', shape_pt_lon: '-82.5980', shape_pt_sequence: '2' }, // ~0.002deg lon off the line, ~190m -- well above the 8m tolerance
      { shape_id: 'SH1', shape_pt_lat: '28.51', shape_pt_lon: '-82.60', shape_pt_sequence: '3' },
    ],
  }));
  assert.equal(data.routes.R1.shapePoints.length, 3);
});

test('leaves shapePoints empty when a trip has no shape_id or shapes.txt is absent', () => {
  const data = transform(baseTables());
  assert.deepEqual(data.routes.R1.shapePoints, []);
});

test('registers a stop as served by a route even when its stop_time row has no arrival/departure time', () => {
  // Real-world GTFS pattern (81% of rows in Hernando County's actual
  // feed): non-"timepoint" stops are meant to be interpolated, not
  // treated as unserved. A stop_time row with both times blank must
  // still create the stop<->route relationship -- just with no
  // displayable arrival for that specific occurrence.
  const data = transform(baseTables({
    stopTimes: [
      { trip_id: 'T1', stop_id: 'S1', stop_sequence: '1', arrival_time: '08:00:00', departure_time: '08:00:00' },
      { trip_id: 'T1', stop_id: 'S2', stop_sequence: '2', arrival_time: '', departure_time: '' },
    ],
  }));
  assert.equal(data.stops.S2.routes.length, 1, 'S2 should still be listed as served by R1');
  assert.equal(data.stops.S2.routes[0].routeId, 'R1');
  assert.deepEqual(data.stops.S2.routes[0].arrivals, [], 'no displayable time, but still served');
  assert.deepEqual(data.routes.R1.stopIds, ['S1', 'S2']);
});
