#!/usr/bin/env node
/**
 * Regenerates the bundled fallback dataset
 * (www/data/transit_data.snapshot.json) from a fresh backend ETL run
 * against the real, live GTFS feed. Run this before every release build
 * -- a stale bundled snapshot would mean a fresh install could show
 * outdated schedule data on its very first launch, even though a live
 * sync would correct it moments later in the background.
 *
 * Requires backend/ dependencies to already be installed
 * (cd ../backend && npm install) and backend/.env to exist with a real
 * GTFS_FEED_URL (backend/.env.example already has Hernando County's).
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const backendDir = path.join(__dirname, '..', '..', 'backend');
const backendOutput = path.join(backendDir, 'data', 'transit_data.json');
const snapshotDest = path.join(__dirname, '..', 'www', 'data', 'transit_data.snapshot.json');

if (!fs.existsSync(path.join(backendDir, 'node_modules'))) {
  console.error('[refresh-snapshot] backend/node_modules not found -- run `cd ../backend && npm install` first.');
  process.exit(1);
}
if (!fs.existsSync(path.join(backendDir, '.env'))) {
  console.error('[refresh-snapshot] backend/.env not found -- copy backend/.env.example to backend/.env first.');
  process.exit(1);
}

console.log('[refresh-snapshot] running backend ETL against the live GTFS feed...');
execSync('npm run etl', { cwd: backendDir, stdio: 'inherit' });

if (!fs.existsSync(backendOutput)) {
  console.error('[refresh-snapshot] backend ETL did not produce data/transit_data.json -- aborting, NOT touching the existing snapshot.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(snapshotDest), { recursive: true });
fs.copyFileSync(backendOutput, snapshotDest);
const stats = fs.statSync(snapshotDest);
console.log(`[refresh-snapshot] wrote ${snapshotDest} (${(stats.size / 1024).toFixed(1)} KB) -- commit this file before building the release.`);
