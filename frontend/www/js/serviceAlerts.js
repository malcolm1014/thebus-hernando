/**
 * Service alerts banner. Fetches active GTFS-Realtime alerts (detours,
 * cancellations, stop closures) from the backend's /api/service-alerts
 * proxy (HART via Swiftly, see backend/src/swiftlyGtfsRt.js) and shows
 * them across the top of the app. This is the single most-cited
 * rider-trust feature: telling people when the bus ISN'T coming as
 * scheduled.
 *
 * Requires network, but degrades to nothing: offline, on error, or when
 * no alerts are active (or no feed is configured server-side), the banner
 * simply stays hidden -- exactly the app's behavior before this existed.
 * Dismissed alerts are remembered per-device so a rider isn't nagged by
 * the same notice every launch; a genuinely new alert still shows.
 */
(function (global) {
  const DISMISSED_KEY = 'tribus_dismissed_alerts';
  let containerEl = null;
  let latest = [];

  function readDismissed() {
    try {
      const raw = global.localStorage && localStorage.getItem(DISMISSED_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) {
      return new Set();
    }
  }

  function writeDismissed(set) {
    try {
      if (global.localStorage) localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set]));
    } catch (e) { /* private mode / blocked storage -- dismissal just won't persist */ }
  }

  function dismiss(id) {
    const set = readDismissed();
    set.add(id);
    writeDismissed(set);
    render();
  }

  function render() {
    if (!containerEl) return;
    const dismissed = readDismissed();
    const show = latest.filter((a) => a.id == null || !dismissed.has(a.id));

    containerEl.textContent = '';
    if (show.length === 0) {
      containerEl.hidden = true;
      return;
    }
    containerEl.hidden = false;

    show.forEach((alert) => {
      const row = document.createElement('div');
      row.className = 'alert-row';

      const body = document.createElement('div');
      body.className = 'alert-body';

      const head = document.createElement('div');
      head.className = 'alert-head';
      // GTFS-RT effect (DETOUR, NO_SERVICE, ...) as a short tag, if present.
      const effect = alert.effect && alert.effect !== 'UNKNOWN_EFFECT'
        ? String(alert.effect).replace(/_/g, ' ').toUpperCase()
        : '';
      head.textContent = `⚠ ${effect ? '[' + effect + '] ' : ''}${(alert.header || 'SERVICE ALERT').toUpperCase()}`;
      body.appendChild(head);

      if (alert.description && alert.description.trim() && alert.description !== alert.header) {
        const desc = document.createElement('div');
        desc.className = 'alert-desc';
        desc.textContent = alert.description.toUpperCase();
        body.appendChild(desc);
      }

      if (alert.url && /^https?:\/\//i.test(alert.url)) {
        const link = document.createElement('a');
        link.className = 'alert-link';
        link.href = alert.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'MORE INFO';
        body.appendChild(link);
      }
      row.appendChild(body);

      if (alert.id != null) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'alert-dismiss';
        x.setAttribute('aria-label', 'Dismiss alert');
        x.textContent = 'X';
        x.addEventListener('click', () => dismiss(alert.id));
        row.appendChild(x);
      }

      containerEl.appendChild(row);
    });
  }

  async function refresh() {
    if (!global.navigator || !navigator.onLine) return;
    const base = global.TheBusSync && TheBusSync.API_BASE ? TheBusSync.API_BASE : '';
    try {
      const res = await fetch(`${base}/api/service-alerts`);
      if (!res.ok) return;
      const data = await res.json();
      latest = Array.isArray(data.alerts) ? data.alerts : [];
      render();
    } catch (e) {
      // Best-effort: a failed alerts fetch never disrupts the app.
    }
  }

  /** Wires the banner to its container and does a first fetch; re-checks periodically (alerts change slowly). */
  function init(container, { pollMs = 5 * 60 * 1000 } = {}) {
    containerEl = container;
    if (!containerEl) return;
    render();
    refresh();
    if (pollMs > 0 && global.setInterval) {
      setInterval(() => { if (navigator.onLine) refresh(); }, pollMs);
    }
    // A device coming back online should re-check promptly.
    if (global.addEventListener) global.addEventListener('online', refresh);
  }

  global.TheBusServiceAlerts = { init, refresh, render, _setForTesting: (a) => { latest = a; } };
})(typeof window !== 'undefined' ? window : this);
