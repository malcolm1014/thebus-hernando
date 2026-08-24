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

  global.TheBusStorage = { getLocalVersion, setLocalVersion, saveDataset, loadDataset };
})(window);
