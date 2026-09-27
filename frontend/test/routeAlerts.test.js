const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('routeAlerts.js');

function installEnv(followed) {
  // Notification spy (deliver()'s web path).
  const calls = [];
  function FakeNotification(title, opts) { calls.push({ title, body: opts && opts.body }); }
  FakeNotification.permission = 'granted';
  global.Notification = FakeNotification;
  delete global.Capacitor; // force the web-Notification path, not the native plugin

  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };

  global.TheBusStorage = Object.assign({}, global.TheBusStorage, {
    getFollowedRoutes: async () => followed,
  });
  return { calls };
}

test('notifies once for an alert on a followed route, and dedupes on repeat', async () => {
  const { calls } = installEnv([{ id: 'hart:5', rawId: '5', shortName: '5' }]);
  const alerts = [
    { id: 'a1', header: 'Route 5 detour', effect: 'DETOUR', routes: ['5', '9'] },
    { id: 'a2', header: 'Route 9 delay', effect: 'SIGNIFICANT_DELAYS', routes: ['9'] },
  ];
  await TheBusRouteAlerts.onAlerts(alerts);
  assert.equal(calls.length, 1);
  assert.match(calls[0].title, /Route 5: DETOUR/);
  assert.match(calls[0].body, /detour/i);

  // Same alerts again -> already notified, no new notification.
  await TheBusRouteAlerts.onAlerts(alerts);
  assert.equal(calls.length, 1);
});

test('does nothing when no routes are followed', async () => {
  const { calls } = installEnv([]);
  await TheBusRouteAlerts.onAlerts([{ id: 'a1', header: 'x', routes: ['5'] }]);
  assert.equal(calls.length, 0);
});

test('ignores alerts that do not touch a followed route', async () => {
  const { calls } = installEnv([{ id: 'hart:1', rawId: '1', shortName: '1' }]);
  await TheBusRouteAlerts.onAlerts([{ id: 'a1', header: 'x', routes: ['5', '9'] }]);
  assert.equal(calls.length, 0);
});
