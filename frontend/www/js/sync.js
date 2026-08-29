/**
 * Two separate jobs, deliberately kept apart so the app is never waiting
 * on the network to show something real:
 *
 *   getInitialData()  -- INSTANT, no network. Whatever's already on disk
 *                         from a prior sync, or -- on a first-ever launch
 *                         with nothing synced yet -- the real schedule
 *                         snapshot bundled inside the app itself
 *                         (see storage.js's loadBundledSnapshot()).
 *                         Call this first and render immediately.
 *
 *   checkForUpdate()   -- may hit the network, may take up to a minute if
 *                         Render's free tier has spun the backend down.
 *                         Call this AFTER something is already on screen,
 *                         never before -- its only job is finding
 *                         something newer than what's already showing,
 *                         and it's a no-op (data: null, updated: false)
 *                         whenever there isn't one, including "offline"
 *                         and "request failed" -- neither is a real
 *                         error from the rider's point of view, since
 *                         they're already looking at real data.
 */
(function (global) {
  // Point this at your deployed Render service.
  const API_BASE = 'https://thebus-hernando-backend.onrender.com';

  async function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @returns {Promise<{data: object|null, source: 'cache'|'bundled'|'none'}>}
   */
  async function getInitialData() {
    const cached = await TheBusStorage.loadDataset();
    if (cached) return { data: cached, source: 'cache' };

    const bundled = await TheBusStorage.loadBundledSnapshot();
    if (bundled) return { data: bundled, source: 'bundled' };

    // Only reachable if the on-device cache is empty/corrupt AND the
    // bundled snapshot is somehow missing/corrupt too -- shouldn't
    // happen for a correctly-built release (see refresh-snapshot.js),
    // but the caller still needs a defined fallback for it.
    return { data: null, source: 'none' };
  }

  /**
   * @returns {Promise<{data: object|null, updated: boolean}>}
   */
  async function checkForUpdate(onStatus) {
    const report = (msg) => { if (onStatus) onStatus(msg); };

    if (!navigator.onLine) return { data: null, updated: false };

    try {
      // The backend runs on Render's free tier, which spins the service
      // down after ~15 min idle -- waking it back up can take 50+
      // seconds. A short timeout here would fail almost every check
      // right after a period of no use. 60s comfortably covers a cold
      // start while barely affecting the common warm-instance case.
      // This no longer risks a blank first launch the way it used to --
      // getInitialData() has already put something real on screen
      // before this ever runs.
      report('CHECKING FOR DATASET UPDATES... (MAY TAKE UP TO A MINUTE IF THE SERVER WAS ASLEEP)');
      const versionRes = await fetchWithTimeout(`${API_BASE}/api/version`, 60000);
      if (!versionRes.ok) throw new Error(`version check HTTP ${versionRes.status}`);
      const { version: remoteVersion } = await versionRes.json();
      const localVersion = await TheBusStorage.getLocalVersion();

      if (remoteVersion && remoteVersion === localVersion) {
        // A real, successful contact with the server -- it just had
        // nothing new to offer. Still counts as "confirmed current" for
        // staleness-display purposes (see storage.js's getLastSyncedAt).
        await TheBusStorage.setLastSyncedAt(Date.now());
        return { data: null, updated: false };
      }

      report('DOWNLOADING UPDATED SCHEDULE DATA...');
      const downloadRes = await fetchWithTimeout(`${API_BASE}/api/download`, 60000);
      if (!downloadRes.ok) throw new Error(`download HTTP ${downloadRes.status}`);
      const text = await downloadRes.text();
      const parsed = JSON.parse(text);

      await TheBusStorage.saveDataset(text);
      await TheBusStorage.setLocalVersion(parsed.version);
      await TheBusStorage.setLastSyncedAt(Date.now());
      return { data: parsed, updated: true };
    } catch (err) {
      return { data: null, updated: false };
    }
  }

  global.TheBusSync = { getInitialData, checkForUpdate, API_BASE };
})(window);
