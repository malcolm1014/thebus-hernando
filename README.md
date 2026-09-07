# TriBus -- Nature Coast to Tampa Bay Transit Terminal

Offline-first REGIONAL transit assistant with a retro MS-DOS/CRT command-line
interface, covering multiple Florida transit agencies -- not just one county.
A lightweight Node.js ETL server pulls GTFS feeds from several agencies,
merges them into one flat JSON file (see "Multi-agency architecture" below),
and a Capacitor-wrapped vanilla JS app caches that file on-device and answers
rider questions -- including full "from A to B" trip planning that can cross
agency boundaries -- with a regex-based rule engine (no LLM, no network
needed after first sync). A second tab adds a live map: routes and stops
draw from the same offline dataset, with real-time bus positions overlaid
when the device has a connection.

TriBus started as a single-county app ("TheBus", Hernando County only) --
that origin is still visible in some internal names (the `TheBus*` JS module
namespace, the `thebus-hernando` repo/backend-service name, the
`com.savvysecurity.thebus` Android package id) that were deliberately left
unchanged during the rename: renaming any of those has a real operational
cost (a new Android package id means every existing install is treated as a
brand-new app, losing all local data; renaming the live Render service
breaks the URL the already-shipped app is hardcoded to hit) that wasn't part
of this pass. Only rider-visible branding (the app's display name/title,
onboarding text) was renamed.

## Layout

```
thebus-hernando/
  render.yaml                Render Blueprint (points at backend/, secrets marked sync:false)

  backend/                  Node/Express ETL server (deploy to Render)
    src/
      config.js              env-driven paths/settings; `agencies[]` -- one
                               entry per configured GTFS_FEED_URL_* (see
                               "Multi-agency architecture" below)
      gtfsFetch.js            downloads + unzips ONE agency's GTFS feed
                               (to its own data/raw/<agencyId>/), with
                               retry/backoff
      gtfsParse.js            CSV -> row objects, HH:MM:SS -> minutes, for
                               one agency's raw dir
      transform.js            flattens one agency's routes/trips/stops/
                               stop_times into the stop-keyed structure the
                               client wants; resolves that agency's own
                               timezone, derives a headsign from each trip's
                               final stop when blank; namespaces every id
                               with `${agencyId}:` when told which agency
                               it's transforming (`mergeAgencyData` then
                               combines several agencies' output into one
                               dataset with zero id collisions)
      etl.js                  orchestrates fetch -> parse -> transform for
                               EVERY configured agency (in parallel), merges
                               them, and writes the result; one agency's
                               feed failing falls back to that agency's own
                               slice of the last known-good merge rather
                               than failing the whole run or blanking that
                               agency out (extractAgencySlice/
                               fetchAndTransformAgency); still refuses to
                               overwrite a known-good MERGED dataset with a
                               suspiciously-smaller one (broken-feed guard,
                               now watching the combined totals)
      hash.js                 content hash used as the dataset "version"
      compact.js              wire-format compaction applied only in
                               writeDataset() below, right before bytes
                               hit disk -- see "Keeping the payload lean"
      passio.js                proxies Passio GO's real-time bus-position
                               feed (Hernando only, see "Live map" below)
                               -- unofficial, undocumented, reverse-engineered
      pascoRealtime.js          same idea, PascoGo's own real-time vendor
                               (Avail/myStop, a DIFFERENT vendor than
                               Passio -- see "Live map" below)
      geocode.js                proxies OpenStreetMap Nominatim to resolve
                               a place name ("Springstead High School") to
                               coordinates for "nearest stop to X" queries
    server.js                 GET /api/version, GET /api/download,
                               GET /api/live-buses, GET /api/geocode,
                               POST /api/refresh (secret-protected)
    test/                     node --test unit tests (transform, gtfsParse, ETL safety check,
                               passio shaping, shape-polyline simplification) -- also run in CI
                               (.github/workflows/backend-tests.yml) on every push, though it
                               doesn't yet gate Render's own auto-deploy
    data/                     generated at runtime (gitignored)

  frontend/                  Capacitor + vanilla JS/HTML/CSS
    capacitor.config.json
    keystore/debug.keystore    fixed debug signing key (see "CI signing" below) -- not sensitive, debug-only
    assets/                   icon.png (1024x1024), splash.png (2732x2732),
                               icon-source.svg -- source images for
                               @capacitor/assets; swap these for real
                               branding, then re-run `npm run gen:assets`
    vendor/leaflet/            Leaflet 1.9.4 JS/CSS, self-hosted (BSD-2-Clause) --
                               default marker/layers-control images stripped, unused
                               (custom icons only), trims ~7.5KB of dead weight
    test/                     node --test unit tests for intentParser.js/queryEngine.js
                               (real IIFE modules loaded into Node's global scope, see
                               test/helpers.js) -- every behavior described below is
                               regression-tested, not just verified once during development
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
                                also exports API_BASE (shared with liveMap.js)
                                and expandDataset() (reverses the backend's
                                wire-format compaction, see "Keeping the
                                payload lean")
        intentParser.js         weighted-scoring intent classifier + fuzzy entity
                                extraction (exact substring -> word overlap
                                -> Jaro-Winkler typo tolerance), abbreviation
                                normalization, disambiguation on tied matches;
                                also pulls a free-text place name out of "nearest
                                stop to X" queries, deliberately NOT matched
                                against known stop/route names (see "Making the
                                search foolproof" below for the full story)
        queryEngine.js           filters the cached dataset against
                                agency-local time (not device-local),
                                correct across midnight; also plans
                                "from A to B" trips -- a bounded (up to
                                MAX_TRANSFERS) earliest-arrival search
                                that can cross agency boundaries via a
                                short walking transfer between two
                                different agencies' nearby stops, see
                                "Planning a trip from A to B" below
        liveMap.js               draws routes/stops from the offline dataset,
                                polls /api/live-buses for real-time positions
        app.js                   terminal UI wiring + tab switching between
                                the terminal and map views
```

