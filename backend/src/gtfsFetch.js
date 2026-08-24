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
async function fetchWithRetry(url, { attempts = 3, initialDelayMs = 1000, factor = 3 } = {}) {
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
      console.warn(`[gtfsFetch] attempt ${attempt}/${attempts} failed (${lastErr.message}), retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * Downloads the GTFS static feed zip and extracts it to data/raw/.
 * Uses the global fetch available in Node 18+ -- no extra HTTP dependency.
 */
async function fetchGtfs() {
  if (!config.gtfsFeedUrl) {
    throw new Error('GTFS_FEED_URL is not set. Copy .env.example to .env and fill it in.');
  }

  fs.mkdirSync(config.dataDir, { recursive: true });

  console.log(`[gtfsFetch] downloading ${config.gtfsFeedUrl}`);
  const res = await fetchWithRetry(config.gtfsFeedUrl);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(config.zipPath, buf);
  console.log(`[gtfsFetch] saved zip (${buf.length} bytes) -> ${config.zipPath}`);

  // Clean previous extraction so stale files never linger between runs.
  fs.rmSync(config.rawDir, { recursive: true, force: true });
  fs.mkdirSync(config.rawDir, { recursive: true });

  const zip = new AdmZip(buf);
  zip.extractAllTo(config.rawDir, true);
  console.log(`[gtfsFetch] extracted -> ${config.rawDir}`);

  return config.rawDir;
}

/** Reads a raw GTFS text file by name (e.g. "stops.txt"), or null if absent. */
function readGtfsFile(name) {
  const p = path.join(config.rawDir, name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

module.exports = { fetchGtfs, readGtfsFile };
