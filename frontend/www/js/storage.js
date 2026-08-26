/**
 * Persistence layer. Wraps Capacitor's Filesystem + Preferences plugins
 * when running in the native shell, and transparently falls back to
 * localStorage when running as a plain web page (e.g. `npx serve www`
 * during development, before `cap sync`). The rest of the app never
 * touches Capacitor or localStorage directly -- only this module does.
 */
(function (global) {
  const DATA_FILENAME = 'transit_data.json';
  const VERSION_KEY = 'thebus_data_version';
  const SEARCH_MEMORY_KEY = 'thebus_search_memory';

  const hasCapacitor = !!(global.Capacitor && global.Capacitor.Plugins);
  const Filesystem = hasCapacitor ? global.Capacitor.Plugins.Filesystem : null;
  const Preferences = hasCapacitor ? global.Capacitor.Plugins.Preferences : null;
  const Directory = hasCapacitor && global.CapacitorFilesystem
    ? global.CapacitorFilesystem.Directory
    : { Data: 'DATA' };

  async function getLocalVersion() {
    if (Preferences) {
      const { value } = await Preferences.get({ key: VERSION_KEY });
      return value || null;
    }
    return localStorage.getItem(VERSION_KEY);
  }

  async function setLocalVersion(version) {
    if (Preferences) {
      await Preferences.set({ key: VERSION_KEY, value: version });
    } else {
      localStorage.setItem(VERSION_KEY, version);
    }
  }

  async function saveDataset(jsonString) {
    if (Filesystem) {
      await Filesystem.writeFile({
        path: DATA_FILENAME,
        directory: Directory.Data,
        data: jsonString,
        encoding: 'utf8',
      });
    } else {
      localStorage.setItem(DATA_FILENAME, jsonString);
    }
  }

  async function loadDataset() {
    try {
      if (Filesystem) {
        const res = await Filesystem.readFile({
          path: DATA_FILENAME,
          directory: Directory.Data,
          encoding: 'utf8',
        });
        return JSON.parse(res.data);
      }
      const raw = localStorage.getItem(DATA_FILENAME);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      // File not found on first-ever launch before any sync has run.
      return null;
    }
  }

  /**
   * A small persisted JSON blob for the search index's learned tiers
   * (places geocoded before, phrases resolved before -- see
   * searchIndex.js). Kept in Preferences, not Filesystem: this stays
   * capped small (tens of KB) by design, unlike the full transit
   * dataset, so the lightweight key-value store is the right fit.
   */
  async function getSearchMemory() {
    try {
      if (Preferences) {
        const { value } = await Preferences.get({ key: SEARCH_MEMORY_KEY });
        return value ? JSON.parse(value) : null;
      }
      const raw = localStorage.getItem(SEARCH_MEMORY_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null; // corrupt/missing -- caller falls back to an empty index
    }
  }

  async function saveSearchMemory(memory) {
    const json = JSON.stringify(memory);
    if (Preferences) {
      await Preferences.set({ key: SEARCH_MEMORY_KEY, value: json });
    } else {
      localStorage.setItem(SEARCH_MEMORY_KEY, json);
    }
  }

  global.TheBusStorage = { getLocalVersion, setLocalVersion, saveDataset, loadDataset, getSearchMemory, saveSearchMemory };
})(window);
