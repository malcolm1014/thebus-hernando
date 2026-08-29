/**
 * Resolves a free-text place name ("Springstead High School", "Murphy's
 * Market") to coordinates via OpenStreetMap's Nominatim geocoder, so the
 * app can answer "nearest stop to X" for any real place, not just a
 * hand-maintained list of landmarks that would immediately be
 * incomplete the moment someone asks about a business not on it.
 *
 * Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
 * requires a real identifying User-Agent and caps public-instance use at
 * roughly 1 request/second -- both handled here: every outbound request
 * carries a proper User-Agent, and a tiny queue serializes requests at
 * least 1.1s apart regardless of how many concurrent app users trigger
 * a cache-miss lookup at once. Aggressive caching (landmarks don't move)
 * keeps most real usage from ever reaching Nominatim a second time.
 *
 * The cache is in-memory only, not written to disk. On Render's free
 * tier the whole container (including anything on disk) is torn down
 * and rebuilt on every sleep/wake cycle, not just the process -- so
 * file-based persistence here would survive individual restarts but not
 * the idle-sleep cycle this backend actually goes through most often,
 * making it not worth the added complexity. It still meaningfully
 * reduces Nominatim traffic during any stretch the instance stays warm
 * (a burst of nearby queries, or while an external pinger is keeping it
 * awake). Revisit if this ever moves to a paid Render tier with a real
 * persistent disk or "always on" instance.
 */

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

// Hernando County, FL bounding box (lon1,lat1,lon2,lat2) -- biases/
// restricts results to the county so "Publix" resolves to a local one,
// not the chain's headquarters or a same-named place in another state.
const VIEWBOX = '-82.75,28.65,-82.35,28.25';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Without a cap, a stream of distinct junk queries (abuse, or just an
// unlucky number of genuinely different real lookups over a long warm
// stretch) would grow this Map forever -- entries only ever got
// re-examined when the SAME key was queried again, never proactively.
// A few hundred landmarks/businesses comfortably covers a single small
// county; oldest-inserted entries are evicted first once over the cap
// (see `cache.keys().next()` below -- Map preserves insertion order).
const CACHE_MAX_ENTRIES = 500;
const cache = new Map(); // normalized query -> { data, expiresAt }

/** Inserts into `map`, evicting the oldest entry first if already at `maxEntries` -- pulled out on its own so the eviction behavior is directly testable without going through the real 1.1s-per-request Nominatim throttle below. */
function cacheSet(map, maxEntries, key, value) {
  if (map.size >= maxEntries && !map.has(key)) {
    map.delete(map.keys().next().value); // oldest-inserted entry (Map preserves insertion order)
  }
  map.set(key, value);
}

let requestQueue = Promise.resolve();
let lastRequestAt = 0;

async function throttledFetch(url, options) {
  const runNow = requestQueue.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastRequestAt));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  });
  requestQueue = runNow.catch(() => {}); // one failed lookup shouldn't jam the queue for the next one
  await runNow;
  return fetch(url, options);
}

/** @returns {Promise<{lat: number, lon: number, displayName: string} | null>} */
async function geocode(query) {
  const key = query.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const url = new URL(`${NOMINATIM_BASE}/search`);
  url.searchParams.set('q', `${query}, Hernando County, FL`);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('viewbox', VIEWBOX);
  url.searchParams.set('bounded', '1');

  const res = await throttledFetch(url, {
    headers: {
      'User-Agent': 'TheBusHernando/1.0 (+https://github.com/malcolm1014/thebus-hernando)',
    },
  });
  if (!res.ok) throw new Error(`Nominatim request failed: HTTP ${res.status}`);
  const results = await res.json();

  const data = results.length > 0
    ? { lat: Number(results[0].lat), lon: Number(results[0].lon), displayName: results[0].display_name }
    : null;

  cacheSet(cache, CACHE_MAX_ENTRIES, key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

module.exports = { geocode, cacheSet, CACHE_MAX_ENTRIES };
