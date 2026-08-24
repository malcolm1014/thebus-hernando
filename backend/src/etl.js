const fs = require('fs');
const config = require('./config');
const { fetchGtfs } = require('./gtfsFetch');
const { parseAllGtfs } = require('./gtfsParse');
const { transform } = require('./transform');
const { hashContent } = require('./hash');

/**
 * Full ETL run: download the GTFS zip, parse its CSVs, flatten into the
 * client-optimized shape, and write transit_data.json + a version file.
 * This is the ONLY place that touches the upstream feed -- everything
 * downstream (the /api routes, the mobile client) just reads the output.
 */
async function runEtl() {
  const startedAt = Date.now();
  console.log('[etl] starting run');

  await fetchGtfs();
  const tables = parseAllGtfs();
  const data = transform(tables);

  const json = JSON.stringify(data);
  const version = hashContent(Buffer.from(json));

  const payload = JSON.stringify({ version, ...data });
  fs.writeFileSync(config.outputPath, payload);

  const stopCount = Object.keys(data.stops).length;
  const routeCount = Object.keys(data.routes).length;
  const ms = Date.now() - startedAt;
  console.log(`[etl] wrote ${config.outputPath} (${routeCount} routes, ${stopCount} stops, version ${version}) in ${ms}ms`);

  return { version, routeCount, stopCount };
}

if (require.main === module) {
  runEtl().catch((err) => {
    console.error('[etl] FAILED:', err);
    process.exitCode = 1;
  });
}

module.exports = { runEtl };
