/**
 * Persistence backend for the push token registry. Two implementations
 * behind one async interface, chosen by config:
 *
 *   - Postgres (when DATABASE_URL is set, e.g. Render's managed Postgres):
 *     a REAL datastore -- tokens and notified-history survive cold starts,
 *     redeploys, and the free-tier idle teardown.
 *   - JSON file (fallback): best-effort persistence to the data dir, which
 *     survives a process restart but not a free-tier teardown.
 *
 * Interface (all async): init(), loadAll() -> {devices, notified},
 * putDevice(token, routes, updatedAt), removeDevice(token), addNotified(keys).
 * The matching logic lives in pushMatch.js; this module only stores/loads.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const NOTIFIED_CAP = 5000;

// ---- File backend -------------------------------------------------------
function makeFileStore(filePath) {
  function read() {
    try {
      if (!fs.existsSync(filePath)) return { devices: {}, notified: [] };
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { devices: raw.devices || {}, notified: Array.isArray(raw.notified) ? raw.notified : [] };
    } catch (e) { return { devices: {}, notified: [] }; }
  }
  function write(state) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ devices: state.devices, notified: state.notified.slice(-NOTIFIED_CAP) }));
    } catch (e) { /* best-effort */ }
  }
  return {
    kind: 'file',
    async init() { /* nothing to set up */ },
    async loadAll() {
      const s = read();
      return {
        devices: Object.entries(s.devices).map(([token, v]) => ({ token, routes: v.routes || [], updatedAt: v.updatedAt || 0 })),
        notified: s.notified,
      };
    },
    async putDevice(token, routes, updatedAt) {
      const s = read();
      s.devices[token] = { routes, updatedAt };
      write(s);
    },
    async removeDevice(token) {
      const s = read();
      if (s.devices[token]) { delete s.devices[token]; write(s); }
    },
    async addNotified(keys) {
      if (!keys || !keys.length) return;
      const s = read();
      s.notified.push(...keys);
      write(s);
    },
  };
}

// ---- Postgres backend ---------------------------------------------------
// `query(sql, params) -> { rows }` is injected so this is unit-testable
// without a live database.
function makePgStore(query) {
  return {
    kind: 'pg',
    async init() {
      await query('CREATE TABLE IF NOT EXISTS push_devices (token TEXT PRIMARY KEY, routes TEXT[] NOT NULL DEFAULT \'{}\', updated_at BIGINT)', []);
      await query('CREATE TABLE IF NOT EXISTS push_notified (key TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())', []);
    },
    async loadAll() {
      const dev = await query('SELECT token, routes, updated_at FROM push_devices', []);
      const notif = await query('SELECT key FROM push_notified', []);
      return {
        devices: (dev.rows || []).map((r) => ({ token: r.token, routes: r.routes || [], updatedAt: Number(r.updated_at) || 0 })),
        notified: (notif.rows || []).map((r) => r.key),
      };
    },
    async putDevice(token, routes, updatedAt) {
      await query(
        'INSERT INTO push_devices (token, routes, updated_at) VALUES ($1, $2, $3) ON CONFLICT (token) DO UPDATE SET routes = EXCLUDED.routes, updated_at = EXCLUDED.updated_at',
        [token, routes, updatedAt],
      );
    },
    async removeDevice(token) {
      await query('DELETE FROM push_devices WHERE token = $1', [token]);
    },
    async addNotified(keys) {
      if (!keys || !keys.length) return;
      // Insert each key idempotently; ignore ones already recorded.
      for (const key of keys) {
        await query('INSERT INTO push_notified (key) VALUES ($1) ON CONFLICT (key) DO NOTHING', [key]);
      }
    },
  };
}

// ---- Backend selection --------------------------------------------------
let singleton = null;

function createDefaultStore() {
  if (config.databaseUrl) {
    // Lazy-require pg so the dependency is only needed when DATABASE_URL is set.
    // eslint-disable-next-line global-require
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: config.databaseUrl,
      // Managed Postgres (Render/Heroku) requires SSL; localhost doesn't.
      ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
    });
    const store = makePgStore((sql, params) => pool.query(sql, params));
    store._pool = pool;
    return store;
  }
  return makeFileStore(path.join(config.dataDir, 'push-registry.json'));
}

function getStore() {
  if (!singleton) singleton = createDefaultStore();
  return singleton;
}

module.exports = { getStore, makeFileStore, makePgStore, NOTIFIED_CAP };
