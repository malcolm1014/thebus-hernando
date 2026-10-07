require('dotenv').config();
const path = require('path');

// TriBus covers 3 Florida agencies (Nature Coast into Tampa Bay), each
// with its own GTFS feed URL env var -- listing them here (rather than,
// say, a JSON array in one env var) keeps each one a normal single-value
// Render/`.env` secret, and keeps `GTFS_FEED_URL` (no suffix) working
// unchanged for any existing single-agency deployment, mapped to
// Hernando -- the agency this app originally shipped with alone.
const AGENCY_DEFS = [
  { id: 'hernando', label: 'Hernando County Transit', envVar: 'GTFS_FEED_URL_HERNANDO', legacyEnvVar: 'GTFS_FEED_URL' },
  { id: 'pasco', label: 'PascoGo', envVar: 'GTFS_FEED_URL_PASCO' },
  { id: 'hart', label: 'HART (Hillsborough Area Regional Transit)', envVar: 'GTFS_FEED_URL_HART' },
  // Citrus County Transit. Their live feed sits behind a Cloudflare CMS
  // that blocks automated fetching (see .env.example), so we self-host a
  // current snapshot of their GTFS in this repo (backend/seed/) and
  // default to it -- Citrus activates out of the box, no Render env var
  // needed. The feed's own calendar runs through 2040, and the ETL's
  // freshness guard (feedFreshness.js) would skip it automatically if it
  // ever lapsed. Set GTFS_FEED_URL_CITRUS to override (e.g. if the county
  // ever exposes a direct, unprotected URL we can fetch live); refresh
  // the committed snapshot when Citrus publishes a new schedule.
  {
    id: 'citrus',
    label: 'Citrus County Transit',
    envVar: 'GTFS_FEED_URL_CITRUS',
    defaultUrl: 'https://raw.githubusercontent.com/malcolm1014/thebus-hernando/main/backend/seed/citrus-gtfs.zip',
  },
];

// Only agencies with an actual configured feed URL are active -- lets a
// deployment run with just 1 or 2 agencies configured (e.g. while
// rolling out a new one) instead of all-or-nothing.
const agencies = AGENCY_DEFS
  .map(({ id, label, envVar, legacyEnvVar, defaultUrl }) => ({
    id,
    label,
    feedUrl: process.env[envVar] || (legacyEnvVar && process.env[legacyEnvVar]) || defaultUrl || null,
  }))
  .filter((a) => a.feedUrl);

