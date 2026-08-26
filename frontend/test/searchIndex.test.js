const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('intentParser.js', 'searchIndex.js');

test('recordPlace/getPlaceById: round-trips a place, and re-recording the same name updates it in place instead of duplicating it', () => {
  TheBusSearchIndex.resetForTests();
  const id1 = TheBusSearchIndex.recordPlace({ name: 'Murphys Deli', lat: 28.5, lon: -82.6 });
  const id2 = TheBusSearchIndex.recordPlace({ name: 'Murphys Deli', lat: 28.51, lon: -82.61 }); // moved slightly / re-geocoded
  assert.equal(id1, id2);
  assert.equal(TheBusSearchIndex.getPlaceCandidates().length, 1);
  const place = TheBusSearchIndex.getPlaceById(id1);
  assert.equal(place.lat, 28.51);
  assert.equal(place.hitCount, 2);
});

test('lookupAlias/recordAlias: round-trips a learned resolution, namespaced by kind so a stop and a place can share a phrase key without colliding', () => {
  TheBusSearchIndex.resetForTests();
  assert.equal(TheBusSearchIndex.lookupAlias('landmark', 'the deli'), null);
  TheBusSearchIndex.recordAlias('landmark', 'the deli', { id: 'place:murphys deli', name: 'Murphys Deli' });
  const hit = TheBusSearchIndex.lookupAlias('landmark', 'the deli');
  assert.equal(hit.id, 'place:murphys deli');
  assert.equal(hit.kind, 'landmark');
});

test('recordPlace: evicts the least-recently-used entry once over the cap, keeping recently-touched entries', () => {
  TheBusSearchIndex.resetForTests();
  // Seed 200 places (the real cap) directly rather than one at a time --
  // faster, and keeps this test about eviction behavior, not insertion.
  const seedPlaces = [];
  for (let i = 0; i < 200; i++) {
    seedPlaces.push({ id: `place:seed${i}`, name: `Seed Place ${i}`, lat: 28, lon: -82, lastUsedAt: i, hitCount: 1 });
  }
  TheBusSearchIndex.resetForTests({ places: seedPlaces });
  assert.equal(TheBusSearchIndex.getPlaceCandidates().length, 200);

  // One more push over the cap -- the OLDEST (lastUsedAt: 0, "Seed Place 0") should be the one dropped.
  TheBusSearchIndex.recordPlace({ name: 'One More Place', lat: 28, lon: -82 });
  const candidates = TheBusSearchIndex.getPlaceCandidates();
  assert.equal(candidates.length, 200);
  assert.ok(!candidates.some((c) => c.name === 'Seed Place 0'), 'oldest entry should have been evicted');
  assert.ok(candidates.some((c) => c.name === 'One More Place'), 'the new entry should be present');
  assert.ok(candidates.some((c) => c.name === 'Seed Place 199'), 'the most recently used seed entry should survive');
});

test('lookupAlias: a hit refreshes lastUsedAt, protecting frequently-reused phrases from eviction', () => {
  const seedAliases = {};
  for (let i = 0; i < 300; i++) {
    seedAliases[`landmark:seed${i}`] = { kind: 'landmark', id: `place:seed${i}`, name: `Seed ${i}`, lastUsedAt: i };
  }
  TheBusSearchIndex.resetForTests({ aliases: seedAliases });

  // Touch the OLDEST alias (lastUsedAt: 0) so it should now be the freshest, not the next to go.
  TheBusSearchIndex.lookupAlias('landmark', 'seed0');
  TheBusSearchIndex.recordAlias('landmark', 'one-more-phrase', { id: 'place:new', name: 'New Place' });

  assert.ok(TheBusSearchIndex.lookupAlias('landmark', 'seed0'), 'recently-touched alias should survive eviction');
  assert.ok(TheBusSearchIndex.lookupAlias('landmark', 'one-more-phrase'), 'the new alias should be present');
  assert.equal(TheBusSearchIndex.lookupAlias('landmark', 'seed1'), null, 'the next-oldest, untouched alias should have been evicted');
});

test('ensureLoaded: actually round-trips through TheBusStorage (real persistence path, not the synchronous test-only reset)', async () => {
  let saved = null;
  global.TheBusStorage = {
    getSearchMemory: async () => saved,
    saveSearchMemory: async (memory) => { saved = memory; },
  };
  try {
    TheBusSearchIndex.resetForTests();
    // Force a genuine reload from (empty) storage rather than the
    // synchronous seed path, to exercise ensureLoaded()'s real branch.
    await TheBusSearchIndex.ensureLoaded();
    TheBusSearchIndex.recordPlace({ name: 'Persisted Place', lat: 1, lon: 2 });
    // persist() is fire-and-forget; give its microtask a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(saved, 'a write should have reached TheBusStorage');
    assert.equal(saved.places[0].name, 'Persisted Place');
  } finally {
    delete global.TheBusStorage;
  }
});
