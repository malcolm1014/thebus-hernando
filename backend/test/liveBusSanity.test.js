const test = require('node:test');
const assert = require('node:assert/strict');
const { filterPlausibleBuses, isPlausiblePosition } = require('../src/liveBusSanity');

test('isPlausiblePosition: accepts a real Hernando-area fix', () => {
  assert.equal(isPlausiblePosition({ lat: 28.55, lon: -82.45 }), true);
});

test('isPlausiblePosition: rejects NaN from a non-numeric coordinate', () => {
  assert.equal(isPlausiblePosition({ lat: NaN, lon: -82.45 }), false);
  assert.equal(isPlausiblePosition({ lat: 28.55, lon: NaN }), false);
});

test('isPlausiblePosition: rejects the (0, 0) "unset GPS" sentinel', () => {
  assert.equal(isPlausiblePosition({ lat: 0, lon: 0 }), false);
});

test('isPlausiblePosition: rejects a fix far outside Florida entirely', () => {
  assert.equal(isPlausiblePosition({ lat: 40.7128, lon: -74.006 }), false); // New York City
});

test('isPlausiblePosition: accepts a fix elsewhere in Florida, not just the tri-county area', () => {
  assert.equal(isPlausiblePosition({ lat: 25.7617, lon: -80.1918 }), true); // Miami
});

test('filterPlausibleBuses: drops only the garbage entries, keeps the rest in order', () => {
  const buses = [
    { busId: '1', lat: 28.55, lon: -82.45 },
    { busId: '2', lat: 0, lon: 0 },
    { busId: '3', lat: NaN, lon: -82.5 },
    { busId: '4', lat: 25.76, lon: -80.19 },
  ];
  const result = filterPlausibleBuses(buses);
  assert.deepEqual(result.map((b) => b.busId), ['1', '4']);
});
