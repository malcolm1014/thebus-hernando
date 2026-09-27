const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/pushRegistry');

test('pendingSends matches a device\'s followed routes to alerts, once each', () => {
  registry.resetForTests();
  registry.register('tokA', ['5', '9']);
  registry.register('tokB', ['1']);

  const alerts = [
    { id: 'a1', header: 'Route 5 detour', effect: 'DETOUR', routes: ['5'] },
    { id: 'a2', header: 'Route 2 delay', routes: ['2'] }, // nobody follows route 2
  ];

  const first = registry.pendingSends(alerts);
  assert.equal(first.length, 1);
  assert.equal(first[0].token, 'tokA');
  assert.match(first[0].title, /Route 5: DETOUR/);

  // Same alerts again -> already notified, nothing to send.
  assert.equal(registry.pendingSends(alerts).length, 0);
});

test('a newly-active alert on a followed route is picked up on a later check', () => {
  registry.resetForTests();
  registry.register('tokA', ['5']);
  assert.equal(registry.pendingSends([{ id: 'a1', routes: ['9'] }]).length, 0); // route not followed
  const later = registry.pendingSends([{ id: 'a1', routes: ['9'] }, { id: 'a2', header: 'New', routes: ['5'] }]);
  assert.equal(later.length, 1);
  assert.equal(later[0].alertId, 'a2');
});

test('unregister stops a device from matching', () => {
  registry.resetForTests();
  registry.register('tokA', ['5']);
  registry.unregister('tokA');
  assert.equal(registry.pendingSends([{ id: 'a1', header: 'x', routes: ['5'] }]).length, 0);
  assert.equal(registry.list().length, 0);
});

test('a device following no routes never matches', () => {
  registry.resetForTests();
  registry.register('tokA', []);
  assert.equal(registry.pendingSends([{ id: 'a1', header: 'x', routes: ['5'] }]).length, 0);
});
