/**
 * Notifies a rider when a service alert affects a route they follow.
 *
 * Delivery is layered, best-effort, and honest about platform limits:
 *   1. Capacitor LocalNotifications plugin, if the native shell has it
 *      installed -- the only path that can notify while the app is closed.
 *      Feature-detected; if the plugin isn't present this is simply skipped
 *      (adding @capacitor/local-notifications + `npx cap sync` upgrades to
 *      real local notifications with no other code change here).
 *   2. The Web Notifications API, when permission is granted -- works in
 *      the browser/PWA and some webviews while the app is open.
 *   3. Always: the in-app alerts banner already shows the alert, so a
 *      matched alert is never silently lost even if 1 and 2 are unavailable.
 *
 * This is foreground-oriented by default: true background push (server ->
 * device while the app is closed) needs a push service (FCM/APNs) and a
 * server component, which this app deliberately doesn't run. Following a
 * route + local notifications covers the realistic case: the rider has the
 * app and we warn them about disruptions to the routes they care about.
 *
 * De-duped by alert id (persisted), so a long-running alert notifies once,
 * not on every 5-minute refresh or every app launch.
 */
(function (global) {
  const NOTIFIED_KEY = 'tribus_notified_alert_ids';
  const NOTIFIED_CAP = 200;

  function readNotified() {
    try {
      const raw = global.localStorage && localStorage.getItem(NOTIFIED_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) { return new Set(); }
  }
  function writeNotified(set) {
    try {
      if (global.localStorage) localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...set].slice(-NOTIFIED_CAP)));
    } catch (e) { /* ignore */ }
  }

  const CHANNEL_ID = 'service-alerts';

  function capacitorLocalNotifications() {
    return (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.LocalNotifications) || null;
  }

  /** Create the Android notification channel once (Android 8+ needs one for local notifications to show). No-op without the plugin. */
  async function init() {
    const ln = capacitorLocalNotifications();
    if (ln && ln.createChannel) {
      try {
        await ln.createChannel({
          id: CHANNEL_ID,
          name: 'Service alerts',
          description: 'Alerts for routes you follow',
          importance: 4, // HIGH -- these are time-sensitive disruptions
        });
      } catch (e) { /* older Android / plugin quirk -- default channel still works */ }
    }
  }

  /** Ask for notification permission from a user gesture (e.g. when a route is first followed). Safe to call repeatedly. */
  async function requestPermission() {
    const ln = capacitorLocalNotifications();
    if (ln && ln.requestPermissions) {
      try { await ln.requestPermissions(); return; } catch (e) { /* fall through to web */ }
    }
    try {
      if (global.Notification && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
    } catch (e) { /* not available -- in-app banner still covers it */ }
  }

  async function deliver(title, body) {
    const ln = capacitorLocalNotifications();
    if (ln && ln.schedule) {
      try {
        await ln.schedule({ notifications: [{ id: Date.now() % 2147483647, title, body, channelId: CHANNEL_ID }] });
        return true;
      } catch (e) { /* fall through */ }
    }
    try {
      if (global.Notification && Notification.permission === 'granted') {
        // eslint-disable-next-line no-new
        new Notification(title, { body });
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /**
   * Given the latest alerts, notify once for each that newly affects a
   * followed route. `alerts` items look like serviceAlerts.js emits:
   * { id, header, effect, routes: [rawRouteId...] }.
   */
  async function onAlerts(alerts) {
    if (!Array.isArray(alerts) || alerts.length === 0) return;
    let followed = [];
    try { followed = await TheBusStorage.getFollowedRoutes(); } catch (e) { followed = []; }
    if (!followed.length) return;

    const followedRaw = new Map(); // rawId -> shortName
    followed.forEach((r) => followedRaw.set(String(r.rawId), r.shortName || r.rawId));

    const notified = readNotified();
    let changed = false;

    for (const alert of alerts) {
      if (!alert || alert.id == null) continue;
      const routes = Array.isArray(alert.routes) ? alert.routes.map(String) : [];
      const hit = routes.find((r) => followedRaw.has(r));
      if (!hit) continue;
      if (notified.has(alert.id)) continue;

      const routeLabel = followedRaw.get(hit);
      const effect = alert.effect && alert.effect !== 'UNKNOWN_EFFECT' ? alert.effect.replace(/_/g, ' ') : 'Service alert';
      const title = `Route ${routeLabel}: ${effect}`;
      const body = alert.header || alert.description || 'Tap for details.';
      await deliver(title, body);
      notified.add(alert.id);
      changed = true;
    }
    if (changed) writeNotified(notified);
  }

  global.TheBusRouteAlerts = { init, onAlerts, requestPermission, deliver };
})(typeof window !== 'undefined' ? window : this);
