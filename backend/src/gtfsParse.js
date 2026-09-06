const { parse } = require('csv-parse/sync');
const { readGtfsFile } = require('./gtfsFetch');

/** Parses one agency's GTFS CSV file into an array of row objects. Returns [] if the file is absent (some GTFS files are optional). */
function parseFile(agencyId, name) {
  const raw = readGtfsFile(agencyId, name);
  if (!raw) {
    console.warn(`[gtfsParse] [${agencyId}] ${name} not present in feed, skipping`);
    return [];
  }
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
}

/**
 * Converts a GTFS "HH:MM:SS" time string into minutes past midnight.
 * GTFS deliberately allows hours >= 24 for trips that run past midnight
 * (e.g. "25:30:00"), which we preserve as-is (e.g. 1530 minutes) so the
 * client can decide how to interpret same-day vs. next-day service.
 */
function gtfsTimeToMinutes(hhmmss) {
  if (!hhmmss) return null;
  const [h, m, s] = hhmmss.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m + (s ? s / 60 : 0);
}

/** Parses all the GTFS tables the transform step needs, for one agency. */
function parseAllGtfs(agencyId) {
  return {
    agency: parseFile(agencyId, 'agency.txt'),
    routes: parseFile(agencyId, 'routes.txt'),
    trips: parseFile(agencyId, 'trips.txt'),
    stops: parseFile(agencyId, 'stops.txt'),
    stopTimes: parseFile(agencyId, 'stop_times.txt'),
    calendar: parseFile(agencyId, 'calendar.txt'),
    calendarDates: parseFile(agencyId, 'calendar_dates.txt'), // optional, service exceptions
    frequencies: parseFile(agencyId, 'frequencies.txt'), // optional, headway-based trips
    shapes: parseFile(agencyId, 'shapes.txt'), // optional, route polylines for the map view
  };
}

module.exports = { parseAllGtfs, gtfsTimeToMinutes };
