/**
 * Startup sync: if a network is available, compare the server's dataset
 * version against what's cached locally and pull a fresh copy only when
 * it's newer. Otherwise -- or on any failure -- fall straight through to
 * whatever is already on disk, so the app is always usable offline.
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
   * @returns {Promise<{data: object|null, status: 'synced'|'cached'|'offline'|'empty'}>}
   */
  async function syncData(onStatus) {
    const report = (msg) => { if (onStatus) onStatus(msg); };

    if (!navigator.onLine) {
      report('OFFLINE -- USING CACHED DATA');
      const cached = await TheBusStorage.loadDataset();
      return { data: cached, status: cached ? 'cached' : 'empty' };
    }

    try {
      report('CHECKING FOR DATASET UPDATES...');
      const versionRes = await fetchWithTimeout(`${API_BASE}/api/version`, 5000);
      if (!versionRes.ok) throw new Error(`version check HTTP ${versionRes.status}`);
      const { version: remoteVersion } = await versionRes.json();
      const localVersion = await TheBusStorage.getLocalVersion();

      if (remoteVersion && remoteVersion === localVersion) {
        report('DATASET UP TO DATE');
        const cached = await TheBusStorage.loadDataset();
        return { data: cached, status: 'cached' };
      }

      report('DOWNLOADING UPDATED SCHEDULE DATA...');
      const downloadRes = await fetchWithTimeout(`${API_BASE}/api/download`, 15000);
      if (!downloadRes.ok) throw new Error(`download HTTP ${downloadRes.status}`);
      const text = await downloadRes.text();
      const parsed = JSON.parse(text);

      await TheBusStorage.saveDataset(text);
      await TheBusStorage.setLocalVersion(parsed.version);
      report('DATASET SYNCED');
      return { data: parsed, status: 'synced' };
    } catch (err) {
      report('SYNC FAILED -- FALLING BACK TO CACHE');
      const cached = await TheBusStorage.loadDataset();
      return { data: cached, status: cached ? 'cached' : 'empty' };
    }
  }

  global.TheBusSync = { syncData, API_BASE };
})(window);
