/**
 * TIER 2 and TIER 3 of the app's 3-tier search architecture:
 *
 *   TIER 1 -- GTFS (queryEngine.js's `index.stops`/`index.routes`):
 *     authoritative, ships with the app, always present.
 *   TIER 2 -- PLACES (this file): real-world places the geocoder has
 *     resolved before (a business, school, landmark) -- persisted on
 *     the device and grown from actual use, so a place looked up once
 *     answers instantly and offline every time after.
 *   TIER 3 -- LANGUAGE (this file): a learned phrase->answer cache. The
 *     first time any exact phrase resolves confidently (to a Tier 1
 *     stop or a Tier 2 place), that phrase is remembered -- the same
 *     literal question next time is an instant, guaranteed-consistent
 *     hit, no fuzzy matching or network involved. This is the same
 *     "search-log caching" idea real search engines use for repeat
 *     queries, not a hand-guessed slang dictionary -- it only ever
 *     contains phrasing an actual rider actually typed.
 *
 * Both tiers are capped (LRU eviction by last-used time) so they can't
 * grow unbounded over months of use, and both are stored as one small
 * JSON blob via TheBusStorage (Preferences-backed) -- loaded once per
 * app launch, then kept warm in memory for the rest of the session.
 */
(function (global) {
  const PLACES_CAP = 200;
  const ALIASES_CAP = 300;

  let memory = null; // { places: [{id,name,lat,lon,lastUsedAt,hitCount}], aliases: {[key]: {kind,id,name,lastUsedAt}} } | null before ensureLoaded()
  let loadingPromise = null;

  function emptyMemory() {
    return { places: [], aliases: {} };
  }

  async function ensureLoaded() {
    if (memory) return;
    if (!loadingPromise) {
      loadingPromise = (async () => {
        let loaded = null;
        try {
          loaded = await TheBusStorage.getSearchMemory();
        } catch (err) {
          console.error(err);
        }
        memory = (loaded && Array.isArray(loaded.places) && loaded.aliases) ? loaded : emptyMemory();
      })();
    }
    await loadingPromise;
  }

  /** Never awaited by callers -- a cache write shouldn't slow down the answer the rider is waiting on. In-memory `memory` is already updated synchronously by the time this runs. */
  function persist() {
    TheBusStorage.saveSearchMemory(memory).catch((err) => console.error(err));
  }

  function evictLru(list, cap) {
    if (list.length <= cap) return list;
    return [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, cap);
  }

  /** TIER 2: candidates in the shape fuzzyMatch/extractStop expect. */
  function getPlaceCandidates() {
    if (!memory) return [];
    return memory.places.map((p) => ({ id: p.id, name: p.name }));
  }

  function getPlaceById(id) {
    if (!memory) return null;
    return memory.places.find((p) => p.id === id) || null;
  }

  /** Records (or refreshes) a geocoded place. Same {name} always maps to the same id, so re-looking-up something already known updates it in place rather than duplicating it. */
  function recordPlace({ name, lat, lon }) {
    if (!memory) return null;
    const id = `place:${TheBusIntentParser.normalize(name)}`;
    const existing = memory.places.find((p) => p.id === id);
    if (existing) {
      existing.lat = lat;
      existing.lon = lon;
      existing.lastUsedAt = Date.now();
      existing.hitCount += 1;
    } else {
      memory.places.push({ id, name, lat, lon, lastUsedAt: Date.now(), hitCount: 1 });
    }
    memory.places = evictLru(memory.places, PLACES_CAP);
    persist();
    return id;
  }

  /** TIER 3: exact-phrase lookup. `kind` namespaces the key so a place and a stop can't collide even if worded identically. */
  function aliasKey(kind, normalizedText) {
    return `${kind}:${normalizedText}`;
  }

  function lookupAlias(kind, normalizedText) {
    if (!memory) return null;
    const key = aliasKey(kind, normalizedText);
    const hit = memory.aliases[key];
    if (!hit) return null;
    hit.lastUsedAt = Date.now(); // keep frequently-reused phrases safe from LRU eviction
    persist();
    return hit;
  }

  function recordAlias(kind, normalizedText, resolution) {
    if (!memory) return;
    const key = aliasKey(kind, normalizedText);
    memory.aliases[key] = { ...resolution, kind, lastUsedAt: Date.now() };
    const entries = Object.entries(memory.aliases);
    if (entries.length > ALIASES_CAP) {
      const kept = evictLru(entries.map(([k, v]) => ({ ...v, __key: k })), ALIASES_CAP);
      memory.aliases = Object.fromEntries(kept.map((v) => [v.__key, { kind: v.kind, id: v.id, name: v.name, lastUsedAt: v.lastUsedAt }]));
    }
    persist();
  }

  /**
   * Test-only: resets to a known, empty (or seeded) state synchronously
   * -- bypassing TheBusStorage entirely, not just re-triggering a load
   * from it -- so tests get deterministic isolation without racing a
   * fire-and-forget persist() from a previous test. Real app code never
   * calls this; ensureLoaded()'s whole point is to load from storage
   * exactly once per app launch and then stay warm.
   */
  function resetForTests(seed) {
    memory = seed ? { ...emptyMemory(), ...seed } : emptyMemory();
    loadingPromise = Promise.resolve();
  }

  global.TheBusSearchIndex = {
    ensureLoaded,
    getPlaceCandidates,
    getPlaceById,
    recordPlace,
    lookupAlias,
    recordAlias,
    resetForTests,
  };
})(window);
