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
`<app files dir>/valhalla/tiles.tar` (`ValhallaRoutingPlugin.tileTarFile()`).

## What ships in this repo vs. what's still open

**Done:**
- `plugins/valhalla-routing` -- a real local Capacitor plugin
  (`ValhallaRoutingPlugin.kt`) bridging JS to `valhalla-mobile`'s
  `routeRaw()`, using Valhalla's own public JSON request/response shape
  (https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/)
  rather than the generated Kotlin request/response models, so this
  plugin stays a thin JSON bridge and queryEngine.js owns interpreting
  the answer -- same division of responsibility as the rest of this
  app's native plugins.
- `tilesAvailable()` / `route(fromLat, fromLon, toLat, toLon, costing?)`
  JS-callable methods, verified to compile and be discovered correctly
  by Capacitor's plugin tooling (`npx cap sync android` lists it
  alongside the app's other 4 plugins).
- minSdk bumped 22 -> 24 (`scripts/patch-min-sdk.js`, valhalla-mobile's
  own requirement) and CI's Java version bumped 17 -> 21
  (valhalla-mobile ships Java 21 class files).

**Not yet done (real, disclosed gaps, not oversights):**
- The actual tile tarball for the tri-county area hasn't been built and
  committed/hosted yet -- do that with the steps above, then wire the
  download into `sync.js`/`storage.js` (Filesystem, not Preferences --
  a tile tarball is far bigger than the small JSON blobs Preferences is
  used for elsewhere in this app) and a new intent in
  `intentParser.js`/`queryEngine.js` ("walking directions to X") that
  calls `Capacitor.Plugins.ValhallaRouting.route(...)` and falls back to
  the existing straight-line distance when tiles aren't downloaded yet.
- No on-device (real Android hardware/emulator) verification yet --
  everything above is Gradle-compile-verified only. This environment
  has no Android emulator; real verification needs a physical device,
  same testing gap already tracked in `MANUAL_TEST_SCRIPT.md` for other
  recent features.
