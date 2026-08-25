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
 */

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

// Hernando County, FL bounding box (lon1,lat1,lon2,lat2) -- biases/
// restricts results to the county so "Publix" resolves to a local one,
// not the chain's headquarters or a same-named place in another state.
const VIEWBOX = '-82.75,28.65,-82.35,28.25';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map(); // normalized query -> { data, expiresAt }

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

  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

module.exports = { geocode };
