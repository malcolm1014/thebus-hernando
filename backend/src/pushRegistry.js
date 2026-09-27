/**
 * Device-token registry for push notifications: which devices want alerts
 * for which routes, and which (alert, device) pairs have already been pushed
 * (so a long-running alert notifies once, not every check).
 *
 * Backed by a real datastore when DATABASE_URL is set (Postgres, so tokens
 * survive cold starts/redeploys), else a best-effort JSON file -- see
 * src/pushStore.js. This module keeps a small in-memory cache for fast
 * matching and writes through to the store on every change; on boot it loads
 * the cache from the store, so a restart (or a fresh Postgres-backed
 * instance) comes up with the registered devices intact. The matching logic
 * itself is pure and datastore-agnostic (src/pushMatch.js).
 *
 * All methods are async (the store may be a database).
 */
const { getStore } = require('./pushStore');
const { matchAlerts } = require('./pushMatch');

const NOTIFIED_MEM_CAP = 5000;

let store = null;
const devices = new Map();      // token -> { routes: string[], updatedAt }
const notified = new Set();     // "<alertId>|<token>"
let loadPromise = null;

async function ensureLoaded() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    store = store || getStore();
    await store.init();
    const { devices: devs, notified: notifs } = await store.loadAll();
    devices.clear();
    notified.clear();
    for (const d of devs) devices.set(d.token, { routes: d.routes || [], updatedAt: d.updatedAt || 0 });
    for (const k of notifs) notified.add(k);
  })().catch((err) => {
    console.error('[pushRegistry] load failed, continuing with empty in-memory registry:', err.message);
    loadPromise = null; // allow a later retry
  });
  return loadPromise;
}

async function register(token, routes) {
  if (!token || typeof token !== 'string') return false;
  await ensureLoaded();
  const clean = Array.isArray(routes) ? [...new Set(routes.map(String))] : [];
  const updatedAt = Date.now();
  devices.set(token, { routes: clean, updatedAt });
  try { await store.putDevice(token, clean, updatedAt); } catch (e) { console.error('[pushRegistry] putDevice failed:', e.message); }
  return true;
}

async function unregister(token) {
  await ensureLoaded();
  const had = devices.delete(token);
  if (had) { try { await store.removeDevice(token); } catch (e) { console.error('[pushRegistry] removeDevice failed:', e.message); } }
  return had;
}

async function list() {
  await ensureLoaded();
  return [...devices.entries()].map(([token, v]) => ({ token, ...v }));
}

/**
 * Given the current active alerts, returns the notifications to deliver now
 * (a device whose followed routes intersect an alert's routes, not already
 * notified for that alert) and records them as notified.
 * @returns {Promise<Array<{token, alertId, title, body}>>}
 */
async function pendingSends(alerts) {
  await ensureLoaded();
  const deviceList = [...devices.entries()].map(([token, v]) => ({ token, routes: v.routes }));
  const { sends, newKeys } = matchAlerts(deviceList, notified, alerts);
  if (newKeys.length) {
    newKeys.forEach((k) => notified.add(k));
    // Bound the in-memory set so a long warm run can't grow it forever.
    if (notified.size > NOTIFIED_MEM_CAP) {
      const excess = notified.size - NOTIFIED_MEM_CAP;
      let i = 0;
      for (const k of notified) { if (i++ >= excess) break; notified.delete(k); }
    }
    try { await store.addNotified(newKeys); } catch (e) { console.error('[pushRegistry] addNotified failed:', e.message); }
  }
  return sends;
}

// Tests inject a fake store and reset state.
function __setStoreForTests(fake) { store = fake; devices.clear(); notified.clear(); loadPromise = null; }

module.exports = { register, unregister, list, pendingSends, ensureLoaded, __setStoreForTests };
