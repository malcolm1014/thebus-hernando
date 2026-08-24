const { parse } = require('csv-parse/sync');
const { readGtfsFile } = require('./gtfsFetch');

/** Parses one GTFS CSV file into an array of row objects. Returns [] if the file is absent (some GTFS files are optional). */
function parseFile(name) {
  const raw = readGtfsFile(name);
  if (!raw) {
    console.warn(`[gtfsParse] ${name} not present in feed, skipping`);
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

/** Parses all the GTFS tables the transform step needs. */
function parseAllGtfs() {
  return {
    routes: parseFile('routes.txt'),
    trips: parseFile('trips.txt'),
    stops: parseFile('stops.txt'),
    stopTimes: parseFile('stop_times.txt'),
    calendar: parseFile('calendar.txt'),
    calendarDates: parseFile('calendar_dates.txt'), // optional, service exceptions
  };
}

module.exports = { parseAllGtfs, gtfsTimeToMinutes };
