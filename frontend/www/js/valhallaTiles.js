/**
 * Downloads and tracks the on-device Valhalla routing tile extract (see
 * plugins/valhalla-routing and docs/valhalla-routing.md) -- a large
 * (~164MB), rarely-changing, OPT-IN download, deliberately kept
 * separate from the automatic schedule sync in sync.js: nobody should
 * have this pulled onto their data plan without asking for it.
 *
 * `path`/`directory` here MUST match ValhallaRoutingPlugin.kt's own
 * `tileTarFile()` exactly (`<filesDir>/valhalla/tiles.tar`, i.e.
 * Directory.Data + 'valhalla/tiles.tar') -- this module only ever
 * writes the file, the native plugin only ever reads it, and neither
 * side is the source of truth for the other's path constant.
 */
(function (global) {
  // GitHub Release asset, not the Render backend -- this is static data
  // with its own independent release cadence (see docs/valhalla-routing.md),
  // unrelated to the app/schedule-data release cycle.
  const TILES_URL = 'https://github.com/malcolm1014/thebus-hernando/releases/download/valhalla-tiles-v1/tiles.tar';
  const TILES_PATH = 'valhalla/tiles.tar';

  const hasCapacitor = !!(global.Capacitor && global.Capacitor.Plugins);
  const Filesystem = hasCapacitor ? global.Capacitor.Plugins.Filesystem : null;
  const ValhallaRouting = hasCapacitor ? global.Capacitor.Plugins.ValhallaRouting : null;
  const Directory = hasCapacitor && global.CapacitorFilesystem
    ? global.CapacitorFilesystem.Directory
    : { Data: 'DATA' };

  /** True only on a real Android build with the plugin compiled in -- false in a browser/test env, where this whole feature is simply unavailable rather than erroring. */
  function isSupported() {
    return !!ValhallaRouting;
  }

  /** Asks the NATIVE side whether tiles.tar is actually present -- the plugin checks the same path this module writes to, so this is always the ground truth, never a locally-cached guess. */
  async function isDownloaded() {
    if (!ValhallaRouting) return false;
    try {
      const { available } = await ValhallaRouting.tilesAvailable();
      return !!available;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  /**
   * Streams the tile tarball straight to disk via Filesystem.downloadFile
   * (native download, never round-tripped through JS as a base64 string --
   * doing that for 164MB would be slow and memory-heavy for no reason).
   *
   * @param {(percent: number) => void} [onProgress] - 0-100, called at
   *   most every ~100ms (Capacitor throttles this on Android/iOS).
   *   Optional -- omit for a plain "wait for it" download.
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async function download(onProgress) {
    if (!Filesystem) return { ok: false, error: 'NOT SUPPORTED OUTSIDE THE ANDROID APP.' };

    let listenerHandle = null;
    try {
      if (onProgress) {
        listenerHandle = await Filesystem.addListener('progress', (event) => {
          if (event.contentLength > 0) {
            onProgress(Math.round((event.bytes / event.contentLength) * 100));
          }
        });
      }
      await Filesystem.downloadFile({
        url: TILES_URL,
        path: TILES_PATH,
        directory: Directory.Data,
        progress: true,
        recursive: true,
      });
      return { ok: true };
    } catch (err) {
      console.error(err);
      return { ok: false, error: err && err.message ? err.message : 'DOWNLOAD FAILED.' };
    } finally {
      if (listenerHandle) await listenerHandle.remove();
    }
  }

  global.TheBusValhallaTiles = { isSupported, isDownloaded, download, TILES_URL };
})(window);
