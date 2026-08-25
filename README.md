# TheBus -- Hernando County Transit Terminal

Offline-first mobile transit assistant with a retro MS-DOS/CRT command-line
interface. A lightweight Node.js ETL server converts Hernando County's GTFS
feed into one flat JSON file; a Capacitor-wrapped vanilla JS app caches that
file on-device and answers rider questions with a regex-based rule engine
(no LLM, no network needed after first sync). A second tab adds a live map:
routes and stops draw from the same offline dataset, with real-time bus
positions overlaid when the device has a connection.

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
      passio.js                proxies Passio GO's real-time bus-position
                               feed (see "Live map" below) -- unofficial,
                               undocumented, reverse-engineered
      geocode.js                proxies OpenStreetMap Nominatim to resolve
                               a place name ("Springstead High School") to
                               coordinates for "nearest stop to X" queries
    server.js                 GET /api/version, GET /api/download,
                               GET /api/live-buses, GET /api/geocode,
                               POST /api/refresh (secret-protected)
    test/                     node --test unit tests (transform, gtfsParse, ETL safety check, passio shaping)
    data/                     generated at runtime (gitignored)

  frontend/                  Capacitor + vanilla JS/HTML/CSS
    capacitor.config.json
    assets/                   icon.png (1024x1024), splash.png (2732x2732),
                               icon-source.svg -- source images for
                               @capacitor/assets; swap these for real
                               branding, then re-run `npm run gen:assets`
    vendor/leaflet/            Leaflet 1.9.4 JS/CSS, self-hosted (BSD-2-Clause)
    www/
      index.html              terminal shell + live-map tab markup
      css/terminal.css         green-on-black CRT styling (self-hosted VT323,
                               phosphor-bloom glow, flicker, all motion gated
                               behind prefers-reduced-motion) + Leaflet
                               popup/control restyling to match
      assets/fonts/            VT323-Regular.woff2 (OFL-1.1, self-hosted)
      js/
        storage.js             Capacitor Filesystem/Preferences wrapper
                                (falls back to localStorage outside the shell)
        sync.js                 version check -> conditional download -> cache;
                                also exports API_BASE, shared with liveMap.js
        intentParser.js         regex intent classifier + fuzzy entity
                                extraction (exact substring -> word overlap
                                -> Levenshtein typo tolerance); also pulls
                                a free-text place name out of "nearest
                                stop to X" queries, deliberately NOT
                                matched against known stop/route names
        queryEngine.js           filters the cached dataset against
                                agency-local time (not device-local),
                                correct across midnight
        liveMap.js               draws routes/stops from the offline dataset,
                                polls /api/live-buses for real-time positions
        app.js                   terminal UI wiring + tab switching between
                                the terminal and map views
```

## Backend: run it

```bash
cd backend
npm install
cp .env.example .env        # GTFS_FEED_URL is already filled in and verified live; set REFRESH_SECRET
npm test                    # 19 unit tests: transform.js, gtfsParse.js, ETL broken-feed guard, passio.js response shaping
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

