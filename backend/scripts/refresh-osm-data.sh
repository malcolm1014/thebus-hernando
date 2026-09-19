#!/usr/bin/env bash
# Regenerates backend/data/osm-source/{places,roads}.json from a fresh
# OpenStreetMap extract. NOT run automatically by the ETL/cron (see
# backend/src/osm.js's doc comment on why) -- run this by hand every
# few months, or whenever the tri-county area's roads/businesses need
# refreshing, then commit the two output files like any other data
# update.
#
# Requires osmium-tool (https://osmcode.org/osmium-tool/ --
# `apt-get install osmium-tool` on Debian/Ubuntu, `brew install
# osmium-tool` on macOS) and Node (for the flattening pass). Needs
# ~1.5GB free disk and a few minutes -- the source Florida extract is
# ~600MB.
#
# Bounding box covers Citrus, Hernando, Pasco, and Hillsborough
# counties (a simple bbox, not exact county polygons -- see the
# script's own README section in backend/README.md for why that's an
# acceptable tradeoff here).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/../data/osm-source"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

BBOX="-82.9,27.6,-82.0,29.25" # min_lon,min_lat,max_lon,max_lat

command -v osmium >/dev/null || { echo "osmium-tool is required -- see this script's header comment" >&2; exit 1; }

echo "==> Downloading Florida OSM extract (Geofabrik, ~600MB)..."
curl -sL -o "$WORK_DIR/florida-latest.osm.pbf" https://download.geofabrik.de/north-america/us/florida-latest.osm.pbf

echo "==> Extracting tri-county bounding box..."
osmium extract -b "$BBOX" "$WORK_DIR/florida-latest.osm.pbf" -o "$WORK_DIR/tricounty.osm.pbf"

echo "==> Filtering to named roads + business/POI tags..."
osmium tags-filter "$WORK_DIR/tricounty.osm.pbf" \
  w/highway n/shop n/amenity n/office n/tourism n/leisure \
  -o "$WORK_DIR/filtered.osm.pbf"

echo "==> Exporting to GeoJSON Sequence..."
osmium export "$WORK_DIR/filtered.osm.pbf" -o "$WORK_DIR/filtered.geojsonseq" -f geojsonseq --add-unique-id=counter

echo "==> Flattening to places.json / roads.json..."
mkdir -p "$OUT_DIR"
node "$SCRIPT_DIR/osm-transform.js" "$WORK_DIR/filtered.geojsonseq" "$OUT_DIR/places.json" "$OUT_DIR/roads.json"

echo "==> Done. Review the diff, then commit backend/data/osm-source/*.json."
echo "    Reminder: this data is (c) OpenStreetMap contributors, ODbL-licensed -- keep the attribution in PRIVACY_POLICY.md/README.md."
