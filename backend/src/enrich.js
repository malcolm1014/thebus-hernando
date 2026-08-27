const fs = require('fs');
const config = require('./config');

/**
 * Pre-seeds each stop's search aliases via a free LLM call at ETL time --
 * NOT at query time. The client never talks to an LLM and the app's
 * "works fully offline once synced" guarantee is untouched; this only
 * makes the shipped dataset itself smarter before it ever reaches a
 * phone. The model is only ever asked to paraphrase/abbreviate a stop's
 * OWN official GTFS name (explicitly told not to invent nearby
 * businesses or landmarks it has no real data about) -- e.g. "Walmart
 * US19 Spring Hill" -> "walmart on 19", "walmart spring hill", "wally
 * world 19". These ship as stop.aliases[] in transit_data.json so the
 * client's existing Tier-1 GTFS stop matching (queryEngine.js) can
 * resolve them offline on the very first try, instead of only learning
 * them reactively after a rider's phrasing happens to succeed once.
 *
 * Uses Groq's free tier directly via its REST API (plain fetch, same
 * dependency-free style as passio.js -- no SDK), an OpenAI-compatible
 * chat completions endpoint serving genuinely open-weight models
 * (Llama, not a closed model just offered for free). Entirely optional:
 * with no GROQ_API_KEY configured, every stop just gets aliases: [] and
 * the dataset ships exactly as it did before this feature existed.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Free-tier rate limits are per-minute, not per-day -- a small pause
// between calls keeps a several-dozen-stop county feed comfortably under
// them without needing real backoff/retry logic for what's at most a
// once-a-day batch job (see ETL_CRON).
const REQUEST_SPACING_MS = 2000;

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(config.aliasCachePath, 'utf8'));
  } catch {
    return {}; // first run, or a corrupt/missing cache file -- never fatal, just re-enrich everything
  }
}

function saveCache(cache) {
  fs.writeFileSync(config.aliasCachePath, JSON.stringify(cache));
}

/**
 * Cache key doubles as automatic invalidation: if a stop's own name or
 * served routes ever change, the key changes with them, so a real-world
 * rename or schedule change always regenerates fresh aliases instead of
 * silently shipping stale ones forever.
 */
function cacheKey(stop) {
  const routeNames = stop.routes.map((r) => r.shortName || r.longName).sort().join('|');
  return `${stop.name}::${routeNames}`;
}

function buildPrompt(stop) {
  const routeNames = stop.routes.map((r) => r.shortName || r.longName).filter(Boolean).join(', ') || 'none on file';
  return `You are helping riders find a public transit stop by its official name.

Official stop name: "${stop.name}"
Routes serving this stop: ${routeNames}
County: Hernando County, Florida, USA

Generate 3-6 short alternate phrasings a local rider might actually type into a search box for this exact stop: informal shorthand, common abbreviations, dropped directional suffixes, "on <road number>" style phrasing, etc.

Stay strictly grounded in the words already present in the official name. Do NOT invent a business, landmark, or fact that isn't already implied by the name itself. If the name gives you nothing reasonable to shorten or rephrase, return fewer results, or an empty list, rather than guessing.

Respond with ONLY a JSON object of the form {"aliases": [...]}, containing lowercase strings, no other text. Example: {"aliases": ["walmart on 19", "walmart spring hill"]}`;
}

async function callGroq(stop) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.groqApiKey}`,
    },
    body: JSON.stringify({
      model: config.groqModel,
      messages: [{ role: 'user', content: buildPrompt(stop) }],
      response_format: { type: 'json_object' },
      temperature: 0.4,
    }),
  });
  if (!res.ok) {
    throw new Error(`Groq request failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!text) return [];
  // response_format:json_object guarantees a JSON OBJECT, not an array --
  // the prompt asks for a bare array, but a chat model asked for JSON
  // sometimes wraps it in a key regardless (e.g. {"aliases": [...]})
  // rather than returning the array as the whole document. Accept either
  // shape instead of failing on the wrapped one.
  const parsed = JSON.parse(text); // an unparseable response is a real failure -- let it throw and be logged, not silently swallowed as "no aliases"
  const list = Array.isArray(parsed) ? parsed : Object.values(parsed).find((v) => Array.isArray(v));
  if (!Array.isArray(list)) return [];
  return list.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mutates every stop in `data.stops` with an `aliases` array and returns
 * `data`. Never throws -- a total enrichment failure (no key, network
 * down, quota exhausted partway through) just leaves whichever stops
 * weren't reached with aliases: [], so a bad LLM day never blocks a real
 * schedule update from shipping.
 */
async function enrichAliases(data) {
  const stops = Object.values(data.stops);

  if (!config.groqApiKey) {
    console.log('[enrich] GROQ_API_KEY not set -- skipping alias enrichment, shipping aliases: [] for every stop');
    for (const stop of stops) stop.aliases = [];
    return data;
  }

  const cache = loadCache();
  let calls = 0;
  let failures = 0;

  for (const stop of stops) {
    const key = cacheKey(stop);
    if (cache[key]) {
      stop.aliases = cache[key];
      continue;
    }

    try {
      if (calls > 0) await sleep(REQUEST_SPACING_MS);
      calls += 1;
      const aliases = await callGroq(stop);
      stop.aliases = aliases;
      cache[key] = aliases;
    } catch (err) {
      console.error(`[enrich] failed for stop "${stop.name}":`, err.message);
      stop.aliases = [];
      failures += 1;
    }
  }

  saveCache(cache);
  console.log(`[enrich] done -- ${calls} LLM call(s) (${failures} failed), ${stops.length - calls} stop(s) served from cache`);
  return data;
}

module.exports = { enrichAliases, buildPrompt, cacheKey };