**A third, more consequential one, found while building the "nearest
stop" feature and worth knowing if you touch `transform.js`**: 81% of
this feed's `stop_times.txt` rows have both `arrival_time` and
`departure_time` blank -- standard GTFS practice for non-"timepoint"
stops (only major stops get exact published times; the rest are meant
to be interpolated). An earlier version of `transform.js` treated "no
time" as "not served," which silently dropped 89% of stops from their
own routes' "served by" lists -- fixed now (the stop-route relationship
is recorded unconditionally; only a *displayable arrival time* requires
a valid `minutes` value), but arrival-time **interpolation** for those
non-timepoint stops isn't implemented -- `queryEngine.js` says so
explicitly ("SERVES THIS STOP, BUT NO PUBLISHED TIMES ARE AVAILABLE FOR
IT") rather than guessing or claiming no service. Implementing real
interpolation (using `stop_sequence`/`shape_dist_traveled` between the
nearest bracketing timepoints) would be a good next improvement.

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
3. `intentParser` classifies the intent via **weighted scoring across
   every intent at once**, not ordered first-match regex -- see "Making
   the search foolproof" below for why this changed and where the
   design came from. It then fuzzy-matches route/stop entities in three
   passes: exact substring, word-overlap, then Jaro-Winkler typo
   tolerance ("Wallmart" -> "Walmart") as a last resort. Both the query
   and every candidate name pass through abbreviation normalization
   first (Blvd/Boulevard, Dr/Drive, N/Northeast, etc. all compare equal).
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
   nothing; if fuzzy matching finds 2+ equally-good candidates instead
   of one clear winner, the rider gets asked to be more specific instead
   of the app silently guessing.
5. `NEAREST STOP TO <place>` and `FIRST/LAST BUS AT <stop>` are also
   supported intents -- the former is the one query type that needs
   network (see "Nearest stop to anywhere" below), the latter answers
   from the stop's *entire* day's schedule rather than just what's
   still upcoming.

## Making the search foolproof

Every design decision in `intentParser.js` below is backed by research
into real transit chatbots, mature fuzzy-search libraries, address-
normalization standards, and disambiguation UX from established CLI
tools -- not guesswork. Six parallel research passes fed this; the
highlights:

- **Weighted intent scoring, not first-match-wins.** The old design
  checked intents in a fixed order and stopped at the first regex match
  -- a query containing both "when" and "where" was permanently locked
  to whichever intent happened to be checked first. Every intent now
  accumulates a score from its own trigger cues (strong cues worth more
  than weak ones) and the highest total wins, so "where's the closest
  stop with the next bus" resolves on actual signal strength. This
  exact strong-cue/weak-cue additive-scoring shape is a real, working
  pattern found in [`potatoes0089/transitai-utm-demo`](https://github.com/potatoes0089/transitai-utm-demo)
  (`js/intent.js`), not invented here.
- **Trigger phrase coverage** comes from two real production transit
  voice assistants, not brainstorming: [OneBusAway's Alexa skill](https://github.com/OneBusAway/onebusaway-alexa)
  (`interaction model/utterances.txt` -- ~50 real phrasings Amazon's
  certification process required, including the whole depart/leave/
  coming/approaching verb family and "how far away" framing the
  original trigger list missed) and [a university shuttle skill](https://github.com/pem5rm/BusTracker)
  (informal "gonna arrive"/"going to be at" phrasing).
- **Jaro-Winkler replaced plain Levenshtein** for the last-resort typo
  pass -- it specifically rewards a shared prefix, which fits how
  people actually mistype short place names (the error is usually
  mid-word, not at the start). Hand-implemented from the [standard
  algorithm](https://en.wikipedia.org/wiki/Jaro%E2%80%93Winkler_distance)
  to stay dependency-free. Its scoring aggregates across every matched
  query word (not just the single best word-pair) -- an earlier version
  of this pass scored on one best-matching word only, which let a
  typo'd query match the WRONG stop just because one incidental word
  scored well against it ("Plaz" matching "Plaza" inside an unrelated
  stop name); caught via real testing against actual stop data before
  shipping, not by inspection.
- **Abbreviation normalization** uses real entries from [libpostal's
  own dictionaries](https://github.com/openvenues/libpostal/tree/master/resources/dictionaries/en)
  (`street_types.txt`, `directionals.txt` -- libpostal's docs describe
  these as sourced from USPS Publication 28, the official U.S. postal
  abbreviation standard), not a guessed list. Restricted to safe,
  unambiguous forms -- deliberately skips single-letter road-type
  abbreviations (too likely to collide with ordinary short words) but
  keeps single-letter cardinal directions (n/s/e/w), which are
  unambiguous and heavily used in this feed's actual stop names.
- **Disambiguation instead of silent guessing** when fuzzy matching
  finds 2-4 equally-good candidates, following the *combined* precedent
  of two real, independently-converging sources: [git's actual "did you
  mean" source](https://github.com/git/git/blob/master/help.c) lists
  *every* command tied at the best score rather than picking one, and
  [OneBusAway's production stop-search code](https://github.com/OneBusAway/onebusaway-application-modules)
  explicitly comments that a fuzzy name match is "just a suggestion,"
  never auto-committed as a confident answer the way an exact ID match
  is. Only exact substring matches stay fully confident here; word-
  overlap and Jaro-Winkler matches get this tie-check. Deliberately
  did NOT add stateful "reply 1 or 2" numbered-menu disambiguation --
  research into text-only chat UX patterns recommended against it for
  an app this size (real scope increase for no real gain over listing
  alternatives and asking the rider to be more specific).
- **First/last bus** answers from the stop's whole-day schedule instead
  of just upcoming arrivals -- no real prior art exists for this intent
  in any transit chatbot surveyed (a genuine, confirmed gap in the
  ecosystem), but it was cheap to build correctly from data the app
  already has.
- **Deliberately NOT built**, per the research: full "from A to B" trip
  planning ([OpenTripPlanner](https://www.opentripplanner.org/)-style
  routing is confirmed overkill for an 8-route single-county system --
  small real transit voice apps surveyed don't attempt it either) and
  phonetic matching like Metaphone (not worth the implementation cost
  over Jaro-Winkler at a ~370-entry dataset size). Two real, scoped
  ideas surfaced but not built this round, for a future pass: "next bus
  toward X" / "when should I leave to get to X by TIME" (real intent
  patterns from [`BWHackathons/BusSkill`](https://github.com/BWHackathons/BusSkill),
  implementable by reusing the existing geocode + nearest-stop
  pipeline) and route-to-landmark proximity ("does bus X go near Y",
  feasible via point-to-polyline distance against the route
  `shapePoints` the map view already has).

## Nearest stop to anywhere

`nearest stop to Springstead High School` (or "closest bus stop near
X") resolves `X` to real coordinates via a geocoder, then finds the
actual closest stop by great-circle distance -- for literally any real
place, not just ones already in the GTFS stop list. This is deliberately
NOT a hand-maintained landmarks database: any such list would already be
incomplete the moment someone asks about a business not on it, and it'd
need constant upkeep as businesses open/close/rename. A geocoder solves
the general problem once instead.

Place names are resolved via **OpenStreetMap's Nominatim** (a free,
public geocoder) through `backend/src/geocode.js` -- proxied through our
own backend, not called directly from the app, both for Nominatim's
usage-policy requirements (a real identifying `User-Agent`, roughly
1 request/second across all callers -- enforced here with a small
request queue regardless of how many concurrent app users trigger a
cache-miss lookup) and so repeat lookups of the same place (schools,
common landmarks) get served from a 24-hour server-side cache instead of
hitting Nominatim again.

**Real limitation, not a bug**: Nominatim's data (OpenStreetMap) has
excellent coverage for schools, government buildings, parks, and chains,
but small independent local businesses are often simply not in it --
confirmed while building this: "Springstead High School" resolved
correctly on the first try, a real small Spring Hill deli did not, under
several phrasings. When that happens the app says so and suggests a
nearby road or better-known landmark instead of failing silently. If
broader small-business coverage matters, the natural upgrade path is
Google's Geocoding/Places API in place of (or alongside) Nominatim in
`geocode.js` -- but that needs a Google Cloud billing account and API
key, a decision left to you rather than made here.

## Live map

The "LIVE MAP" tab draws every route (as a colored polyline, from GTFS
`shapes.txt`) and every stop from the *same offline dataset* the terminal
search uses -- so routes/stops still render with zero connectivity. Live
bus positions are the one part of this app that genuinely can't work
offline (a cached bus position is actively misleading, not just stale),
so those are only overlaid when the device has a connection.

Real-time positions come from **Passio GO**
(`https://passiogo.com/?agency=5732`), the same tracker Hernando County
itself embeds on its own transit page. There's no official public API
for it -- `backend/src/passio.js` replicates the exact request shape
their own web widget uses, found by inspecting its network traffic
(`POST /mapGetData.php?getBuses=2` with `{s0: "5732", sA: 1}`). This is
the same approach the open-source
[`athuler/PassioGo`](https://github.com/athuler/PassioGo) project takes
for dozens of other agencies using the same vendor. Because it's
unauthenticated and undocumented, **Passio could change or remove this
without notice** -- that's an accepted risk of using it, since GTFS
static data has no real-time positions at all. It's proxied through our
own backend (`GET /api/live-buses`, 8-second in-memory cache) rather
than called directly from the app, both to avoid the app needing
cross-origin requests to a third party and so a future Passio change
only needs a backend update, not an app-store release.

`bus.routeId` from Passio is matched against our own GTFS `route_id` on
a best-effort basis -- their route `groupId` appeared to match our
`route_id` in Passio's static route list at build time, but this
couldn't be confirmed against a *live* bus payload (no vehicles were
running at the hour this was built/tested). If a bus's `routeId` doesn't
match anything in the dataset, the client falls back to Passio's own
`routeName` for the popup label and a neutral gray marker color instead
of the route's real color -- verify this once you've seen it during
actual service hours, and adjust `liveMap.js`/`passio.js` if the IDs
turn out not to align after all.

## Data flow (why the split)

The backend never answers a rider's question -- it only republishes GTFS
as flat JSON. All natural-language handling and time-based filtering
happens on-device against the cached file, which is what makes the app
usable with zero connectivity once the first sync has completed.
