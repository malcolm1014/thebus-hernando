# TheBus -- Hernando County Transit Terminal

Offline-first mobile transit assistant with a retro MS-DOS/CRT command-line
interface. A lightweight Node.js ETL server converts Hernando County's GTFS
feed into one flat JSON file; a Capacitor-wrapped vanilla JS app caches that
file on-device and answers rider questions with a regex-based rule engine
(no LLM, no network needed after first sync).

## Layout

```
thebus-hernando/
  render.yaml                Render Blueprint (points at backend/, secrets marked sync:false)

  backend/                  Node/Express ETL server (deploy to Render)
    src/
      config.js              env-driven paths/settings
      gtfsFetch.js            downloads + unzips the GTFS feed, with retry/backoff
      gtfsParse.js            CSV -> row objects, HH:MM:SS -> minutes
      transform.js            flattens routes/trips/stops/stop_times into
                               the stop-keyed structure the client wants;
                               resolves agency timezone, derives a headsign
                               from each trip's final stop when blank
      etl.js                  orchestrates fetch -> parse -> transform -> write;
                               refuses to overwrite a known-good dataset with
                               a suspiciously-smaller one (broken-feed guard)
      hash.js                 content hash used as the dataset "version"
    server.js                 GET /api/version, GET /api/download,
                               POST /api/refresh (secret-protected)
    test/                     node --test unit tests (transform, gtfsParse, ETL safety check)
    data/                     generated at runtime (gitignored)

  frontend/                  Capacitor + vanilla JS/HTML/CSS
    capacitor.config.json
    assets/                   icon.png (1024x1024), splash.png (2732x2732),
                               icon-source.svg -- source images for
                               @capacitor/assets; swap these for real
                               branding, then re-run `npm run gen:assets`
    www/
      index.html              terminal shell markup
      css/terminal.css         green-on-black CRT styling (self-hosted VT323,
                               phosphor-bloom glow, flicker, all motion gated
                               behind prefers-reduced-motion)
      assets/fonts/            VT323-Regular.woff2 (OFL-1.1, self-hosted)
      js/
        storage.js             Capacitor Filesystem/Preferences wrapper
                                (falls back to localStorage outside the shell)
        sync.js                 version check -> conditional download -> cache
        intentParser.js         regex intent classifier + fuzzy entity
                                extraction (exact substring -> word overlap
                                -> Levenshtein typo tolerance)
        queryEngine.js           filters the cached dataset against
                                agency-local time (not device-local),
                                correct across midnight
        app.js                   terminal UI wiring (input, history, "PROCESSING...")
```

## Backend: run it

```bash
cd backend
npm install
cp .env.example .env        # GTFS_FEED_URL is already filled in and verified live; set REFRESH_SECRET
npm test                    # 13 unit tests: transform.js, gtfsParse.js, ETL broken-feed guard
npm run etl                 # one-off: pull the feed, write data/transit_data.json
npm start                   # serve /api/version + /api/download on :3000
```

