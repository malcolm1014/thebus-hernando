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
  const ONBOARDING_KEY = 'thebus_onboarding_seen';
  const LAST_SYNCED_KEY = 'thebus_last_synced_at';
  const EFFECTS_ENABLED_KEY = 'thebus_effects_enabled';

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

  /**
   * When this device last successfully contacted the backend and
   * confirmed a dataset version -- whether or not that check found
   * anything new to download. This is the rider-trust signal ("has this
   * app actually checked in with reality recently"), deliberately
   * separate from the dataset's own `generatedAt` field: a schedule can
   * validly go unchanged for months (nothing wrong with that), but a
   * phone that hasn't successfully reached the server in weeks is a real
   * warning sign regardless of whether the data it's showing happens to
   * still be correct.
   */
  async function getLastSyncedAt() {
    let value;
    if (Preferences) {
      ({ value } = await Preferences.get({ key: LAST_SYNCED_KEY }));
    } else {
      value = localStorage.getItem(LAST_SYNCED_KEY);
    }
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  async function setLastSyncedAt(epochMs) {
    const value = String(epochMs);
    if (Preferences) {
      await Preferences.set({ key: LAST_SYNCED_KEY, value });
    } else {
      localStorage.setItem(LAST_SYNCED_KEY, value);
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
      // File not found on first-ever launch before any sync has run,
      // or a corrupt cache -- either way, caller falls back to the
      // bundled snapshot via loadBundledSnapshot().
      return null;
    }
  }

  /**
   * A real schedule-data snapshot bundled inside the app itself
   * (www/data/transit_data.snapshot.json, regenerated at release time by
   * `npm run refresh:snapshot` -- see frontend/scripts/refresh-snapshot.js).
   * Used only as the FIRST-EVER-LAUNCH fallback, before any on-device
   * cache exists: fetched as a plain local asset (same-origin, works with
   * zero network -- Capacitor serves www/ from a local scheme), so a
   * fresh install can answer real questions instantly instead of showing
   * "NO DATA AVAILABLE" while it waits on a possibly-sleeping backend.
   * Once a real sync succeeds, TheBusStorage.saveDataset() takes over and
   * this is never consulted again for that install.
   */
  async function loadBundledSnapshot() {
    try {
      const res = await fetch('data/transit_data.snapshot.json');
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      return null; // shouldn't happen for a correctly-built app, but never fatal
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

  /** Whether the first-launch onboarding (location prompt + how-to-use) has already been shown and dismissed -- so it only ever appears once, not on every app launch. */
  async function getOnboardingSeen() {
    if (Preferences) {
      const { value } = await Preferences.get({ key: ONBOARDING_KEY });
      return value === 'true';
    }
    return localStorage.getItem(ONBOARDING_KEY) === 'true';
  }

  async function setOnboardingSeen() {
    if (Preferences) {
      await Preferences.set({ key: ONBOARDING_KEY, value: 'true' });
    } else {
      localStorage.setItem(ONBOARDING_KEY, 'true');
    }
  }

  /**
   * Whether the CRT flicker/scanline/bloom effects are on -- independent
   * of (and layered on top of) the OS's prefers-reduced-motion setting,
   * so a rider can turn them off without that being a system-wide
   * change, and without needing to know prefers-reduced-motion exists at
   * all. Defaults to on (undefined/missing == true) -- the terminal look
   * is the app's identity; this is an opt-out, not an opt-in.
   */
  async function getEffectsEnabled() {
    let value;
    if (Preferences) {
      ({ value } = await Preferences.get({ key: EFFECTS_ENABLED_KEY }));
    } else {
      value = localStorage.getItem(EFFECTS_ENABLED_KEY);
    }
    return value !== 'false';
  }

  async function setEffectsEnabled(enabled) {
    const value = String(!!enabled);
    if (Preferences) {
      await Preferences.set({ key: EFFECTS_ENABLED_KEY, value });
    } else {
      localStorage.setItem(EFFECTS_ENABLED_KEY, value);
    }
  }

  global.TheBusStorage = {
    getLocalVersion, setLocalVersion, saveDataset, loadDataset, loadBundledSnapshot,
    getLastSyncedAt, setLastSyncedAt,
    getSearchMemory, saveSearchMemory,
    getOnboardingSeen, setOnboardingSeen,
    getEffectsEnabled, setEffectsEnabled,
  };
})(window);
