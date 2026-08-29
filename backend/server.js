const fs = require('fs');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const config = require('./src/config');
const { runEtl } = require('./src/etl');
const { fetchLiveBuses } = require('./src/passio');
const { geocode } = require('./src/geocode');
const { fetchStaticMap } = require('./src/staticmap');
const { createRateLimiter } = require('./src/rateLimit');

const app = express();
// Render sits its own reverse proxy in front of every service -- without
// this, req.ip is always the proxy's address, not the real client's, and
// the rate limiter below would lump every single visitor into one shared
// bucket instead of limiting each of them individually.
app.set('trust proxy', 1);
app.use(cors());

const geocodeRateLimit = createRateLimiter({ windowMs: 60 * 1000, max: 20 });
const staticmapRateLimit = createRateLimiter({ windowMs: 60 * 1000, max: 20 });
// Generous relative to real usage (a device checks /api/version once per
// app open, and only pulls /api/download when that check finds a newer
// version -- both far under these limits for any real rider, including
// several devices sharing one NAT'd IP) -- these exist to cap outright
// abuse of an unauthenticated public endpoint, not to constrain normal
// use. /api/download's payload is the largest thing this backend serves
// (the full dataset), hence the tighter number.
const versionRateLimit = createRateLimiter({ windowMs: 60 * 1000, max: 60 });
const downloadRateLimit = createRateLimiter({ windowMs: 60 * 1000, max: 20 });
const crashReportRateLimit = createRateLimiter({ windowMs: 60 * 1000, max: 10 });

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
app.get('/api/version', versionRateLimit, (req, res) => {
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
app.get('/api/download', downloadRateLimit, (req, res) => {
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
app.get('/api/geocode', geocodeRateLimit, async (req, res) => {
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

/**
 * GET /api/staticmap?lat=<n>&lon=<n>
 * Proxies a small rendered map image for one stop/landmark location from
 * Geoapify's Static Maps API (see src/staticmap.js). Purely a visual
 * nice-to-have on top of an already-complete text answer -- a 404 here
 * (feature not configured) or a 502 (upstream failure) both just mean
 * the client shows text-only, same as always.
 */
app.get('/api/staticmap', staticmapRateLimit, async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'missing or invalid required query parameters: lat, lon' });
  }
  try {
    const image = await fetchStaticMap(lat, lon);
    if (!image) {
      return res.status(404).json({ error: 'static map not configured' });
    }
    res.setHeader('Content-Type', image.contentType);
    res.send(image.buffer);
  } catch (err) {
    console.error('[server] static map fetch failed:', err);
    res.status(502).json({ error: 'static map unavailable', message: err.message });
  }
});

/**
 * POST /api/crash-report
 * A minimal, self-hosted alternative to a third-party crash-reporting
 * SaaS (Sentry, Crashlytics, etc.) -- deliberately not one of those,
 * since wiring one in means creating a vendor account and committing an
 * API key/DSN, a decision worth making deliberately rather than as a
 * side effect of an audit fix. This just logs to stdout, which Render
 * already captures and makes visible in the service's own log viewer --
 * enough to know something broke and see the stack trace, without a new
 * account, a new dependency, or another place this app's data flows to.
 * Upgrading to a real dashboard/alerting service later is a config
 * change, not a rewrite -- this endpoint could proxy to one instead.
 *
 * Deliberately narrow: message + stack + a coarse screen label + the
 * platform string. Never the rider's query text or location -- this app
 * promises those never leave the device (see PRIVACY_POLICY.md), and a
 * crash report is not an exception to that.
 */
app.post('/api/crash-report', express.json({ limit: '10kb' }), crashReportRateLimit, (req, res) => {
  const body = req.body || {};
  if (typeof body.message !== 'string' || !body.message) {
    return res.status(400).json({ error: 'missing required field: message' });
  }
  console.error('[crash-report]', JSON.stringify({
    message: body.message.slice(0, 2000),
    stack: typeof body.stack === 'string' ? body.stack.slice(0, 4000) : undefined,
    screen: typeof body.screen === 'string' ? body.screen.slice(0, 100) : undefined,
    platform: typeof body.platform === 'string' ? body.platform.slice(0, 50) : undefined,
    at: new Date().toISOString(),
  }));
  res.status(204).end();
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
