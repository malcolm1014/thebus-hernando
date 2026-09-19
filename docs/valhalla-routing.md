# On-device walking directions: Valhalla routing

TriBus answers "nearest stop/place" questions with straight-line
(great-circle) distance -- accurate for ranking candidates, but not a
real walking route. This adds actual turn-by-turn walking directions,
fully offline, via the [Valhalla](https://github.com/valhalla/valhalla)
routing engine running natively on-device.

## Why Valhalla, and why this took real infrastructure work

Valhalla is a C++ routing engine with no official Android build. Two
separate problems had to be solved:

1. **Running Valhalla ON the phone.** Cross-compiling Valhalla's C++ for
   Android (NDK, JNI bindings) from scratch would be a large, multi-week
   undertaking. Instead this uses
   [`Rallista/valhalla-mobile`](https://github.com/Rallista/valhalla-mobile)
   -- a maintained, MIT-licensed Kotlin wrapper already published to
   Maven Central (`io.github.rallista:valhalla-mobile`). No NDK
   cross-compilation happens in this repo at all; it's an ordinary
   Gradle dependency (`plugins/valhalla-routing/android/build.gradle`).

2. **Turning OSM data into routing tiles.** Valhalla needs its own
   preprocessed tile format, built by its `valhalla_build_tiles` CLI
   tool from an OSM extract -- a one-time (well, periodic) offline step,
   never run on a phone or on Render. This tool has to be *built*
   somewhere, once, from Valhalla's own C++ source.

   That build step turned out to only work cleanly on **Ubuntu 24.04**
   -- Valhalla's own CI (`valhalla/valhalla/.github/workflows/linux.yml`)
   runs exclusively on `ubuntu-24.04`, and its current source genuinely
   does not build on Debian bookworm's older Boost (1.74) + GCC (12)
   combination: `src/mjolnir/adminbuilder.cc`'s
   `boost::geometry::area()` call for geographic polygons has no
   working automatic strategy dispatch until a newer Boost, and
   Valhalla's `<format>` usage needs GCC 13+. Confirmed the hard way --
   see git history on this file for the dead ends (isolated conda-forge
   GCC 13 + Boost 1.86 toolchains hit a separate, unresolved `-I` path
   ordering quirk specific to that conda packaging; a Docker-extracted
   prebuilt binary needed a newer glibc than bookworm ships) before
   just matching Valhalla's own tested OS instead of fighting Debian's.

## How to (re)build the routing tiles

Needs an **Ubuntu 24.04** machine or container (a GitHub Codespace
created against `.devcontainer/valhalla-build/devcontainer.json` on the
`scratch/valhalla-tile-build-env` branch works -- see that file). Not
part of the app's normal Codespace (`.devcontainer/devcontainer.json`,
Debian-based, needed for the Android SDK) -- this is a separate,
one-off tool build, never something Render or a phone does.

```sh
# On Ubuntu 24.04:
git clone --recurse-submodules --depth 1 https://github.com/valhalla/valhalla.git
cd valhalla
./scripts/install-linux-deps.sh
cmake -B build -DCMAKE_BUILD_TYPE=Release \
  -DENABLE_TOOLS=ON -DENABLE_DATA_TOOLS=ON \
  -DENABLE_SERVICES=OFF -DENABLE_PYTHON_BINDINGS=OFF -DENABLE_TESTS=OFF
make -C build -j$(nproc)
sudo make -C build install   # installs valhalla_build_tiles, valhalla_build_extract, etc.
```

Then, using the same tri-county OSM extract
`backend/scripts/refresh-osm-data.sh` already produces
(`tricounty.osm.pbf`, before the business/road tag-filtering step --
routing needs the FULL road network, not just named roads):

```sh
valhalla_build_config --mjolnir-tile-dir /tmp/valhalla_tiles --mjolnir-timezone /tmp/valhalla_tiles/timezones.sqlite --mjolnir-admin /tmp/valhalla_tiles/admins.sqlite > valhalla.json
valhalla_build_tiles -c valhalla.json tricounty.osm.pbf
valhalla_build_extract -c valhalla.json -v   # bundles the tile dir into ONE tar -- what ValhallaConfigFactory.usingTileExtract() expects
```

The resulting tar is what the app downloads and caches at
`<app files dir>/valhalla/tiles.tar` (`ValhallaRoutingPlugin.tileTarFile()`,
`valhallaTiles.js`'s `TILES_PATH`).

The current tri-county tiles (164MB, auto+pedestrian+bicycle costing)
are published at the `valhalla-tiles-v1` release
(`valhallaTiles.js`'s `TILES_URL`) -- versioned independently of the app
itself, same reasoning as the OSM corpus's own refresh cadence (see the
main README's "OpenStreetMap corpus" section). Re-run the steps above
and publish a new release (`valhalla-tiles-v2`, etc.) to refresh them;
bump `TILES_URL` to match.

## How it actually got built (worth knowing before touching this again)

Valhalla's current source doesn't build on this project's usual
Debian-bookworm dev Codespace -- `<format>` needs GCC 13+, and
`src/mjolnir/adminbuilder.cc`'s `boost::geometry::area()` call for
geographic polygons has no working automatic strategy dispatch on
bookworm's Boost 1.74. Several isolated-toolchain workarounds were tried
(conda-forge GCC 13 + Boost 1.86 in the existing Codespace) and hit a
separate, never-fully-explained `-I` include-path ordering quirk
specific to that conda packaging. What actually worked: standing up a
**temporary Ubuntu 24.04 Codespace** (`scratch/valhalla-tile-build-env`
branch, `.devcontainer/valhalla-build/devcontainer.json`) matching
Valhalla's own tested CI (`valhalla/valhalla/.github/workflows/linux.yml`
runs on `ubuntu-24.04`) -- stock apt packages, no toolchain gymnastics,
builds clean. Delete the codespace once you're done; the branch/
devcontainer stay as a cheap, reusable reference for next time.

## What ships in this repo -- fully wired, end to end

- `plugins/valhalla-routing` -- a local Capacitor plugin
  (`ValhallaRoutingPlugin.kt`) bridging JS to
  `io.github.rallista:valhalla-mobile` **0.6.3** (not the README's
  documented 0.6.1 -- that version predates `ValhallaConfigFactory`/
  `routeRaw()` entirely; always check Maven Central's own
  `maven-metadata.xml` for the real latest, not just what a library's
  README happens to show). Uses Valhalla's own public JSON request/
  response shape (`routeRaw()`,
  https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/)
  rather than the generated Kotlin models, so this plugin stays a thin
  JSON bridge and `queryEngine.js` owns interpreting the answer -- same
  division of responsibility as the rest of this app's native code.
- Real, verified version requirements (found by actually running
  `./gradlew assembleDebug`, not by reading docs): minSdk 26 (not 24 --
  valhalla-mobile 0.6.3's own AAR manifest), compileSdk/targetSdk 36 (a
  hard `checkDebugAarMetadata` failure below that, not a lint warning),
  Kotlin Gradle plugin 2.2.20 (valhalla-mobile ships Kotlin 2.2/2.3
  metadata), Java 21 in CI. All applied via
  `scripts/patch-min-sdk.js` (reapplied after every `cap add android`,
  same pattern as the existing manifest patch) and `build-apk.yml`
  (which also accepts SDK licenses for the newly-required API 36
  platform before building).
- `valhallaTiles.js` -- downloads/caches the tile tarball via
  `Filesystem.downloadFile()` (streamed straight to disk, never
  round-tripped through JS as a base64 string) to the exact path
  `ValhallaRoutingPlugin.kt` reads from. A deliberate, explicit one-time
  ~164MB download, never automatic -- triggered only by the
  `DOWNLOAD_ROUTING_TILES` intent below.
- Two new query types (`intentParser.js`/`queryEngine.js`):
  - `download walking directions` / `enable walking directions` --
    downloads and caches the tiles.
  - `walking directions to <place>` / `walk to <place>` -- real
    on-device turn-by-turn pedestrian directions from the rider's GPS
    position, resolving the destination through the exact same tiered
    landmark resolution (`resolveLandmark()`) every other "nearest X"
    query already uses. Falls back to a clear "not downloaded yet"
    message (never a crash) when the tiles aren't there, and answers
    with distance/time/numbered steps when they are.
- Verified for real: a full `cap add android` -> patches -> `cap sync`
  -> signed `./gradlew assembleDebug` from a clean checkout succeeds
  (39MB APK, `valhallaTiles.js` confirmed present in
  `assets/public/js/`), fingerprint-matched to the same pinned debug
  keystore every other release uses. 157 frontend tests passing,
  including dedicated coverage for both new query types and
  `valhallaTiles.js`'s download/progress/error-handling paths.

## Real, disclosed gap: no on-device testing yet

Everything above is Gradle-compile-verified and unit-tested, never run
on an actual phone or emulator (this environment has neither). Before
trusting this for real: install a build with these changes, run
`download walking directions` on real WiFi (real 164MB, real time), then
try `walking directions to <a real nearby business>` and sanity-check
the distance/steps against reality. Same testing gap already tracked in
`MANUAL_TEST_SCRIPT.md` for other recent features -- add these two
commands to that script's checklist.
