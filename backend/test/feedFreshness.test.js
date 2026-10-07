const test = require('node:test');
const assert = require('node:assert/strict');
const { hasCurrentService, toGtfsDate } = require('../src/feedFreshness');

// A fixed "now" so these tests never drift with the real clock.
const NOW = new Date('2026-10-07T12:00:00');

test('toGtfsDate: formats a JS Date as GTFS YYYYMMDD', () => {
  assert.equal(toGtfsDate(new Date('2026-10-07T12:00:00')), '20261007');
  assert.equal(toGtfsDate(new Date('2026-01-03T00:00:00')), '20260103'); // zero-padded
});

test('hasCurrentService: true when a regular calendar window is still open', () => {
  const data = { services: { s1: { endDate: '20261231', addedDates: [] } } };
  assert.equal(hasCurrentService(data, NOW), true);
});

test('hasCurrentService: true when the window ends exactly today', () => {
  const data = { services: { s1: { endDate: '20261007', addedDates: [] } } };
  assert.equal(hasCurrentService(data, NOW), true);
});

test('hasCurrentService: false when every calendar window has elapsed (the Citrus case)', () => {
  // Mirrors Citrus County Transit's only public feed: service ended 2025-01-01.
  const data = { services: { s1: { endDate: '20250101', addedDates: [] } } };
  assert.equal(hasCurrentService(data, NOW), false);
});

test('hasCurrentService: true when a future exception date adds service, even with an elapsed window', () => {
  const data = { services: { s1: { endDate: '20250101', addedDates: ['20261225'] } } };
  assert.equal(hasCurrentService(data, NOW), true);
});

test('hasCurrentService: a calendar_dates-only service (null endDate) is current via a future added date', () => {
  const data = { services: { s1: { startDate: null, endDate: null, addedDates: ['20261101'], removedDates: [] } } };
  assert.equal(hasCurrentService(data, NOW), true);
});

test('hasCurrentService: a calendar_dates-only service whose only added dates are past is NOT current', () => {
  const data = { services: { s1: { startDate: null, endDate: null, addedDates: ['20240101'], removedDates: [] } } };
  assert.equal(hasCurrentService(data, NOW), false);
});

test('hasCurrentService: true if ANY one service is current among elapsed ones', () => {
  const data = { services: {
    old: { endDate: '20250101', addedDates: [] },
    live: { endDate: '20270601', addedDates: [] },
  } };
  assert.equal(hasCurrentService(data, NOW), true);
});

test('hasCurrentService: false for an empty / missing service table', () => {
  assert.equal(hasCurrentService({ services: {} }, NOW), false);
  assert.equal(hasCurrentService({}, NOW), false);
  assert.equal(hasCurrentService(null, NOW), false);
});

test('hasCurrentService: tolerates numeric date values (not just strings)', () => {
  const data = { services: { s1: { endDate: 20261231, addedDates: [20261225] } } };
  assert.equal(hasCurrentService(data, NOW), true);
});