## Multi-agency architecture

TriBus merges GTFS feeds from several independent Florida transit
agencies into one dataset, rather than being built for a single county.
As of this writing:

| Agency | Status | Feed |
|---|---|---|
| Hernando County Transit | Live | `GTFS_FEED_URL_HERNANDO` (originally just `GTFS_FEED_URL`) |
| PascoGo (Pasco County) | Live | `GTFS_FEED_URL_PASCO` -- also has its own GTFS-Realtime feed (not yet consumed here, see "Live map" below) |
| HART (Hillsborough/Tampa) | Live | `GTFS_FEED_URL_HART` -- a full metro system, much bigger than the other two (~3.6MB raw vs. Hernando's ~500KB) |
| Citrus County Transit | **Not live** | Feed found (their `bus_routes.php` page's "CCT GTFS Data" link), but hosted on a Cloudflare-protected CMS that blocks automated fetching entirely -- confirmed via curl (multiple user-agents/referers, HTTP 403) AND a real interactive browser navigating to the link twice with an 8s wait for any "under attack mode" interstitial (HTTP 503 both times). Listed inactive in `config.js`'s `AGENCY_DEFS` -- setting `GTFS_FEED_URL_CITRUS` activates it with no code change, whenever a workaround exists (most likely a headless-browser fetch step, deliberately not built yet given the added deployment weight/risk for one agency) |

**How the merge works** (`backend/src/transform.js`, `backend/src/etl.js`):

1. `etl.js` fetches, parses, and transforms EVERY configured agency in
   parallel, each in its own try/catch -- one agency's feed being
   temporarily down doesn't take the others with it, and doesn't fail
   the whole run either. A failed agency falls back to its own slice of
   the last known-good merged dataset (`extractAgencySlice`) if one
   exists, so a transient outage never blanks that agency out of the app
   riders already have.
2. `transform()` takes an optional `agencyMeta: { id, label }`. When
   given, every id it produces (`route_id`, `stop_id`, `service_id`,
   `trip_id`) is namespaced `${id}:${rawId}`, and every stop/route is
   tagged `agencyId`/`agencyLabel`. This is what makes it safe to merge
   several agencies' independent feeds -- two counties both using "R1"
   or "WEEKDAY" as their own internal ids is expected, not a coincidence
   to guard against. Omitted (the default), every id passes through
   unchanged -- the exact original single-feed behavior, so this is a
   non-breaking addition, not a rewrite.
3. `mergeAgencyData()` combines the namespaced outputs into one dataset,
   plus a top-level `agencies: {}` map (label/timezone/counts per
   agency) and a single `agencyTimezone` picked as the most common
   timezone across agencies (all 4 real agencies here are
   America/New_York, so this is moot today, but the pick is real and
   tested rather than hardcoded).
4. On the client, `routeLabel()` (`queryEngine.js`) prefixes a route's
   own `agencyLabel` onto every mention when present ("PASCOGO ROUTE 1")
   -- otherwise two different agencies' routes sharing a number would be
   genuinely ambiguous in a trip itinerary that crosses between them.
   Absent on a single-agency dataset, so this is invisible to a
   deployment that never merges anything.

**Known simplification**: the client (`queryEngine.js`'s `agencyTz()`)
still computes "now" in exactly ONE timezone for the whole merged
dataset. True and tested for all 4 real agencies here (all
America/New_York) -- would need revisiting if a future agency in a
different timezone were ever added.

## Backend: run it

```bash
cd backend
npm install
cp .env.example .env        # GTFS_FEED_URL is already filled in and verified live; set REFRESH_SECRET
npm test                    # 21 unit tests: transform.js, gtfsParse.js, ETL broken-feed guard, passio.js response shaping, shape-polyline simplification
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
npm test                # 25 unit tests: intentParser.js + queryEngine.js against a mock dataset
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
   still upcoming, alongside a same-day average headway (see below).
   `TIMETABLE FOR ROUTE <N>` (optionally `AT <stop>`) is a further
   distinct intent (`SHOW_TIMETABLE`) -- every published time today for
   one route at one stop, not just what's upcoming (`FIND_NEXT_ARRIVAL`)
   or the bare list of stops with no times at all (`LIST_ROUTE_STOPS`);
   defaults to the route's first stop with published times when none is
   named, clearly labeled as a default rather than guessing silently.
   Deliberately narrow trigger phrasing ("timetable", "all the times",
   "full schedule") so it doesn't collide with the existing, already
   regression-guarded bare "schedule" cue that resolves to
   `LIST_ROUTE_STOPS` (see `intentParser.test.js`).
6. **Headway summaries**: `computeHeadwayMinutes` (`queryEngine.js`)
   buckets a route's published stop times into rough time-of-day windows
   (early morning / morning rush / midday / evening rush / evening) and
   reports the median gap between consecutive departures in whichever
   window "now" falls into -- "ABOUT EVERY 20 MIN, MORNING RUSH" -- when
   asking about a specific named route (a bare "next bus" listing across
   every route at a stop doesn't show this, to avoid repeating it per
   route). Needs at least 3 same-window departures to call it a real
   pattern rather than a coincidence of 2 trips.
7. A genuinely **broad, no-stop-named question** ("when's the next
   bus?", "when is the next stop?", "any buses nearby", "is the bus
   close") is treated as shorthand for "at my current location" rather
   than a failure to parse -- both `FIND_NEXT_ARRIVAL` and
   `FIND_NEAREST_STOP` fall back to the device's GPS position whenever
   no stop/place was named at all, the same way an explicit "...to me"
   already did. `intentParser.js`'s cue table includes several
   locationless phrasings specifically so these don't get missed by
   intent classification and fall through to the generic help text
   instead (a real gap: "any buses nearby" used to score 0 on every
   intent).

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
- **Bare highway numbers now match their prefixed form in stop names**
  ("on 19" matches "US19"). Found via a real report that "closest bus to
  walmart on 19" had stopped giving a definitive answer: the stop is
  named "Walmart US19 Spring Hill" in the feed, but nobody types "US19"
  out loud, and short tokens ("19", 2 chars) were being filtered out of
  matching entirely regardless. Fixed with a narrow, boundary-checked
  rule (a numeric query token matches a name token it's a suffix of, so
  "19" matches "us19" but not the unrelated "19" inside "119") rather
  than just lowering thresholds broadly, since a highway number alone is
  common to every stop strung along that road -- weak evidence on its
  own. When candidates tie on score, one that ALSO matched a real
  distinctive word (a business name) wins outright over ones that only
  share the road number, instead of the two being treated as a genuine
  ambiguous tie. Regression-guarded in `test/intentParser.test.js`.
- **Revisited: "from A to B" trip planning is now built** (`PLAN_TRIP`,
  see "Planning a trip from A to B" below) -- originally scoped out here
  as OpenTripPlanner-style overkill for an 8-route system, but a full
  RAPTOR implementation was never actually the alternative to "not
  built": a bounded (0-or-1-transfer) earliest-arrival search over this
  small a dataset is cheap to brute-force directly, and real riders
  asked for exactly this question shape. **Deliberately NOT built**,
  still: phonetic matching like Metaphone (not worth the implementation
  cost over Jaro-Winkler at a ~370-entry dataset size). Two real, scoped
  ideas surfaced but not built this round, for a future pass: "next bus
  toward X" / "when should I leave to get to X by TIME" (real intent
  patterns from [`BWHackathons/BusSkill`](https://github.com/BWHackathons/BusSkill),
  implementable by reusing the existing geocode + nearest-stop
  pipeline) and route-to-landmark proximity ("does bus X go near Y",
  feasible via point-to-polyline distance against the route
  `shapePoints` the map view already has).

## The 3-tier search architecture

The search/chat engine resolves every place-like query against three
tiers of data, cheapest and most-confident checked first, so answers
get faster and more reliable the more the app is actually used:

- **TIER 1 -- GTFS** (`queryEngine.js`'s `index.stops`/`index.routes`):
  authoritative, ships with the app, always present offline. Every
  stop/route lookup in the app is ultimately checked against this tier.
- **TIER 2 -- PLACES** (`searchIndex.js`): real-world places (a
  business, school, landmark) the geocoder has successfully resolved
  before. The first lookup costs a network round trip like any
  geocoder call; every lookup after that is a local coordinate match,
  offline and instant -- the app's knowledge of "real places near here"
  only ever grows with use, the same way a search engine's index grows.
  Persisted on-device (via `TheBusStorage`/Capacitor Preferences),
  capped at 200 entries with LRU eviction so it can't grow unbounded
  over months of use.
- **TIER 3 -- LANGUAGE** (`searchIndex.js`): a learned phrase->answer
  cache. The first time any exact phrase resolves confidently (to a
  Tier 1 stop or a Tier 2 place), that literal phrase is remembered --
  the next time anyone asks the exact same thing, it's an instant,
  guaranteed-consistent hit with zero matching or network work at all.
  This is the same **search-log caching** idea real search engines use
  for repeat queries (a well-established IR technique, not a
  hand-guessed slang dictionary) -- it only ever contains phrasing an
  actual rider actually typed and got a real answer for, capped at 300
  entries with the same LRU eviction as Tier 2.

`searchIndex.js` owns Tiers 2 and 3 as one small persisted JSON blob,
loaded once per app launch and kept warm in memory for the rest of the
session (mirrors how the Tier 1 dataset itself is loaded once via
`setDataset()`). 5 dedicated tests in `test/searchIndex.test.js` cover
the matching, persistence, and eviction logic directly; 2 more
integration tests in `test/queryEngine.test.js` (plus the existing
Tier 1 / GPS ones) prove the tiers are actually reached in the right
order end-to-end.

## Nearest stop to anywhere

`nearest stop to Springstead High School` (or "closest bus stop near
X") resolves `X` by walking the tiers above, in order:

1. **TIER 3 (LANGUAGE)** -- this exact phrase resolved confidently
   before. Instant, offline, and guaranteed to give the same answer as
   last time.
2. **TIER 1 (GTFS)** -- `X` is already the (informal) name of a known
   stop itself. "walmart on 19" for the real stop "Walmart US19 Spring
   Hill" -- checked entirely offline against the same fuzzy stop-name
   matching every other query type uses, before any network call is
   even considered. This is what gives well-known places (which is
   exactly what a lot of stop names already ARE -- shopping centers,
   schools, plazas) a fast, fully confident, single-answer response
   instead of always paying for a geocode round trip. Only fires when
   the match is unambiguous (see the "did you mean" tie logic above) --
   a genuinely ambiguous phrase still falls through instead of guessing.
3. **GPS** -- `X` is the rider's own position ("nearest stop to me" /
   "...to here") -- pulled from the device's GPS via
   `@capacitor/geolocation` (see below) rather than being handed to the
   geocoder, which has no way to resolve "me" to anything. Deliberately
   never cached in Tiers 2/3, since "me" means a different point every
   single time.
4. **TIER 2 (PLACES)** -- `X` matches a real place this device has
   geocoded before, even under different wording than what originally
   found it (fuzzy-matched the same way Tier 1 stop names are).
   Offline, no network needed a second time.
5. **NETWORK** -- `X` is a genuine external place never seen before --
   resolved to real coordinates via a geocoder, then matched to the
   actual closest stop by great-circle distance. This is deliberately
   NOT a hand-maintained landmarks database: any such list would
   already be incomplete the moment someone asks about a business not
   on it, and it'd need constant upkeep as businesses open/close/rename.
   A geocoder solves the general problem once instead -- and a
   successful lookup here is folded straight into Tiers 2 and 3, so the
   NEXT rider who asks about the same place (or the same rider asking
   again) never pays the network cost again.

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

`geocode.js`'s `VIEWBOX` (and the ", FL" appended to every search query)
covers the whole tri-county service area, not just Hernando -- this was
still hardcoded to Hernando County alone through the initial Pasco/HART
expansion (a stale leftover from before this app covered more than one
county), found and fixed during a later research/refinement pass. Left
unwidened, a landmark search for a real Tampa or Pasco business would
have been biased toward, or could have missed in favor of, an unrelated
same-named result outside Hernando entirely.

## Planning a trip from A to B

`PLAN_TRIP` ("I need to go from Publix Lakewood Plaza to Kass Circle",
"how do I get from X to Y", "directions from X to Y") plans a real,
timed, multi-leg itinerary instead of answering about one stop at a
time -- entirely deterministic, offline, and LLM-free, same as every
other intent in this app (the only LLM anywhere in this codebase is
`backend/src/enrich.js`'s ETL-time alias generation, which never runs at
query time -- see "Data flow" below for why that split exists).

1. **Both ends are resolved through the exact same tiered landmark
   resolution `FIND_NEAREST_STOP` uses** (`resolveLandmark()` in
   `queryEngine.js`, extracted from that intent's own code so both share
   one implementation) -- a named stop, a real-world place via the
   geocoder, or "me"/"here" via GPS all work identically for either end.
   A resolved KNOWN STOP is used exactly as named (zero walking assumed
   -- the rider said that exact stop); a resolved real-world POINT
   instead gets the nearest few stops (up to 3, within 0.75 mi) as
   boarding candidates, each with an estimated walk time.
2. **`getTripsIndex()` reconstructs every real trip's own ordered
   (stop, time) path** from data the client already has -- no backend/
   ETL change needed. Every stop's `routes[].arrivals` entry already
   carries its `tripId`; grouping those by `tripId` across every stop
   and sorting by raw minutes recovers a trip's true stop order (GTFS
   keeps a trip's own times monotonically increasing, including
   past-midnight rows). Built once per dataset load and cached.
3. **The search itself is a bounded (up to `MAX_TRANSFERS`, currently 3)
   earliest-arrival search** (`relaxRound()`/`seedReach()`): round 0 is
   the boarding candidates themselves; each later round treats every
   stop reached so far (plus a real transfer buffer) as a new boarding
   point and finds everywhere reachable with one additional ride.
   Genuinely unbounded, OpenTripPlanner-style routing is still scoped
   out (see "Making the search foolproof" above) -- but a *bounded*
   multi-transfer search is cheap to brute-force even across a merged
   multi-agency dataset, via `getStopTripIndex()` (a reverse index --
   which trips pass through a given stop, and where -- so each round
   only ever examines trips that actually reach a candidate stop,
   instead of scanning every trip in the system per candidate). 3
   transfers comfortably covers a full regional journey (e.g. Hernando
   -> Pasco -> HART/Tampa) while staying bounded and fast.
4. **A round can also walk to a nearby DIFFERENT agency's stop before
   boarding** (`getNearbyStopsIndex()`) -- this is the actual mechanism
   that makes cross-county trip planning possible at all. Two
   independently-run transit agencies never share a literal stop id;
   GTFS has no concept of "these two agencies' stops are the same
   place." A real-world regional transfer only ever exists as "get off
   here, walk a short distance (capped at `TRANSFER_WALK_MAX_MILES`,
   0.3 mi), board a different agency's bus over there." The index is a
   coarse spatial-hash (grid-bucketed) precomputation of every stop's
   nearby OTHER-agency stops, built once per dataset load -- on a
   single-agency dataset every stop's `agencyId` is `undefined`, so the
   same-agency exclusion check means this index is always empty and
   adds no behavior change for a non-merged deployment.
5. **The itinerary with the lowest total real-world time wins** -- ride
   time plus every walk segment (both ends, and any mid-trip
   cross-agency transfer) -- preferring fewer transfers whenever two
   itineraries would arrive at the same time (a "transfer" that doesn't
   actually save time is never surfaced as if it were a genuine
   alternative). Two places within 0.2 mi of each other get told to
   just walk instead of being offered a bus itinerary for no real gain.

**Known simplification, documented rather than silently wrong**: like
`dayArrivals()`'s existing accepted simplification for overnight
service, a single TRIP that itself straddles midnight would have its
early and late stops resolved against different calendar-day references
independently (see the comment on `resolveArrivalTiming()`). Not
observed in this feed (daytime-only weekday service -- see
`MANUAL_TEST_SCRIPT.md`), so not specially handled.

## First-launch onboarding

Two modals appear once, on the very first launch, then never again
(tracked via `TheBusStorage.getOnboardingSeen()`/`setOnboardingSeen()`,
a Preferences-backed flag):

1. **A location-consent prompt** ("SHARE YOUR LOCATION?") with two
   buttons -- sharing triggers the actual OS permission dialog right
   then (via `TheBusGeolocate.getCurrentPosition()`), so the ask is
   tied to a real, explained, in-context user action rather than firing
   silently on boot. Declining just skips it -- nothing is requested.
2. **A brief how-to-use card**, closed with an X in the top-right
   corner, listing the handful of question shapes the app understands.

Both are plain overlay `<div>`s styled to match the terminal aesthetic
(`.modal-overlay`/`.modal-box` in `terminal.css`), not a native
Capacitor dialog plugin -- consistent with the rest of the UI being
hand-built HTML/CSS rather than native chrome. `app.js` shows the
location modal immediately on boot (not gated on the data sync
finishing, so a slow Render cold-start doesn't delay it) and guards the
existing auto-focus-the-input calls so the on-screen keyboard can't pop
up behind an open modal. Verified in a real browser via `claude-in-chrome`
against a local `python3 -m http.server` (both button paths, the X
close, and that the flag persists across a reload) before shipping --
this is UI/DOM wiring in `app.js`, which isn't covered by the
`node --test` suite (that suite covers the pure logic modules:
`intentParser.js`/`queryEngine.js`/`searchIndex.js`).

## Live map

The "LIVE MAP" tab draws every route (as a colored polyline, from GTFS
`shapes.txt`) and every stop from the *same offline dataset* the terminal
search uses -- so routes/stops still render with zero connectivity. Live
bus positions are the one part of this app that genuinely can't work
offline (a cached bus position is actively misleading, not just stale),
so those are only overlaid when the device has a connection.

**County selector**: one button per agency in the current dataset
(built from `dataset.agencies`, never hardcoded -- see "Multi-agency
architecture" above), plus a "TRI-COUNTY" button showing every county
at once. TRI-COUNTY is the default whenever a new/updated dataset
loads; picking an individual county re-fits the map to just that
region's stops/routes -- drawing all ~3,600 stops across 3 counties at
once is both visually unreadable and unnecessary render cost when a
rider only cares about one county. Real-time bus tracking is gated per
selection (see below) -- switching to a county with no live feed says
so honestly instead of leaving "CONNECTING..." up forever.

**Scope note**: real-time positions cover Hernando + Pasco; **HART has
no live source wired in yet**. HART has an official, documented
GTFS-Realtime feed via Swiftly (`https://api.goswift.ly/real-time/
tampa/gtfs-rt-vehicle-positions`, plus a separate trip-updates
endpoint) -- the "correct" path rather than reverse-engineering. The
API key request has been submitted via Swiftly's form
(`goswift.ly/realtime-api-key`) -- Swiftly says to allow up to 5
business days before following up at support@goswift.ly. Once the key
arrives: standard GTFS-RT is protobuf-encoded, not plain JSON like
Passio/Avail, so consuming it should use MobilityData's official
`gtfs-realtime-bindings` npm package rather than a hand-rolled parser --
unlike Passio/Avail, this is a real published spec, not an undocumented
vendor shape needing defensive field-name guessing.

### GPS refinement, vehicle allocation, and trajectory rendering

A research pass across ~120 open-source transit/mapping projects (OSRM/
Valhalla/FMM-style map-matchers, OneBusAway/Transitime's AVL trip
matching, Leaflet-based live-transit-map viewers) surfaced techniques
adopted here without adding any new runtime dependency -- all pure
vanilla JS, matching this app's offline-first, no-bundler stack:

- **`geoMath.js`**: nearest-point-on-polyline + bearing math. Used to
  snap a raw vendor GPS fix onto its own route's shape before rendering
  it (`MAX_SNAP_DISTANCE_METERS`, `liveMap.js`) -- Passio/Avail fixes
  routinely land a lane-width or two off the real road, which reads as
  much more precise once projected onto the route line, without ever
  snapping an implausible/off-route fix somewhere nonsensical.
- **`vehicleAllocation.js`**: Passio/Avail only ever report a `routeId`,
  never a `trip_id`. This reconstructs each trip's own stop-to-stop
  schedule from data already in the dataset (via `queryEngine.js`'s
  `getTripsIndex()`) and scores which specific trip a live vehicle is
  probably running, by comparing its actual position against where that
  trip's own schedule says it should be right now -- disambiguating two
  opposite-direction trips sharing the same stops via heading, and
  sticky against ordinary GPS jitter between polls (`liveMap.js`'s
  `pickTripWithStickiness`) so the match doesn't flap every ~10s poll.
  Once a trip is confidently matched, `estimateScheduleDeviationMinutes`
  gives a real "running ~6 min late/early" estimate in the map's bus
  summaries -- something neither vendor's feed provides on its own.
- **Trajectory rendering** (`liveMap.js`): marker movement is
  interpolated between polls via `requestAnimationFrame` instead of
  teleporting to each new position; the bus icon rotates by its reported
  heading; clicking a route's line toggles a highlight (dims every other
  route) via `setHighlightedRoute`; and markers fade progressively
  during a failed/stale poll (`applyStaleFade`) instead of either
  vanishing outright or looking falsely live forever.
- **`geolocate.js`**: replaced the single one-shot `getCurrentPosition()`
  read with `watchBestFix` -- watches for up to 10s, keeping whichever
  fix reports the smallest accuracy radius, returning early once one is
  "good enough" (20m). A real Kalman filter assumes a continuous stream
  of readings to smooth between; this app only ever reads GPS once per
  rider query, so a bounded best-of-several-samples approach fits the
  actual usage pattern instead.
- **`liveBusSanity.js`**: neither vendor's payload carries a
  per-vehicle timestamp to check staleness against, but both have been
  observed to report a raw `(0, 0)` "unset GPS" sentinel or coerce a bad
  field to `NaN` -- filtered out once at `server.js`'s `/api/live-buses`
  merge point rather than duplicated per vendor parser.

`GET /api/live-buses` merges every agency with a working source via
`Promise.allSettled` -- one vendor being down or changing its API
doesn't blank out the other's real buses, the same "one bad source
shouldn't break everything" approach `etl.js` already takes for a
single agency's schedule feed failing. Each bus is tagged with its
`agencyId` so the client can filter markers to match the Live Map's
county selector (`liveMap.js`'s `startPolling(intervalMs, onUpdate,
agencyFilter)`) -- picking a single county only shows that county's
buses; TRI-COUNTY shows every agency's at once.

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

PascoGo's real-time positions come from a **different vendor** --
checked properly, not assumed to be the same as Hernando's: PascoGo's
tracker (`https://gopasco.rideralerts.com/InfoPoint/`) is Avail
Technologies' "InfoPoint"/**myStop®** product (confirmed by its own
"Powered by avail" footer and `MyAvail.*` JS bundle names), unrelated
to Passio. `backend/src/pascoRealtime.js` replicates its own request
shape the same way `passio.js` does for Hernando -- found by inspecting
the InfoPoint widget's real network traffic, not documented publicly:
`GET rest/Routes/GetVisibleRoutes` for the route list (cached 10
minutes -- it barely changes), then `GET
rest/Vehicles/GetAllVehiclesForRoutes?routeIDs=<every route id, comma-
separated>` for live positions, confirmed to accept every route in one
call with no authentication needed for either endpoint. **The exact
vehicle field names are unverified against a live payload** -- no buses
were running at the hour this was built (confirmed via the page's own
clock, well outside Pasco's daytime service hours) -- so
`normalizeVehicle()` defensively checks several plausible Avail
field-name casings (`Latitude`/`lat`, `Heading`/`CalculatedCourse`/
`Direction`, etc.) rather than committing to one guess; confirm the
real names against a live response during weekday daytime service and
trim the fallback list down, the same verification MANUAL_TEST_SCRIPT.md
already asks for on other unconfirmed-until-real-service-hours behavior.

## Keeping the payload lean

The full offline dataset (`transit_data.json`, downloaded on first sync
and every schedule change after that) was 263KB for Hernando alone, down
from 327KB before a deliberate pass to trim it -- meaningful on a phone
that might be syncing over a weak connection.

**This got a lot less lean once HART joined the merge -- measured, not
guessed**: running the real ETL against Hernando+Pasco+HART produced a
**51MB** `transit_data.json`. Broken down by actually measuring
`JSON.stringify` byte counts per field (not estimated): 97.1% of it was
`stop.routes[].arrivals[]` -- 442,588 individual arrival rows, the
natural consequence of HART being a full metro system (411,239 of those
442,588 arrivals are HART's alone, vs. Hernando's original ~1,800).
Route polylines, by contrast, stayed a rounding error at this scale
(0.1% of the total) -- the Douglas-Peucker work below still matters at
Hernando's own scale, just not at the merged one.

**Fixed via wire-format compaction** (`backend/src/compact.js`,
`frontend/www/js/sync.js`'s `expandDataset`) -- **51MB -> 14.9MB, a 71%
reduction**, verified with a real re-run, not projected. Each arrival
was a 4-key JSON object (`{tripId, serviceId, headsign, minutes}`)
repeating largely non-unique strings verbatim: this feed has only ~22
distinct `serviceId`s and a few hundred distinct headsigns shared across
all 442,588 rows, and even `tripId` (unique per real trip) still repeats
roughly once per stop that trip visits (~37x on average). `compactForWire()`
interns every arrival's 3 strings into one shared `stringPool` and
stores each arrival as a compact `[tripIdx, serviceIdx, headsignIdx,
minutes]` array instead of a 4-key object -- which also eliminates the
repeated JSON key-name bytes a plain string-interning pass alone
wouldn't touch. This is a PURE transport-layer optimization: it runs
only in `etl.js`'s `writeDataset()` (right before the bytes hit disk)
and is reversed only in the client's `activateDataset()` (right after a
dataset loads, from any source) via a matching `expandDataset()` --
`transform.js`/`mergeAgencyData()` and `queryEngine.js` never see the
compact shape at all, so none of their extensive existing tests needed
to change. `etl.js`'s own `readPreviousData()` (used for the
broken-feed-size guard and the per-agency fetch-failure fallback) mirrors
this with a backend-side `expandFromWire()`, since that fallback path
feeds data straight back into `mergeAgencyData()` as if it were fresh
`transform()` output -- skipping this expansion would have silently
double-compacted an already-compact fallback dataset.

**Not addressed this round, real remaining opportunities if 14.9MB still
needs trimming further**: HART's shapes could be simplified more
aggressively than Hernando's tighter tolerance; the dataset could ship
only a rolling window of arrivals (e.g. today + tomorrow) instead of a
feed's entire multi-week schedule; or agencies could sync as separate,
independently-cacheable chunks so a Hernando-only rider never downloads
HART's share at all. All are bigger architectural changes than this
pass's scope.

- **Route polylines were 23% of the whole payload** (75KB) -- raw GTFS
  `shapes.txt` data at full resolution, up to ~870 points for a single
  route, far more precision than a phone-screen map needs. Douglas-
  Peucker line simplification (`transform.js`, same technique already
  used on this project's `regions.js` for the Florida Cyber Map)
  dropped points that don't meaningfully change the visual line within
  an 8-meter real-world tolerance -- 6,784 raw points became 478
  (93% fewer) for a 64KB drop in total payload size, with no
  perceptible difference at rider-facing zoom levels (every route still
  keeps 20-115 points, plenty to look like a real road-following line,
  not a crude straight-line sketch).
- **~7.5KB of genuinely dead weight** in the bundled Leaflet library --
  the default marker and layers-control icon images were never
  reachable, since `liveMap.js` only ever creates markers with an
  explicit custom icon and never instantiates a layers-switcher
  control. Removed rather than left bundled for no reason.

Not attempted this round, a smaller remaining opportunity if it's ever
worth the added code complexity: each stop's `routes[]` entries
currently duplicate `routeId`/`shortName`/`longName`/`color` for every
stop that route touches (~25KB, 8% of the payload, across only 8
distinct routes) -- normalizing this to a route-ID reference plus a
client-side lookup against the top-level `routes{}` object would save
most of that, at the cost of touching every place `queryEngine.js`
currently reads a route's display name directly off a stop's arrival
record.

## Data flow (why the split)

The backend never answers a rider's question -- it only republishes GTFS
as flat JSON. All natural-language handling and time-based filtering
happens on-device against the cached file, which is what makes the app
usable with zero connectivity once the first sync has completed.
