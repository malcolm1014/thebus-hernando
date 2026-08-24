# TheBus -- Hernando County Transit Terminal

Offline-first mobile transit assistant with a retro MS-DOS/CRT command-line
interface. A lightweight Node.js ETL server converts Hernando County's GTFS
feed into one flat JSON file; a Capacitor-wrapped vanilla JS app caches that
file on-device and answers rider questions with a regex-based rule engine
(no LLM, no network needed after first sync).

## Layout

```
thebus-hernando/
  backend/                  Node/Express ETL server (deploy to Render)
    src/
      config.js              env-driven paths/settings
      gtfsFetch.js            downloads + unzips the GTFS feed
      gtfsParse.js            CSV -> row objects, HH:MM:SS -> minutes
      transform.js            flattens routes/trips/stops/stop_times into
                               the stop-keyed structure the client wants
      etl.js                  orchestrates fetch -> parse -> transform -> write
      hash.js                 content hash used as the dataset "version"
    server.js                 GET /api/version, GET /api/download,
                               POST /api/refresh (secret-protected)
    data/                     generated at runtime (gitignored)

  frontend/                  Capacitor + vanilla JS/HTML/CSS
    capacitor.config.json
    www/
      index.html              terminal shell markup
      css/terminal.css         green-on-black CRT styling
      js/
        storage.js             Capacitor Filesystem/Preferences wrapper
                                (falls back to localStorage outside the shell)
        sync.js                 version check -> conditional download -> cache
        intentParser.js         regex intent classifier + entity extraction
        queryEngine.js           filters the cached dataset against device time
        app.js                   terminal UI wiring (input, history, "PROCESSING...")
```

## Backend: run it

```bash
cd backend
npm install
cp .env.example .env        # GTFS_FEED_URL is already filled in and verified live; set REFRESH_SECRET
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

Deploying to Render: set `GTFS_FEED_URL` and `REFRESH_SECRET` as
environment variables in the service dashboard, build command
`npm install`, start command `npm start`. Render's free tier sleeps when
idle, so the in-process `ETL_CRON` schedule won't fire reliably -- point
an external pinger (cron-job.org, UptimeRobot) at
`POST /api/refresh` with header `x-refresh-secret: <your secret>` instead.

## Frontend: run it

```bash
cd frontend
npm install
npm run add:android     # first time only -- generates the android/ project
# edit www/js/sync.js -> API_BASE to point at your deployed backend
npm run sync            # copies www/ into the native shell
npm run open:android    # opens Android Studio to build/run on device or emulator
```

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
   fuzzy-matches route/stop entities (exact substring first, word-overlap
   fallback second).
4. `queryEngine` filters that stop's/route's pre-flattened arrivals by
   which `service_id`s are active for the device's actual weekday/date,
   and by arrival time relative to the device clock -- entirely offline.

## Data flow (why the split)

The backend never answers a rider's question -- it only republishes GTFS
as flat JSON. All natural-language handling and time-based filtering
happens on-device against the cached file, which is what makes the app
usable with zero connectivity once the first sync has completed.
