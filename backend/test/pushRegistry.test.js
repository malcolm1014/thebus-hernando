const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/pushRegistry');

// An in-memory fake of the pushStore interface, so these tests exercise the
// registry's caching + write-through + matching without touching disk or a DB.
function makeFakeStore() {
  const devices = new Map();
  const notified = new Set();
  return {
    devices,
    notified,
    async init() {},
    async loadAll() {
      return {
        devices: [...devices.entries()].map(([token, v]) => ({ token, routes: v.routes, updatedAt: v.updatedAt })),
        notified: [...notified],
      };
    },
    async putDevice(token, routes, updatedAt) { devices.set(token, { routes, updatedAt }); },
    async removeDevice(token) { devices.delete(token); },
    async addNotified(keys) { keys.forEach((k) => notified.add(k)); },
  };
}

test('register writes through to the store and matches alerts once', async () => {
  const store = makeFakeStore();
  registry.__setStoreForTests(store);
  await registry.register('tokA', ['5', '9']);
  assert.ok(store.devices.has('tokA')); // written through to the datastore

  const first = await registry.pendingSends([{ id: 'a1', header: 'Route 5 detour', effect: 'DETOUR', routes: ['5'] }]);
  assert.equal(first.length, 1);
  assert.equal(first[0].token, 'tokA');
  assert.ok(store.notified.has('a1|tokA')); // notified recorded in the datastore

  // Same alert again -> deduped.
  assert.equal((await registry.pendingSends([{ id: 'a1', header: 'x', routes: ['5'] }])).length, 0);
});

test('state is reloaded from the datastore on boot (survives a "restart")', async () => {
  const store = makeFakeStore();
  store.devices.set('tokA', { routes: ['5'], updatedAt: 1 }); // pre-existing rows in the DB
  store.notified.add('old|tokA');
  registry.__setStoreForTests(store);

  // First call triggers ensureLoaded(), which pulls the rows in.
  const list = await registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].token, 'tokA');
  // A previously-notified pair stays deduped after the reload.
  assert.equal((await registry.pendingSends([{ id: 'old', header: 'x', routes: ['5'] }])).length, 0);
});

test('unregister removes from cache and store', async () => {
  const store = makeFakeStore();
  registry.__setStoreForTests(store);
  await registry.register('tokA', ['5']);
  await registry.unregister('tokA');
  assert.equal(store.devices.has('tokA'), false);
  assert.equal((await registry.pendingSends([{ id: 'a1', header: 'x', routes: ['5'] }])).length, 0);
});
