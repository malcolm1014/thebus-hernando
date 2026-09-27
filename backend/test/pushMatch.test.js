const test = require('node:test');
const assert = require('node:assert/strict');
const { matchAlerts } = require('../src/pushMatch');

test('matches a device\'s followed routes to alerts and produces notified keys', () => {
  const devices = [{ token: 'tokA', routes: ['5', '9'] }, { token: 'tokB', routes: ['1'] }];
  const alerts = [
    { id: 'a1', header: 'Route 5 detour', effect: 'DETOUR', routes: ['5'] },
    { id: 'a2', header: 'Route 2 delay', routes: ['2'] },
  ];
  const { sends, newKeys } = matchAlerts(devices, new Set(), alerts);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].token, 'tokA');
  assert.match(sends[0].title, /Route 5: DETOUR/);
  assert.deepEqual(newKeys, ['a1|tokA']);
});

test('skips pairs already in the notified set', () => {
  const devices = [{ token: 'tokA', routes: ['5'] }];
  const alerts = [{ id: 'a1', header: 'x', routes: ['5'] }];
  const { sends, newKeys } = matchAlerts(devices, new Set(['a1|tokA']), alerts);
  assert.equal(sends.length, 0);
  assert.equal(newKeys.length, 0);
});

test('does not mutate the passed-in notified set', () => {
  const notified = new Set();
  matchAlerts([{ token: 't', routes: ['5'] }], notified, [{ id: 'a1', header: 'x', routes: ['5'] }]);
  assert.equal(notified.size, 0); // caller records newKeys, not the matcher
});

test('a device following no routes never matches', () => {
  const { sends } = matchAlerts([{ token: 't', routes: [] }], new Set(), [{ id: 'a1', header: 'x', routes: ['5'] }]);
  assert.equal(sends.length, 0);
});
