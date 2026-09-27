/**
 * Device-token registry for push notifications: which devices want alerts
 * for which routes, and which (alert, device) pairs have already been
 * pushed (so a long-running alert notifies once, not every check).
 *
 * In-memory, with best-effort JSON persistence to the data dir so it
 * survives a process restart. It does NOT survive Render's free-tier idle
 * teardown (nothing on disk does -- see geocode.js's note), so on a cold
 * environment devices simply re-register on next app launch (the client
 * re-sends its token on boot). A production deployment would back this with
 * a real datastore; the pure matching logic here (pendingSends) is
 * datastore-agnostic.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const STORE_PATH = path.join(config.dataDir, 'push-registry.json');

// token -> { routes: string[] (raw agency route ids), updatedAt }
const devices = new Map();
// Set of "<alertId>|<token>" already pushed.
const notified = new Set();

function load() {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (raw && raw.devices) for (const [t, v] of Object.entries(raw.devices)) devices.set(t, v);
    if (raw && Array.isArray(raw.notified)) raw.notified.forEach((k) => notified.add(k));
  } catch (e) { /* corrupt/missing -- start empty */ }
}

function persist() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    // Cap the notified set so it can't grow without bound over a long warm run.
    const notifiedArr = [...notified].slice(-5000);
    fs.writeFileSync(STORE_PATH, JSON.stringify({ devices: Object.fromEntries(devices), notified: notifiedArr }));
  } catch (e) { /* best-effort; registry still works in memory */ }
}

let loaded = false;
function ensureLoaded() { if (!loaded) { load(); loaded = true; } }

function register(token, routes) {
  ensureLoaded();
  if (!token || typeof token !== 'string') return false;
  const clean = Array.isArray(routes) ? [...new Set(routes.map(String))] : [];
  devices.set(token, { routes: clean, updatedAt: Date.now() });
  persist();
  return true;
}

function unregister(token) {
  ensureLoaded();
  const had = devices.delete(token);
  if (had) persist();
  return had;
}

function list() {
  ensureLoaded();
  return [...devices.entries()].map(([token, v]) => ({ token, ...v }));
}

/**
 * Given the current active alerts, returns the (token, alert) pairs that
 * should be pushed now -- a device whose followed routes intersect an
 * alert's routes, that hasn't already been notified for that alert -- and
 * marks them notified. Pure over the in-memory state (no network).
 * @param {Array<{id,routes,header,description,effect}>} alerts
 * @returns {Array<{token, alertId, title, body}>}
 */
function pendingSends(alerts) {
  ensureLoaded();
  const out = [];
  if (!Array.isArray(alerts)) return out;
  for (const [token, dev] of devices) {
    const followed = new Set(dev.routes || []);
    if (followed.size === 0) continue;
    for (const alert of alerts) {
      if (!alert || alert.id == null) continue;
      const routes = Array.isArray(alert.routes) ? alert.routes.map(String) : [];
      const hitRoute = routes.find((r) => followed.has(r));
      if (!hitRoute) continue;
      const key = `${alert.id}|${token}`;
      if (notified.has(key)) continue;
      notified.add(key);
      const effect = alert.effect && alert.effect !== 'UNKNOWN_EFFECT' ? String(alert.effect).replace(/_/g, ' ') : 'Service alert';
      out.push({
        token,
        alertId: alert.id,
        title: `Route ${hitRoute}: ${effect}`,
        body: alert.header || alert.description || 'Tap for details.',
      });
    }
  }
  if (out.length) persist();
  return out;
}

function resetForTests() { devices.clear(); notified.clear(); loaded = true; }

module.exports = { register, unregister, list, pendingSends, resetForTests, STORE_PATH };
