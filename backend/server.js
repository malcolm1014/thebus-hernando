const fs = require('fs');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const config = require('./src/config');
const { runEtl } = require('./src/etl');
const { fetchLiveBuses } = require('./src/passio');
const { geocode } = require('./src/geocode');

const app = express();
app.use(cors());

let etlRunning = false;

async function ensureInitialData() {
  if (fs.existsSync(config.outputPath)) return;
  console.log('[server] no transit_data.json on disk yet, running initial ETL...');
  await runEtl();
}

/**
 * GET /api/version
 * Returns just the dataset's content hash + generation timestamp, so the
 * client can cheaply decide whether it needs to re-download.
 */
app.get('/api/version', (req, res) => {
  if (!fs.existsSync(config.outputPath)) {
    return res.status(503).json({ error: 'dataset not generated yet' });
  }
  const data = JSON.parse(fs.readFileSync(config.outputPath, 'utf8'));
  res.json({ version: data.version, generatedAt: data.generatedAt });
});

/**
 * GET /api/download
 * Serves the full flattened dataset. This is the only endpoint that ships
 * the actual transit data -- the backend never interprets rider queries.
 */
app.get('/api/download', (req, res) => {
  if (!fs.existsSync(config.outputPath)) {
    return res.status(503).json({ error: 'dataset not generated yet' });
  }
  res.setHeader('Content-Type', 'application/json');
  fs.createReadStream(config.outputPath).pipe(res);
});

/**
 * POST /api/refresh
 * Manually triggers a re-pull of the GTFS feed. Protected by a shared
 * secret (header: x-refresh-secret) since it's an outward-facing write
 * path and hitting it too often would hammer the county's feed server.
 * Intended for use by an external cron pinger (see .env.example) when
 * running on a free tier that spins the service down when idle.
 */
app.post('/api/refresh', express.json(), async (req, res) => {
  const provided = req.header('x-refresh-secret');
  if (!config.refreshSecret || provided !== config.refreshSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (etlRunning) {
    return res.status(409).json({ error: 'etl already running' });
  }
  etlRunning = true;
  try {
    const result = await runEtl();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[server] ETL refresh failed:', err);
    res.status(500).json({ error: 'etl failed', message: err.message });
  } finally {
    etlRunning = false;
  }
});

/**
 * GET /api/live-buses
 * Proxies Passio GO's real-time vehicle-position feed (see src/passio.js
 * for why this goes through our backend rather than being called
 * directly from the app). Requires network -- unlike the schedule data,
 * this is never cached client-side, since a stale bus position is
 * actively misleading rather than just outdated.
 */
app.get('/api/live-buses', async (req, res) => {
  try {
    const result = await fetchLiveBuses();
    res.json(result);
  } catch (err) {
    console.error('[server] live-buses fetch failed:', err);
    res.status(502).json({ error: 'live bus data unavailable', message: err.message });
  }
});

/**
 * GET /api/geocode?q=<place name>
 * Resolves a free-text place name (a business, school, landmark -- not
 * necessarily a known transit stop) to coordinates via Nominatim, so the
 * client can compute "nearest stop to X" for literally any real place
 * instead of only ones already in the GTFS stop list. See src/geocode.js
 * for why this is proxied (User-Agent + rate-limit policy compliance,
 * shared caching) rather than called directly from the app.
 */
app.get('/api/geocode', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) {
    return res.status(400).json({ error: 'missing required query parameter: q' });
  }
  try {
    const result = await geocode(q);
    res.json({ result });
  } catch (err) {
    console.error('[server] geocode failed:', err);
    res.status(502).json({ error: 'geocoding unavailable', message: err.message });
  }
});

app.get('/healthz', (req, res) => res.send('ok'));

async function main() {
  // Listens immediately, before the initial ETL -- a fresh deploy with an
  // empty data dir used to await the whole first ETL run (including
  // alias enrichment: one deliberately rate-limited LLM call per stop)
  // before ever opening the port. Confirmed in production: a ~370-stop
  // feed's enrichment pass alone took long enough that Render's deploy
  // health check saw nothing listening and timed the deploy out entirely.
  // /api/version and /api/download already answer a clean 503 "dataset
  // not generated yet" in the meantime, so there's no correctness cost to
  // not blocking startup on this.
  app.listen(config.port, () => {
    console.log(`[server] listening on :${config.port}`);
  });

  etlRunning = true;
  ensureInitialData()
    .catch((err) => console.error('[server] initial ETL failed:', err))
    .finally(() => { etlRunning = false; });

  if (config.etlCron) {
    cron.schedule(config.etlCron, async () => {
      if (etlRunning) return;
      etlRunning = true;
      try {
        await runEtl();
      } catch (err) {
        console.error('[server] scheduled ETL failed:', err);
      } finally {
        etlRunning = false;
      }
    });
    console.log(`[server] scheduled ETL cron: "${config.etlCron}"`);
  }
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