`GTFS_FEED_URL` in `.env.example` is Hernando County's real, currently-live
feed (confirmed 2026-08-24 -- see the comment above it in that file for
how to re-find it if the link ever moves). Ran end-to-end against it
during scaffolding: 8 routes / 369 stops parsed cleanly. That feed also
has two real-world quirks the code already accounts for -- worth knowing
if you extend the parser: `route_short_name` is blank for every route
(the rider-facing name like "Blue" or "Route 1 Red" lives only in
`route_long_name`, handled by `routeLabel()` in the frontend and the
long-name digit fallback in `intentParser.extractRoute()`), and
`trip_headsign` is blank for every trip (so `transform.js` derives an
effective destination from each trip's actual final stop instead).

If you're running this scaffolding from a Google Drive FUSE mount (as it
was built): `node_modules` -- thousands of small files -- doesn't survive
well there, and neither `rm -rf` on it nor a symlink workaround for it
succeed (this mount doesn't support symlinks, not just hardlinks). Do
`npm install` / builds in a real local directory or a RAM disk
(`/dev/shm/...`) instead, treating the gdrive copy as source-of-truth
only. Plain single-file writes back to gdrive (like `data/transit_data.json`,
gitignored, left in place from that validation run) are fine.

Deploying to Render: connect this repo and Render will pick up
`render.yaml` (repo root, `rootDir: backend`) automatically as a
Blueprint -- it'll prompt for `GTFS_FEED_URL`, `REFRESH_SECRET`, and
`ETL_CRON` (all marked `sync: false`, so they're entered once in the
dashboard rather than committed). Free tier sleeps when idle, so the
in-process `ETL_CRON` schedule won't fire reliably -- point an external
pinger (cron-job.org, UptimeRobot) at `POST /api/refresh` with header
`x-refresh-secret: <your secret>` instead.

The ETL also refuses to overwrite a known-good `transit_data.json` if a
re-pull comes back with >50% fewer stops or routes than last time
(`isSuspiciouslySmaller()` in `etl.js`) -- that's a broken/truncated feed,
not a real schedule change, and shipping it would silently break the app
for every cached client until the next good pull.

## Frontend: run it

```bash
cd frontend
npm install
npm run add:android     # first time only -- generates the android/ project (gitignored)
npm run gen:assets      # generates all icon/splash resolutions from assets/icon.png + assets/splash.png
# edit www/js/sync.js -> API_BASE to point at your deployed backend
npm run sync            # copies www/ into the native shell
npm run open:android    # opens Android Studio to build/run on device or emulator
```

`add:android` and `gen:assets` were both run and verified during
scaffolding (87 icon/splash files generated cleanly across all
densities) -- confirmed the pipeline works end-to-end, though the
`android/` output itself isn't committed (gitignored, regenerable, and
-- like `node_modules` -- not something you want thousands of small
files of on a Google Drive FUSE mount if you're building from one). The
placeholder `assets/icon.png` / `assets/splash.png` are a plain `>_`
terminal glyph + "THEBUS" on black, matching the app's own aesthetic --
swap them for real branding whenever you have it, then re-run
`npm run gen:assets`.

During development you can also just serve `www/` as a static site
(`npx serve www`) -- `storage.js` detects the absence of the Capacitor
runtime and falls back to `localStorage` automatically.

## How a query resolves

1. `app.js` captures the typed line, shows a "PROCESSING..." beat, then
   calls `TheBusQueryEngine.answerQuery(text, new Date())`.
2. `queryEngine` hands the text to `TheBusIntentParser.parseQuery()`,
   passing along an index of every route/stop name currently in the
   cached dataset (entities are only ever matched against real, current
   data -- never a hardcoded list).
3. `intentParser` classifies the intent via ordered regex triggers, then
   fuzzy-matches route/stop entities in three passes: exact substring,
   word-overlap (ties broken toward the more specific/longer name), then
   Levenshtein-distance typo tolerance ("Wallmart" -> "Walmart") as a
   last resort.
4. `queryEngine` computes "now" in the *agency's* timezone via `Intl`
   (not the device's own timezone -- GTFS times are agency-local
   wall-clock time, so a phone with its region set wrong would otherwise
   get wrong answers), correctly handles trips that cross midnight in
   both directions, and filters by which `service_id`s are actually
   active on that agency-local date -- entirely offline. Arrivals more
   than 30 minutes out show a plain clock time instead of a countdown
   (implied false precision that far ahead); a route with no more
   service today is called out by name rather than silently omitted
   from a multi-route stop's answer; asking about a route that doesn't
   serve the named stop says so directly instead of just showing
   nothing.

## Data flow (why the split)

The backend never answers a rider's question -- it only republishes GTFS
as flat JSON. All natural-language handling and time-based filtering
happens on-device against the cached file, which is what makes the app
usable with zero connectivity once the first sync has completed.
