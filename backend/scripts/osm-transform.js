#!/usr/bin/env node
/**
 * Reads osmium's geojsonseq export (RS 0x1E-prefixed newline-delimited
 * GeoJSON Features) and reduces it to two small, flat, search-ready
 * tables: named businesses/POIs (places) and named roads. Anything
 * without a `name` tag is dropped -- unnamed highway junction/signal/
 * barrier nodes make up the bulk of osmium's raw export (referenced
 * nodes of matching ways get emitted too) and are useless for a
 * "where is X" search.
 */
const fs = require('fs');
const readline = require('readline');

const IN_PATH = process.argv[2];
const OUT_PLACES = process.argv[3];
const OUT_ROADS = process.argv[4];

const CATEGORY_KEYS = ['shop', 'amenity', 'office', 'tourism', 'leisure'];

function deriveCategory(props) {
  for (const key of CATEGORY_KEYS) {
    if (props[key]) return `${key}:${props[key]}`;
  }
  return null;
}

function buildAddress(props) {
  const parts = [];
  if (props['addr:housenumber'] && props['addr:street']) {
    parts.push(`${props['addr:housenumber']} ${props['addr:street']}`);
  } else if (props['addr:street']) {
    parts.push(props['addr:street']);
  }
  if (props['addr:city']) parts.push(props['addr:city']);
  if (props['addr:postcode']) parts.push(props['addr:postcode']);
  return parts.length ? parts.join(', ') : null;
}

function buildAliases(props) {
  const raw = [props.alt_name, props.brand, props.short_name, props.old_name, props.operator];
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    if (!v) continue;
    for (const piece of String(v).split(';')) {
      const trimmed = piece.trim();
      if (trimmed && !seen.has(trimmed.toLowerCase())) {
        seen.add(trimmed.toLowerCase());
        out.push(trimmed);
      }
    }
  }
  return out;
}

function midpoint(coords) {
  // coords: array of [lon, lat] for a LineString (may itself be nested
  // for MultiLineString -- osmium ways export as plain LineString, so
  // that's the only shape actually handled here).
  if (!Array.isArray(coords) || coords.length === 0) return null;
  const [lon, lat] = coords[Math.floor((coords.length - 1) / 2)];
  return { lat, lon };
}

const EARTH_RADIUS_MI = 3958.8;
function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_MI * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Same-named roads several miles apart are almost always two different
 * streets in two different towns, not one street -- averaging their
 * segment midpoints into one centroid would land the answer in neither
 * town. Single-linkage clusters each name's segment midpoints (any two
 * within CLUSTER_RADIUS_MI of EITHER-adjacent point join the same
 * cluster) so one real contiguous street still merges into one entry,
 * while distinct same-named streets miles apart end up as separate
 * road entries instead of a bogus mid-county average.
 */
const CLUSTER_RADIUS_MI = 2;
function clusterSegments(segments) {
  const clusters = []; // each: { points: [{lat,lon}], highway }
  for (const seg of segments) {
    let joined = null;
    for (const cluster of clusters) {
      if (cluster.points.some((p) => haversineMiles(p.lat, p.lon, seg.lat, seg.lon) <= CLUSTER_RADIUS_MI)) {
        joined = cluster;
        break;
      }
    }
    if (joined) {
      joined.points.push(seg);
    } else {
      clusters.push({ points: [seg], highway: seg.highway });
    }
  }
  return clusters.map((cluster) => {
    const latSum = cluster.points.reduce((s, p) => s + p.lat, 0);
    const lonSum = cluster.points.reduce((s, p) => s + p.lon, 0);
    return {
      highway: cluster.highway,
      lat: latSum / cluster.points.length,
      lon: lonSum / cluster.points.length,
      segments: cluster.points.length,
    };
  });
}

async function main() {
  if (!IN_PATH || !OUT_PLACES || !OUT_ROADS) {
    console.error('usage: osm-transform.js <in.geojsonseq> <out-places.json> <out-roads.json>');
    process.exit(1);
  }

  const places = [];
  // name (lowercased) -> accumulator, merged into one entry per road name
  const roadAcc = new Map();

  const rl = readline.createInterface({
    input: fs.createReadStream(IN_PATH, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let total = 0;
  let kept = 0;

  for await (const rawLine of rl) {
    const line = rawLine.replace(/^\x1e/, '').trim();
    if (!line) continue;
    total++;
    let feature;
    try {
      feature = JSON.parse(line);
    } catch {
      continue; // truncated/partial line -- skip rather than crash the whole run
    }
    const props = feature.properties || {};
    const name = props.name && String(props.name).trim();
    if (!name) continue;

    if (feature.geometry && feature.geometry.type === 'LineString' && props.highway) {
      const mid = midpoint(feature.geometry.coordinates);
      if (!mid) continue;
      const key = name.toLowerCase();
      let acc = roadAcc.get(key);
      if (!acc) {
        acc = { name, segments: [] };
        roadAcc.set(key, acc);
      }
      acc.segments.push({ lat: mid.lat, lon: mid.lon, highway: props.highway });
      kept++;
      continue;
    }

    if (feature.geometry && feature.geometry.type === 'Point') {
      const category = deriveCategory(props);
      if (!category) continue; // a named point with none of our POI tags -- not a business
      const [lon, lat] = feature.geometry.coordinates;
      places.push({
        id: `osm:node:${feature.id}`,
        name,
        category,
        lat,
        lon,
        address: buildAddress(props),
        aliases: buildAliases(props),
      });
      kept++;
    }
  }

  const roads = [];
  let totalSegments = 0;
  let roadIdx = 0;
  for (const acc of roadAcc.values()) {
    totalSegments += acc.segments.length;
    for (const cluster of clusterSegments(acc.segments)) {
      roads.push({
        id: `osm:road:${roadIdx++}`,
        name: acc.name,
        highway: cluster.highway,
        lat: cluster.lat,
        lon: cluster.lon,
        segments: cluster.segments,
      });
    }
  }

  fs.writeFileSync(OUT_PLACES, JSON.stringify(places));
  fs.writeFileSync(OUT_ROADS, JSON.stringify(roads));

  console.log(`[osm-transform] read ${total} features, kept ${kept}`);
  console.log(`[osm-transform] wrote ${places.length} places -> ${OUT_PLACES}`);
  console.log(`[osm-transform] wrote ${roads.length} named-road entries (${roadAcc.size} distinct names, ${totalSegments} raw segments) -> ${OUT_ROADS}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