module.exports = {
  agencies,
  refreshSecret: process.env.REFRESH_SECRET,
  etlCron: process.env.ETL_CRON || '0 3 * * *',
  port: process.env.PORT || 3000,

  // Optional: pre-seeds each stop's search aliases via Groq's free tier
  // (genuinely open-weight models -- Llama, not a closed model just
  // offered for free) at ETL time (see src/enrich.js). Entirely
  // optional -- leaving this unset just ships aliases: [] for every
  // stop, same as before this feature existed. Never required for the
  // app to work.
  groqApiKey: process.env.GROQ_API_KEY,
  // llama-3.1-8b-instant/llama-3.3-70b-versatile moved to Enterprise-only
  // ("Contact Sales") on Groq's current pricing page -- confirmed via
  // Groq's own Playground (which uses the account's session, not this
  // key) that openai/gpt-oss-20b (Apache-2.0 licensed, genuinely
  // open-weight) works on the plain $0 Free plan with no billing
  // required. Re-check https://console.groq.com/docs/models if this
  // ever 404s again -- Groq's free-tier model lineup has moved once
  // already.
  groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',

  // Optional: renders a small static map image for a stop/landmark
  // answer via Geoapify's Static Maps API (OSM-based, free tier, no
  // credit card -- see src/staticmap.js for why this instead of
  // scraping OSM's own tile server). Leaving this unset just means
  // answers stay text-only, exactly as before this feature existed.
  geoapifyApiKey: process.env.GEOAPIFY_API_KEY,
  // Geoapify raster map-tile style for the live-map basemap, proxied via
  // GET /api/tiles (see src/mapTiles.js). Any Geoapify map-style id works;
  // a LIGHT style is expected here because the client applies a CSS invert
  // filter to produce the terminal-green dark look (see terminal.css). The
  // basemap reuses geoapifyApiKey above -- one Geoapify key powers both the
  // static-map thumbnails and the live-map tiles.
  mapTileStyle: process.env.MAP_TILE_STYLE || 'osm-bright-smooth',

  // Optional: when a rider's device is online, the rule-based query
  // engine's already-correct answer (see queryEngine.js -- this is
  // NEVER skipped or replaced, only rephrased) is optionally handed to
  // xAI's Grok for a more natural-language rewrite (src/grokAnswer.js).
  // A DIFFERENT provider from groqApiKey above (xAI's own "Grok" model
  // family via api.x.ai, not Groq's inference-hardware-hosted open
  // models) -- easy to confuse by name, kept as clearly separate config
  // entries. Leaving this unset just means every answer is the rule
  // engine's own text, unrephrased -- exactly this app's original
  // fully-offline behavior. See PRIVACY_POLICY.md: when this IS
  // configured, the query text and the rule engine's own factual answer
  // (never GPS coordinates) are sent to xAI for online riders only.
  xaiApiKey: process.env.XAI_API_KEY,
  xaiModel: process.env.XAI_MODEL || 'grok-4-fast',

  // Optional: live vehicle positions for HART (Tampa) via Swiftly's
  // official real-time API (src/swiftlyRealtime.js). Unlike Hernando's
  // Passio and Pasco's Avail feeds -- both unauthenticated web-widget
  // endpoints -- HART's live source is a documented, key-authed vendor
  // API. Leaving this unset just means HART draws routes/stops but no
  // live buses (exactly today's behavior); the /api/live-buses merge
  // only wires HART in when a key is present, so an unset key never
  // causes a failing request. Request a key at goswift.ly/realtime-api-key.
  swiftlyApiKey: process.env.SWIFTLY_API_KEY,
  // Swiftly's real-time API host -- shared by the vehicle-positions,
  // service-alerts, and trip-updates (predictions) feeds. Overridable
  // mainly for testing; there's no reason to change it in production.
  swiftlyBaseUrl: process.env.SWIFTLY_BASE_URL || 'https://api.goswift.ly',
  // Swiftly namespaces every agency by its own key (NOT our internal
  // 'hart' agencyId). HART's Swiftly agencyKey is 'tampa' -- confirmed in
  // the Swiftly onboarding email (2026-09-24); using 'hart' returns HTTP
  // 403 on every feed. Still overridable via env in case Swiftly ever
  // renames it, so a change stays a one-line env edit, never a code change.
  swiftlyHartAgencyKey: process.env.SWIFTLY_HART_AGENCY_KEY || 'tampa',
  // Swiftly's service-alerts feed path. HART publishes GTFS-RT V2 alerts
  // whose "informed entity" fields the legacy `gtfs-rt-alerts` JSON
  // serializer can't represent -- requesting that path returns
  // HTTP 400 "Cannot convert V2 informed entity to V1 format". Swiftly's
  // versioned `gtfs-rt-alerts/v2` endpoint serves the V2 shape directly, so
  // that's the default. swiftlyGtfsRt.js falls back to the legacy path if
  // this one ever fails, so a wrong value self-heals; overridable here in
  // case Swiftly changes the path again. (Trip-updates need no /v2 -- they
  // have no V2-informed-entity problem -- so only alerts is versioned.)
  swiftlyAlertsPath: process.env.SWIFTLY_ALERTS_PATH || 'gtfs-rt-alerts/v2',

  // Cross-agency / cross-country trip planning (src/tripPlanner.js). We
  // proxy the free, community-run Transitous instance of the MOTIS
  // routing engine, which aggregates thousands of agency feeds worldwide.
  // No key needed; it's free for open-source / non-profit use, but it IS
  // volunteer-run, so a meaningful User-Agent (app name + version +
  // contact) is required on every request -- keep the default or set your
  // own contact. Point TRANSITOUS_BASE_URL at a self-hosted MOTIS
  // instance instead if you ever outgrow the donated service; the API is
  // identical, so no other code changes.
  transitousBaseUrl: process.env.TRANSITOUS_BASE_URL || 'https://api.transitous.org',
  tripPlannerUserAgent:
    process.env.TRIP_PLANNER_USER_AGENT ||
    'TriBus/1.0 (+https://github.com/malcolm1014/thebus-hernando)',
  // MOTIS's mode value for GBFS shared mobility (bike/scooter/car share).
  // Current MOTIS 2 (which Transitous runs) uses "RENTAL"; overridable in
  // case a future MOTIS renames it, so a wrong guess is a one-line env
  // change, not a code change. A rental-enabled plan that MOTIS rejects
  // falls back to a walk-only plan automatically (see src/tripPlanner.js),
  // so enabling shared mobility can only ever ADD options.
  transitousRentalMode: process.env.TRANSITOUS_RENTAL_MODE || 'RENTAL',

  // Optional: push notifications for followed-route service alerts even
  // when the app is closed, via Firebase Cloud Messaging (src/push.js).
  // FCM_SERVICE_ACCOUNT is the whole Firebase service-account JSON (one
  // line). Unset -> push is simply off (isConfigured() false), and
  // in-app + web notifications still work. See README "Push notifications
  // server" for the Firebase setup.
  fcmServiceAccount: (() => {
    const raw = process.env.FCM_SERVICE_ACCOUNT;
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('[config] FCM_SERVICE_ACCOUNT is set but is not valid JSON -- push disabled:', e.message);
      return null;
    }
  })(),
  // How often the server checks alerts and pushes to matching devices.
  // node-cron syntax; default every 2 minutes (only runs while the
  // instance is awake -- keep it warm for reliable delivery).
  pushCheckCron: process.env.PUSH_CHECK_CRON || '*/2 * * * *',

  // Optional: a real datastore for the push token registry (src/pushStore.js).
  // When DATABASE_URL is set (e.g. Render's managed Postgres), tokens +
  // notified-history persist across cold starts / redeploys; unset falls
  // back to the best-effort JSON file, which resets on a free-tier teardown.
  databaseUrl: process.env.DATABASE_URL || null,

  // Optional: keep the instance warm so the alert-push and ETL crons keep
  // firing on Render's free tier (which spins down after ~15 min idle). The
  // server pings its own public URL on a schedule. Render injects
  // RENDER_EXTERNAL_URL automatically; KEEP_WARM_URL overrides it, and
  // leaving both unset disables the pinger (e.g. locally). Every 10 min by
  // default -- comfortably under the ~15-min idle window.
  keepWarmUrl: process.env.KEEP_WARM_URL || process.env.RENDER_EXTERNAL_URL || null,
  keepWarmCron: process.env.KEEP_WARM_CRON || '*/10 * * * *',

  // On-disk locations. Everything here is regenerated by the ETL run and
  // is safe to delete -- nothing in backend/data is a source of truth,
  // the upstream GTFS feeds are. Each agency gets its own raw-extract
  // dir/zip path (data/raw/<agencyId>/, data/gtfs-<agencyId>.zip) so
  // e.g. Pasco's stops.txt can never overwrite Hernando's on disk before
  // either one is even parsed -- outputPath/aliasCachePath stay singular
  // since those hold the one final MERGED dataset/cache.
  dataDir: path.join(__dirname, '..', 'data'),
  rawDirFor: (agencyId) => path.join(__dirname, '..', 'data', 'raw', agencyId),
  zipPathFor: (agencyId) => path.join(__dirname, '..', 'data', `gtfs-${agencyId}.zip`),
  outputPath: path.join(__dirname, '..', 'data', 'transit_data.json'),
  aliasCachePath: path.join(__dirname, '..', 'data', 'alias-cache.json'),
};
