const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const config = require('./config');

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
  const res = await fetch(config.gtfsFeedUrl);
  if (!res.ok) {
    throw new Error(`GTFS download failed: HTTP ${res.status} ${res.statusText}`);
  }
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
