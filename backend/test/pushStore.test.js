const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeFileStore, makePgStore } = require('../src/pushStore');

test('file store persists devices and notified keys across loads', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tribus-push-')), 'reg.json');
  const store = makeFileStore(file);
  await store.init();
  await store.putDevice('tokA', ['5', '9'], 111);
  await store.putDevice('tokB', ['1'], 222);
  await store.addNotified(['a1|tokA']);
  await store.removeDevice('tokB');

  // A fresh store over the same file sees the persisted state.
  const reopened = makeFileStore(file);
  const { devices, notified } = await reopened.loadAll();
  assert.equal(devices.length, 1);
  assert.deepEqual(devices[0], { token: 'tokA', routes: ['5', '9'], updatedAt: 111 });
  assert.deepEqual(notified, ['a1|tokA']);
});

test('pg store issues upsert / delete / idempotent-insert SQL and reads rows back', async () => {
  const calls = [];
  const fakeQuery = async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT token/.test(sql)) return { rows: [{ token: 'tokA', routes: ['5'], updated_at: '111' }] };
    if (/SELECT key/.test(sql)) return { rows: [{ key: 'a1|tokA' }] };
    return { rows: [] };
  };
  const store = makePgStore(fakeQuery);

  await store.init();
  assert.ok(calls.some((c) => /CREATE TABLE IF NOT EXISTS push_devices/.test(c.sql)));
  assert.ok(calls.some((c) => /CREATE TABLE IF NOT EXISTS push_notified/.test(c.sql)));

  await store.putDevice('tokA', ['5'], 111);
  const upsert = calls.find((c) => /INSERT INTO push_devices/.test(c.sql));
  assert.match(upsert.sql, /ON CONFLICT \(token\) DO UPDATE/);
  assert.deepEqual(upsert.params, ['tokA', ['5'], 111]);

  await store.addNotified(['a1|tokA']);
  const notif = calls.find((c) => /INSERT INTO push_notified/.test(c.sql));
  assert.match(notif.sql, /ON CONFLICT \(key\) DO NOTHING/);

  await store.removeDevice('tokA');
  assert.ok(calls.some((c) => /DELETE FROM push_devices WHERE token = \$1/.test(c.sql)));

  const { devices, notified } = await store.loadAll();
  assert.deepEqual(devices, [{ token: 'tokA', routes: ['5'], updatedAt: 111 }]);
  assert.deepEqual(notified, ['a1|tokA']);
});
