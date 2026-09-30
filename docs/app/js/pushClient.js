/**
 * Push-notifications client: the device half of server-driven alerts for
 * followed routes (see backend/src/push.js + /api/push/register).
 *
 * Uses @capacitor/push-notifications if the native shell has it. On the
 * web / without the plugin it's a no-op -- routeAlerts.js already covers
 * foreground notifications there. Registration gets an FCM device token,
 * which we send to our backend together with the raw route ids the rider
 * follows; the backend pushes when an alert hits one of those routes even
 * while the app is closed.
 *
 * Requires the app's own Firebase setup on the native side (google-services.json
 * + the Firebase gradle plugin) and FCM_SERVICE_ACCOUNT on the server --
 * see README "Push notifications server". Everything here is guarded, so a
 * missing plugin or denied permission never throws.
 */
(function (global) {
  let currentToken = null;
  let listenersAdded = false;

  function plugin() {
    return (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.PushNotifications) || null;
  }

  async function followedRawIds() {
    try { return (await TheBusStorage.getFollowedRoutes()).map((r) => r.rawId); }
    catch (e) { return []; }
  }

  async function postRegistration(token) {
    if (!token) return;
    const base = (global.TheBusSync && TheBusSync.API_BASE) ? TheBusSync.API_BASE : '';
    const routes = await followedRawIds();
    try {
      await fetch(`${base}/api/push/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, routes }),
      });
    } catch (e) { /* best-effort; re-tried on next sync */ }
  }

  function ensureListeners(p) {
    if (listenersAdded) return;
    listenersAdded = true;
    try {
      p.addListener('registration', (t) => { currentToken = t && t.value; postRegistration(currentToken); });
      p.addListener('registrationError', () => { /* leave web/local notifications to cover it */ });
    } catch (e) { /* ignore */ }
  }

  /** Boot: wire listeners and, if permission is already granted, register. */
  async function init() {
    const p = plugin();
    if (!p) return;
    ensureListeners(p);
    try {
      const perm = await p.checkPermissions();
      if (perm && perm.receive === 'granted') await p.register();
    } catch (e) { /* ignore */ }
  }

  /** Called from a user gesture (following a route): request permission then register. */
  async function enable() {
    const p = plugin();
    if (!p) return;
    ensureListeners(p);
    try {
      const perm = await p.requestPermissions();
      if (perm && perm.receive === 'granted') await p.register();
    } catch (e) { /* ignore */ }
  }

  /** Re-send the current token with the latest followed-routes set (after a follow/unfollow). */
  async function sync() {
    if (currentToken) postRegistration(currentToken);
  }

  global.TheBusPushClient = { init, enable, sync };
})(typeof window !== 'undefined' ? window : this);
