const fs = require('fs');
const config = require('./config');
const { fetchGtfs } = require('./gtfsFetch');
const { parseAllGtfs } = require('./gtfsParse');
const { transform, mergeAgencyData } = require('./transform');
const { enrichAliases } = require('./enrich');
const { hashContent } = require('./hash');
const { compactForWire, expandFromWire } = require('./compact');

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
    // The on-disk file is wire-compacted (writeDataset() below) -- expand
    // it back to transform()'s normal shape before anything else in this
    // module touches it. extractAgencySlice()'s fallback path in
    // particular feeds this straight back into mergeAgencyData() as if
    // it were fresh transform() output, so it must match that shape.
    return expandFromWire(JSON.parse(fs.readFileSync(config.outputPath, 'utf8')));
  } catch {
    return null; // corrupt/partial previous file -- don't let it block a fresh write
  }
}

/**
 * Compacted here, not in mergeAgencyData() -- `data` itself stays in its
 * normal, readable, per-arrival-object shape for the rest of the ETL
 * (isSuspiciouslySmaller's counts, enrichAliases's per-stop iteration,
 * etc. all keep working unchanged); only the bytes actually written to
 * disk are compact. Called twice per run (the early schedule-only write,
 * then again after alias enrichment finishes) -- each call compacts
 * whatever `data` looks like at that moment, so both writes stay small.
 */
function writeDataset(data) {
  const compact = compactForWire(data);
  const json = JSON.stringify(compact);
  const version = hashContent(Buffer.from(json));
  const payload = JSON.stringify({ version, ...compact });
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
/**
 * Pulls one agency's own slice (its stops/routes/services, identified by
 * the `${agencyId}:` id prefix `transform()`'s `agencyMeta` param adds)
 * back out of a previously-written MERGED dataset. Used as a per-agency
 * fallback below: one agency's feed being temporarily unreachable (a
 * real, confirmed risk -- see the README section on Citrus County's
 * feed) shouldn't blank that agency out of the app, or fail the whole
 * multi-agency run, when we already have its last known-good data.
 */
function extractAgencySlice(previousMerged, agencyId) {
  if (!previousMerged) return null;
  const prefix = `${agencyId}:`;
  const stops = {};
  const routes = {};
  const services = {};
  for (const [id, stop] of Object.entries(previousMerged.stops || {})) if (id.startsWith(prefix)) stops[id] = stop;
  for (const [id, route] of Object.entries(previousMerged.routes || {})) if (id.startsWith(prefix)) routes[id] = route;
  for (const [id, svc] of Object.entries(previousMerged.services || {})) if (id.startsWith(prefix)) services[id] = svc;
  if (Object.keys(stops).length === 0) return null; // nothing to fall back to
  const timezone = (previousMerged.agencies && previousMerged.agencies[agencyId] && previousMerged.agencies[agencyId].timezone) || previousMerged.agencyTimezone;
  return { agencyTimezone: timezone, services, routes, stops };
}

/**
 * Fetches, parses, and transforms ONE agency -- isolated in its own
 * try/catch so one agency's feed being down doesn't take the other
 * agencies (or the whole run) with it. Falls back to that agency's own
 * slice of the last known-good merged dataset when the live pull fails
 * and a fallback is available; returns null only when there's truly
 * nothing usable for this agency (a brand-new agency's very first pull
 * failing, with no previous data to fall back to).
 */
async function fetchAndTransformAgency(agency, previousMerged) {
  try {
    await fetchGtfs(agency);
    const tables = parseAllGtfs(agency.id);
    const data = transform(tables, { id: agency.id, label: agency.label });
    return { id: agency.id, label: agency.label, timezone: data.agencyTimezone, data };
  } catch (err) {
    console.error(`[etl] [${agency.id}] FAILED: ${err.message}`);
    const fallback = extractAgencySlice(previousMerged, agency.id);
    if (!fallback) {
      console.error(`[etl] [${agency.id}] no previous data to fall back to -- this agency contributes nothing to this run`);
      return null;
    }
    console.warn(`[etl] [${agency.id}] falling back to its last known-good data`);
    return { id: agency.id, label: agency.label, timezone: fallback.agencyTimezone, data: fallback };
  }
}

async function runEtl() {
  const startedAt = Date.now();
  console.log('[etl] starting run');

  if (config.agencies.length === 0) {
    throw new Error('No agency GTFS feed URLs configured. Copy .env.example to .env and fill in at least one GTFS_FEED_URL_* var.');
  }

  const previous = readPreviousData();

  const agencyResults = (await Promise.all(
    config.agencies.map((agency) => fetchAndTransformAgency(agency, previous))
  )).filter(Boolean);

  if (agencyResults.length === 0) {
    throw new Error('every configured agency failed this run, with no previous data to fall back to -- refusing to write an empty dataset');
  }

  const data = mergeAgencyData(agencyResults);

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
  console.log(`[etl] wrote ${config.outputPath} (${config.agencies.length} agencies configured, ${agencyResults.length} contributed data, ${routeCount} routes, ${stopCount} stops, version ${initialVersion}) in ${ms}ms -- alias enrichment continues in the background`);

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

module.exports = { runEtl, isSuspiciouslySmaller, extractAgencySlice };
