/**
 * "Download the offline map": prefetch every basemap tile covering the loaded
 * agencies' area into the tile cache (tileCache.js), so the WHOLE tri-county
 * region works offline on the Live Map -- not just the spots you happened to
 * pan over (which the on-view caching in liveMap.js already grabs).
 *
 * This is an on-demand download, the same pattern the app already uses for
 * offline walking directions (the Valhalla routing tiles): baking tiles into
 * the APK would bloat it past store limits, so instead the rider fetches the
 * region once, over wifi, and it's then available with no signal. The tiles
 * come through our own /api/tiles proxy (Geoapify) and are stored under the
 * exact same URLs the map requests, so the cache hits transparently offline.
 *
 * Deliberately bounded to overview + neighborhood zooms (z10-13, a few
 * hundred tiles, ~10MB for the tri-county area): enough to navigate the whole
 * region offline, while staying well within the tile provider's free daily
 * quota and gentle on the free-tier backend. Finer street detail (z14+) still
 * fills in from on-view caching as you look around.
 */
(function (global) {
  function lonToTileX(lon, z) {
    return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
  }
  function latToTileY(lat, z) {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z));
  }

  /** All {z,x,y} tiles covering a bbox across the inclusive zoom range. Pure. */
  function tilesForBounds(bbox, minZ, maxZ) {
    const tiles = [];
    for (let z = minZ; z <= maxZ; z++) {
      const max = Math.pow(2, z) - 1;
      const clamp = (v) => Math.max(0, Math.min(max, v));
      const xs = [clamp(lonToTileX(bbox.minLon, z)), clamp(lonToTileX(bbox.maxLon, z))];
      const ys = [clamp(latToTileY(bbox.maxLat, z)), clamp(latToTileY(bbox.minLat, z))]; // y grows southward
      for (let x = Math.min(...xs); x <= Math.max(...xs); x++) {
        for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
          tiles.push({ z, x, y });
        }
      }
    }
    return tiles;
  }

  /** Bounding box of every stop in the dataset, padded a little. Null if no stops. */
  function boundsFromDataset(dataset, padDeg) {
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    const stops = (dataset && dataset.stops) || {};
    let any = false;
    for (const id in stops) {
      const s = stops[id];
      if (!s || s.lat == null || s.lon == null) continue;
      any = true;
      if (s.lat < minLat) minLat = s.lat;
      if (s.lat > maxLat) maxLat = s.lat;
      if (s.lon < minLon) minLon = s.lon;
      if (s.lon > maxLon) maxLon = s.lon;
    }
    if (!any) return null;
    const p = padDeg == null ? 0.03 : padDeg;
    return { minLat: minLat - p, maxLat: maxLat + p, minLon: minLon - p, maxLon: maxLon + p };
  }

  /**
   * Fetch every tile through /api/tiles and store it in the tile cache, a few
   * in parallel, reporting progress. Never throws; a failed tile is just
   * skipped (it'll fall back to on-view caching later). Returns a summary.
   */
  async function downloadRegion(opts) {
    opts = opts || {};
    const apiBase = opts.apiBase || '';
    const tiles = opts.tiles || [];
    const onProgress = opts.onProgress;
    const concurrency = opts.concurrency || 4;
    if (!global.TheBusTileCache) return { ok: false, reason: 'no-cache', total: tiles.length, cached: 0 };

    let idx = 0;
    let done = 0;
    let cached = 0;
    const total = tiles.length;

    async function worker() {
      while (idx < tiles.length) {
        const t = tiles[idx++];
        const url = `${apiBase}/api/tiles/${t.z}/${t.x}/${t.y}.png`;
        try {
          const res = await fetch(url);
          if (res && res.ok) {
            const blob = await res.blob();
            await TheBusTileCache.put(url, blob);
            cached++;
          }
        } catch (e) { /* skip this tile */ }
        done++;
        if (onProgress && (done % 25 === 0 || done === total)) onProgress(done, total, cached);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.max(1, concurrency); i++) workers.push(worker());
    await Promise.all(workers);
    return { ok: true, total, cached };
  }

  global.TheBusOfflineMap = { lonToTileX, latToTileY, tilesForBounds, boundsFromDataset, downloadRegion };
})(typeof window !== 'undefined' ? window : this);
