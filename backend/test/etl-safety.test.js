const test = require('node:test');
const assert = require('node:assert/strict');
const { isSuspiciouslySmaller } = require('../src/etl');

function withCounts(stopCount, routeCount) {
  return {
    stops: Object.fromEntries(Array.from({ length: stopCount }, (_, i) => [`S${i}`, {}])),
    routes: Object.fromEntries(Array.from({ length: routeCount }, (_, i) => [`R${i}`, {}])),
  };
}

test('allows a normal, similarly-sized re-pull', () => {
  const previous = withCounts(369, 8);
  const next = withCounts(371, 8); // a couple stops added -- real schedule change
  assert.equal(isSuspiciouslySmaller(previous, next), false);
});

test('flags a >50% drop in stops as a likely broken feed', () => {
  const previous = withCounts(369, 8);
  const next = withCounts(100, 8);
  assert.equal(isSuspiciouslySmaller(previous, next), true);
});

test('flags a >50% drop in routes as a likely broken feed', () => {
  const previous = withCounts(369, 8);
  const next = withCounts(369, 2);
  assert.equal(isSuspiciouslySmaller(previous, next), true);
});

test('never blocks the very first ETL run (no previous data)', () => {
  const next = withCounts(369, 8);
  assert.equal(isSuspiciouslySmaller(null, next), false);
});
