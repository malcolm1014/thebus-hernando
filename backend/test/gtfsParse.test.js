const test = require('node:test');
const assert = require('node:assert/strict');
const { gtfsTimeToMinutes } = require('../src/gtfsParse');

test('converts a normal HH:MM:SS time to minutes past midnight', () => {
  assert.equal(gtfsTimeToMinutes('08:15:00'), 8 * 60 + 15);
});

test('preserves GTFS-legal hours >= 24 for past-midnight trips', () => {
  assert.equal(gtfsTimeToMinutes('25:30:00'), 25 * 60 + 30);
});

test('returns null for a missing/empty time string', () => {
  assert.equal(gtfsTimeToMinutes(''), null);
  assert.equal(gtfsTimeToMinutes(undefined), null);
});
