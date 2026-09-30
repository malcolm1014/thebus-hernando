/**
 * Arrival reminders ("buzz me when my bus is ~N minutes from this stop").
 *
 * The rider sets a reminder on a stop (see liveMap.js's stop popup); this
 * module polls that stop's live arrival predictions (GET /api/predictions,
 * GTFS-RT trip updates -- HART today) and fires a LOCAL notification the
 * moment a bus comes within the reminder's threshold, then clears the
 * reminder (one-shot). Delivery reuses routeAlerts.js's deliver()/permission
 * layer (Capacitor LocalNotifications -> Web Notifications -> nothing).
 *
 * Honest scope, same as routeAlerts.js: this is FOREGROUND-oriented. The
 * poll runs while the app is open (or backgrounded but not killed). True
 * "app fully closed" delivery would need the server to track per-device
 * reminders and push them (FCM) -- a bigger piece deliberately left for
 * later. The realistic case works: a rider waiting for a bus sets a reminder
 * and gets buzzed as it approaches without staring at the screen.
 */
(function (global) {
  function apiBase() {
    return (global.TheBusSync && TheBusSync.API_BASE) ? TheBusSync.API_BASE : '';
  }

  /**
   * Pure: given reminders and a map of stopId -> predictions array (each
   * prediction has a numeric `minutesUntil`), return the reminders whose
   * soonest upcoming arrival is at or under their threshold. Exposed for
   * tests and kept free of any I/O.
   */
  function dueReminders(reminders, predictionsByStop) {
    const due = [];
    for (const r of reminders || []) {
      const preds = (predictionsByStop && predictionsByStop[String(r.stopId)]) || [];
      const soonest = preds
        .map((p) => p && p.minutesUntil)
        .filter((m) => typeof m === 'number' && Number.isFinite(m) && m >= 0)
        .sort((a, b) => a - b)[0];
      if (soonest != null && soonest <= r.minutesBefore) {
        due.push({ reminder: r, minutesUntil: soonest });
      }
    }
    return due;
  }

  async function fetchPredictions(stopId) {
    try {
      const res = await fetch(`${apiBase()}/api/predictions?stop=${encodeURIComponent(stopId)}`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.predictions) ? data.predictions : [];
    } catch (e) {
      return [];
    }
  }

  let timer = null;

  /** One poll: fetch predictions for every active reminder, fire + clear the due ones. Never throws. */
  async function checkOnce() {
    let reminders = [];
    try { reminders = await TheBusStorage.getReminders(); } catch (e) { reminders = []; }
    if (!reminders.length) { stop(); return; } // nothing to watch -> idle
    if (global.navigator && navigator.onLine === false) return;

    const byStop = {};
    await Promise.all(reminders.map(async (r) => {
      byStop[String(r.stopId)] = await fetchPredictions(r.stopId);
    }));

    const due = dueReminders(reminders, byStop);
    for (const d of due) {
      const when = d.minutesUntil <= 0 ? 'now' : `in about ${d.minutesUntil} min`;
      const title = 'Bus approaching';
      const body = `A bus is arriving ${when} at ${d.reminder.stopName}.`;
      try {
        if (global.TheBusRouteAlerts && TheBusRouteAlerts.deliver) await TheBusRouteAlerts.deliver(title, body);
      } catch (e) { /* delivery is best-effort */ }
      try { await TheBusStorage.removeReminder(d.reminder.stopId); } catch (e) { /* ignore */ }
    }
  }

  /** Start polling (idempotent). Runs one check immediately, then every intervalMs. */
  function start(intervalMs = 30000) {
    if (timer) return;
    checkOnce();
    timer = setInterval(checkOnce, intervalMs);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /** Ask for notification permission (reuses routeAlerts.js's layered request). */
  async function requestPermission() {
    if (global.TheBusRouteAlerts && TheBusRouteAlerts.requestPermission) {
      return TheBusRouteAlerts.requestPermission();
    }
  }

  global.TheBusReminders = { dueReminders, checkOnce, start, stop, requestPermission };
})(typeof window !== 'undefined' ? window : this);
