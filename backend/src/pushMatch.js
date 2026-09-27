/**
 * Pure alert->device matching for push notifications, factored out of the
 * registry so it's fully testable and independent of where devices/notified
 * history are stored (file or Postgres, see pushStore.js).
 */

/**
 * @param {Array<{token, routes: string[]}>} devices
 * @param {Set<string>} notified - keys "<alertId>|<token>" already pushed
 * @param {Array<{id, routes, header, description, effect}>} alerts
 * @returns {{ sends: Array<{token, alertId, title, body}>, newKeys: string[] }}
 *   sends = notifications to deliver now; newKeys = notified keys to persist.
 *   Does NOT mutate `notified` (the caller records newKeys).
 */
function matchAlerts(devices, notified, alerts) {
  const sends = [];
  const newKeys = [];
  if (!Array.isArray(devices) || !Array.isArray(alerts)) return { sends, newKeys };
  const seen = notified instanceof Set ? notified : new Set();

  for (const dev of devices) {
    const followed = new Set((dev.routes || []).map(String));
    if (followed.size === 0) continue;
    for (const alert of alerts) {
      if (!alert || alert.id == null) continue;
      const routes = Array.isArray(alert.routes) ? alert.routes.map(String) : [];
      const hitRoute = routes.find((r) => followed.has(r));
      if (!hitRoute) continue;
      const key = `${alert.id}|${dev.token}`;
      if (seen.has(key) || newKeys.includes(key)) continue;
      newKeys.push(key);
      const effect = alert.effect && alert.effect !== 'UNKNOWN_EFFECT'
        ? String(alert.effect).replace(/_/g, ' ')
        : 'Service alert';
      sends.push({
        token: dev.token,
        alertId: alert.id,
        title: `Route ${hitRoute}: ${effect}`,
        body: alert.header || alert.description || 'Tap for details.',
      });
    }
  }
  return { sends, newKeys };
}

module.exports = { matchAlerts };
