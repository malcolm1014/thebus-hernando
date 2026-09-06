const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const config = require('./config');

/**
 * Fetches a URL with a small exponential-backoff retry for transient
 * failures (network blips, upstream 5xx) -- the county's server is a
 * small government host, not a CDN, and does occasionally hiccup.
 * Doesn't retry 4xx (those won't fix themselves on a retry).
 */
async function fetchWithRetry(url, agencyId, { attempts = 3, initialDelayMs = 1000, factor = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`GTFS download failed: HTTP ${res.status} ${res.statusText} (not retrying a client error)`);
      }
      lastErr = new Error(`GTFS download failed: HTTP ${res.status} ${res.statusText}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < attempts) {
      const delay = initialDelayMs * factor ** (attempt - 1);
      // Multiple agencies now fetch concurrently (etl.js), so a bare
      // "attempt 1/3 failed" with no agency tag is genuinely ambiguous
      // about which feed hiccuped -- confirmed confusing in practice
      // during the first real multi-agency ETL run.
      console.warn(`[gtfsFetch] [${agencyId}] attempt ${attempt}/${attempts} failed (${lastErr.message}), retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * Downloads one agency's GTFS static feed zip and extracts it to its own
 * data/raw/<agencyId>/ dir. Uses the global fetch available in Node
 * 18+ -- no extra HTTP dependency.
 */
async function fetchGtfs(agency) {
  if (!agency || !agency.feedUrl) {
    throw new Error(`No feed URL configured for agency "${agency && agency.id}". Copy .env.example to .env and fill in its GTFS_FEED_URL_* var.`);
  }

  fs.mkdirSync(config.dataDir, { recursive: true });

  console.log(`[gtfsFetch] [${agency.id}] downloading ${agency.feedUrl}`);
  const res = await fetchWithRetry(agency.feedUrl, agency.id);
  const buf = Buffer.from(await res.arrayBuffer());
  const zipPath = config.zipPathFor(agency.id);
  fs.writeFileSync(zipPath, buf);
  console.log(`[gtfsFetch] [${agency.id}] saved zip (${buf.length} bytes) -> ${zipPath}`);

  // Clean previous extraction so stale files never linger between runs.
  const rawDir = config.rawDirFor(agency.id);
  fs.rmSync(rawDir, { recursive: true, force: true });
  fs.mkdirSync(rawDir, { recursive: true });

  const zip = new AdmZip(buf);
  zip.extractAllTo(rawDir, true);
  console.log(`[gtfsFetch] [${agency.id}] extracted -> ${rawDir}`);

  return rawDir;
}

/** Reads one agency's raw GTFS text file by name (e.g. "stops.txt"), or null if absent. */
function readGtfsFile(agencyId, name) {
  const p = path.join(config.rawDirFor(agencyId), name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

module.exports = { fetchGtfs, readGtfsFile };
