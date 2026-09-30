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
  const SAVED_TRIPS_KEY = 'thebus_saved_trips';
  const TRIP_PREFS_KEY = 'thebus_trip_prefs';
  const FOLLOWED_ROUTES_KEY = 'thebus_followed_routes';
  const HIGH_CONTRAST_KEY = 'thebus_high_contrast';
  const REMINDERS_KEY = 'thebus_arrival_reminders';
  const FAVORITE_STOPS_KEY = 'thebus_favorite_stops';
  const LANG_KEY = 'thebus_lang';

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

  // ---- Small JSON blob helper (Preferences in the native shell,
  // localStorage on the web) -- used for the saved-trips list and the
  // trip-planner preferences. Same store/size profile as search memory. ----
  async function getJson(key, fallback) {
    try {
      let raw;
      if (Preferences) ({ value: raw } = await Preferences.get({ key }));
      else raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      return fallback;
    }
  }
  async function setJson(key, value) {
    const json = JSON.stringify(value);
    if (Preferences) await Preferences.set({ key, value: json });
    else localStorage.setItem(key, json);
  }

  /** Saved trips: an array of { from, to, savedAt } the rider can re-plan in one tap. Newest first, capped so it can't grow without bound. */
  async function getSavedTrips() {
    const list = await getJson(SAVED_TRIPS_KEY, []);
    return Array.isArray(list) ? list : [];
  }
  async function addSavedTrip(trip) {
    const from = (trip && trip.from ? String(trip.from) : '').trim();
    const to = (trip && trip.to ? String(trip.to) : '').trim();
    if (!from || !to) return getSavedTrips();
    const existing = await getSavedTrips();
    // De-dupe on the same from/to (case-insensitive); newest entry wins.
    const key = `${from.toLowerCase()}\u0000${to.toLowerCase()}`;
    const filtered = existing.filter((t) => `${String(t.from).toLowerCase()}\u0000${String(t.to).toLowerCase()}` !== key);
    const next = [{ from, to, savedAt: Date.now() }, ...filtered].slice(0, 12);
    await setJson(SAVED_TRIPS_KEY, next);
    return next;
  }
  async function removeSavedTrip(from, to) {
    const key = `${String(from).toLowerCase()}\u0000${String(to).toLowerCase()}`;
    const next = (await getSavedTrips()).filter((t) => `${String(t.from).toLowerCase()}\u0000${String(t.to).toLowerCase()}` !== key);
    await setJson(SAVED_TRIPS_KEY, next);
    return next;
  }

  /** Trip-planner preferences: { fewerTransfers, lessWalking, wheelchair } booleans. */
  async function getTripPrefs() {
    const p = await getJson(TRIP_PREFS_KEY, {});
    return {
      fewerTransfers: !!(p && p.fewerTransfers),
      lessWalking: !!(p && p.lessWalking),
      wheelchair: !!(p && p.wheelchair),
      bikeShare: !!(p && p.bikeShare),
    };
  }
  async function setTripPrefs(prefs) {
    await setJson(TRIP_PREFS_KEY, {
      fewerTransfers: !!prefs.fewerTransfers,
      lessWalking: !!prefs.lessWalking,
      wheelchair: !!prefs.wheelchair,
      bikeShare: !!prefs.bikeShare,
    });
  }

  /** Followed routes (for service-alert notifications): array of { id, rawId, shortName, agencyId }. */
  async function getFollowedRoutes() {
    const list = await getJson(FOLLOWED_ROUTES_KEY, []);
    return Array.isArray(list) ? list : [];
  }
  async function isRouteFollowed(id) {
    return (await getFollowedRoutes()).some((r) => r.id === id);
  }
  async function addFollowedRoute(route) {
    if (!route || !route.id) return getFollowedRoutes();
    const existing = await getFollowedRoutes();
    if (existing.some((r) => r.id === route.id)) return existing;
    const next = [{ id: route.id, rawId: route.rawId || route.id, shortName: route.shortName || route.id, agencyId: route.agencyId || null }, ...existing].slice(0, 50);
    await setJson(FOLLOWED_ROUTES_KEY, next);
    return next;
  }
  async function removeFollowedRoute(id) {
    const next = (await getFollowedRoutes()).filter((r) => r.id !== id);
    await setJson(FOLLOWED_ROUTES_KEY, next);
    return next;
  }

  /**
   * Arrival reminders: array of { stopId, stopName, minutesBefore, createdAt }.
   * One reminder per stop (keyed by stopId) is plenty -- "buzz me when a bus
   * is ~N minutes from THIS stop." reminders.js polls live predictions and
   * fires a local notification when one comes due.
   */
  async function getReminders() {
    const list = await getJson(REMINDERS_KEY, []);
    return Array.isArray(list) ? list : [];
  }
  async function isReminderSet(stopId) {
    return (await getReminders()).some((r) => String(r.stopId) === String(stopId));
  }
  async function addReminder(reminder) {
    if (!reminder || reminder.stopId == null) return getReminders();
    const stopId = String(reminder.stopId);
    const existing = (await getReminders()).filter((r) => String(r.stopId) !== stopId);
    const minutesBefore = Number.isFinite(reminder.minutesBefore) ? reminder.minutesBefore : 5;
    const next = [{ stopId, stopName: reminder.stopName || stopId, minutesBefore, createdAt: Date.now() }, ...existing].slice(0, 25);
    await setJson(REMINDERS_KEY, next);
    return next;
  }
  async function removeReminder(stopId) {
    const next = (await getReminders()).filter((r) => String(r.stopId) !== String(stopId));
    await setJson(REMINDERS_KEY, next);
    return next;
  }

  /** Favorite stops: array of { stopId, name, savedAt }, newest first. Powers the "favorites" departures board. */
  async function getFavoriteStops() {
    const list = await getJson(FAVORITE_STOPS_KEY, []);
    return Array.isArray(list) ? list : [];
  }
  async function isFavoriteStop(stopId) {
    return (await getFavoriteStops()).some((s) => String(s.stopId) === String(stopId));
  }
  async function addFavoriteStop(stop) {
    if (!stop || stop.stopId == null) return getFavoriteStops();
    const stopId = String(stop.stopId);
    const existing = (await getFavoriteStops()).filter((s) => String(s.stopId) !== stopId);
    const next = [{ stopId, name: stop.name || stopId, savedAt: Date.now() }, ...existing].slice(0, 30);
    await setJson(FAVORITE_STOPS_KEY, next);
    return next;
  }
  async function removeFavoriteStop(stopId) {
    const next = (await getFavoriteStops()).filter((s) => String(s.stopId) !== String(stopId));
    await setJson(FAVORITE_STOPS_KEY, next);
    return next;
  }

  /** UI language ('en' | 'es'). Defaults to 'en'. */
  async function getLang() {
    let value;
    if (Preferences) ({ value } = await Preferences.get({ key: LANG_KEY }));
    else value = global.localStorage ? localStorage.getItem(LANG_KEY) : null;
    return value === 'es' ? 'es' : 'en';
  }
  async function setLang(lang) {
    const value = lang === 'es' ? 'es' : 'en';
    if (Preferences) await Preferences.set({ key: LANG_KEY, value });
    else if (global.localStorage) localStorage.setItem(LANG_KEY, value);
  }

  /** High-contrast accessibility mode (opt-in; defaults off -- the retro look is the app's identity). */
  async function getHighContrast() {
    let value;
    if (Preferences) ({ value } = await Preferences.get({ key: HIGH_CONTRAST_KEY }));
    else value = localStorage.getItem(HIGH_CONTRAST_KEY);
    return value === 'true';
  }
  async function setHighContrast(enabled) {
    const value = String(!!enabled);
    if (Preferences) await Preferences.set({ key: HIGH_CONTRAST_KEY, value });
    else localStorage.setItem(HIGH_CONTRAST_KEY, value);
  }

  global.TheBusStorage = {
    getLocalVersion, setLocalVersion, saveDataset, loadDataset, loadBundledSnapshot,
    getLastSyncedAt, setLastSyncedAt,
    getSearchMemory, saveSearchMemory,
    getOnboardingSeen, setOnboardingSeen,
    getEffectsEnabled, setEffectsEnabled,
    getSavedTrips, addSavedTrip, removeSavedTrip,
    getTripPrefs, setTripPrefs,
    getFollowedRoutes, isRouteFollowed, addFollowedRoute, removeFollowedRoute,
    getReminders, isReminderSet, addReminder, removeReminder,
    getFavoriteStops, isFavoriteStop, addFavoriteStop, removeFavoriteStop,
    getLang, setLang,
    getHighContrast, setHighContrast,
  };
})(window);
