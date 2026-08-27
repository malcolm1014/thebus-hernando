const fs = require('fs');
const config = require('./config');
const { fetchGtfs } = require('./gtfsFetch');
const { parseAllGtfs } = require('./gtfsParse');
const { transform } = require('./transform');
const { enrichAliases } = require('./enrich');
const { hashContent } = require('./hash');

/**
 * Refuses to trust a new dataset that looks like a broken/truncated
 * upstream feed rather than a real update -- e.g. the county's server
 * briefly serving an error page or a half-written file as if it were
 * the zip. A >50% drop in stop or route count vs. the last known-good
 * output is not a real-world schedule change, it's a bad pull.
 */
function isSuspiciouslySmaller(previous, next) {
  if (!previous) return false;
  const prevStops = Object.keys(previous.stops || {}).length;
  const prevRoutes = Object.keys(previous.routes || {}).length;
  const nextStops = Object.keys(next.stops).length;
  const nextRoutes = Object.keys(next.routes).length;
  if (prevStops === 0 || prevRoutes === 0) return false;
  return nextStops < prevStops * 0.5 || nextRoutes < prevRoutes * 0.5;
}

function readPreviousData() {
  if (!fs.existsSync(config.outputPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(config.outputPath, 'utf8'));
  } catch {
    return null; // corrupt/partial previous file -- don't let it block a fresh write
  }
}

function writeDataset(data) {
  const json = JSON.stringify(data);
  const version = hashContent(Buffer.from(json));
  const payload = JSON.stringify({ version, ...data });
  fs.writeFileSync(config.outputPath, payload);
  return version;
}

/**
 * Full ETL run: download the GTFS zip, parse its CSVs, flatten into the
 * client-optimized shape, and write transit_data.json + a version file.
 * This is the ONLY place that touches the upstream feed -- everything
 * downstream (the /api routes, the mobile client) just reads the output.
 *
 * Writes TWICE, deliberately: once immediately after the (fast) GTFS
 * transform, and again after the (slow, one-rate-limited-LLM-call-per-
 * stop) alias enrichment pass. Confirmed in production: gating the
 * FIRST write behind the full enrichment pass meant a fresh or
 * idle-woken backend served NOTHING -- not even a plain no-aliases
 * dataset -- for the run's entire duration, well past Render's
 * free-tier spin-down window, so every cold start was a full outage
 * for riders. /api/version and /api/download read straight off disk on
 * every request, independent of whether this function has returned yet,
 * so the early write makes real schedule data servable right away;
 * enrichment then finishes in the background and the second write bumps
 * the version so clients pick up the richer aliases on their next sync.
 */
async function runEtl() {
  const startedAt = Date.now();
  console.log('[etl] starting run');

  const previous = readPreviousData();

  await fetchGtfs();
  const tables = parseAllGtfs();
  const data = transform(tables);

  if (isSuspiciouslySmaller(previous, data)) {
    const prevStops = Object.keys(previous.stops).length;
    const prevRoutes = Object.keys(previous.routes).length;
    const nextStops = Object.keys(data.stops).length;
    const nextRoutes = Object.keys(data.routes).length;
    throw new Error(
      `refusing to overwrite transit_data.json: new pull has ${nextRoutes} routes/${nextStops} stops vs previous ${prevRoutes} routes/${prevStops} stops (>50% drop) -- looks like a broken feed, not a real schedule change`
    );
  }

  for (const stop of Object.values(data.stops)) stop.aliases = stop.aliases || [];
  const initialVersion = writeDataset(data);

  const stopCount = Object.keys(data.stops).length;
  const routeCount = Object.keys(data.routes).length;
  const ms = Date.now() - startedAt;
  console.log(`[etl] wrote ${config.outputPath} (${routeCount} routes, ${stopCount} stops, version ${initialVersion}) in ${ms}ms -- alias enrichment continues in the background`);

  await enrichAliases(data);
  const finalVersion = writeDataset(data);
  console.log(`[etl] alias enrichment complete, rewrote ${config.outputPath} (version ${finalVersion})`);

  return { version: finalVersion, routeCount, stopCount };
}

if (require.main === module) {
  runEtl().catch((err) => {
    console.error('[etl] FAILED:', err);
    process.exitCode = 1;
  });
}

module.exports = { runEtl, isSuspiciouslySmaller };
