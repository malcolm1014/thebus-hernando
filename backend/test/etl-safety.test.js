const test = require('node:test');
const assert = require('node:assert/strict');
const { isSuspiciouslySmaller, extractAgencySlice } = require('../src/etl');

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

// extractAgencySlice: pulling one agency's own data back out of a
// previously-written MERGED dataset, for the per-agency fetch-failure
// fallback in fetchAndTransformAgency -- one agency's feed being down
// shouldn't blank it out of the app when we already have its last
// known-good data.
function mergedFixture() {
  return {
    agencyTimezone: 'America/New_York',
    agencies: {
      hernando: { label: 'Hernando County Transit', timezone: 'America/New_York', stopCount: 1, routeCount: 1 },
      pasco: { label: 'PascoGo', timezone: 'America/New_York', stopCount: 1, routeCount: 1 },
    },
    services: { 'hernando:WEEKDAY': { monday: true }, 'pasco:WEEKDAY': { monday: true } },
    routes: { 'hernando:R1': { id: 'hernando:R1' }, 'pasco:R1': { id: 'pasco:R1' } },
    stops: { 'hernando:S1': { id: 'hernando:S1' }, 'pasco:S1': { id: 'pasco:S1' } },
  };
}

test('extractAgencySlice: pulls only the requested agency\'s own stops/routes/services out of a merged dataset', () => {
  const slice = extractAgencySlice(mergedFixture(), 'pasco');
  assert.deepEqual(Object.keys(slice.stops), ['pasco:S1']);
  assert.deepEqual(Object.keys(slice.routes), ['pasco:R1']);
  assert.deepEqual(Object.keys(slice.services), ['pasco:WEEKDAY']);
  assert.equal(slice.agencyTimezone, 'America/New_York');
});

test('extractAgencySlice: returns null when there is no previous data, or the agency has no stops in it', () => {
  assert.equal(extractAgencySlice(null, 'pasco'), null);
  assert.equal(extractAgencySlice(mergedFixture(), 'hart'), null); // never successfully pulled before
});
