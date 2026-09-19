package com.savvysecurity.thebus.valhalla

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.valhalla.valhalla.Valhalla
import com.valhalla.valhalla.ValhallaException
import com.valhalla.valhalla.config.ValhallaConfigFactory
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * Thin JS<->native bridge to the on-device Valhalla routing engine
 * (io.github.rallista:valhalla-mobile), for offline walking directions
 * between two points using the tri-county routing tiles (see
 * backend/scripts/refresh-osm-data.sh's sibling tile-build step and
 * frontend's sync.js for how those tiles get onto the device -- this
 * plugin only ever CONSUMES a tile tarball already on disk, it never
 * fetches one itself).
 *
 * Deliberately uses Valhalla's raw-JSON escape hatch (`routeRaw`)
 * rather than the generated `RouteRequest`/`RouteResponse` Kotlin
 * models: this plugin's only job is bridging JSON across the JS/native
 * boundary, and Valhalla's own request/response JSON shape
 * (https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/)
 * is public, stable API surface -- building it directly here means
 * queryEngine.js (already comfortable parsing arbitrary JSON from the
 * synced dataset) owns interpreting the response, and this class stays
 * a thin bridge instead of a second copy of route-answer formatting
 * logic.
 *
 * One [Valhalla] engine instance is expensive to build (mmaps the
 * whole tile extract) and is reused for the plugin's entire lifetime
 * once the tiles are found -- see [engine].
 */
@CapacitorPlugin(name = "ValhallaRouting")
class ValhallaRoutingPlugin : Plugin() {

    /** Where the JS side (sync.js) is expected to have downloaded/cached the built tile tarball -- app-private storage, not shared/external. */
    private fun tileTarFile(): File = File(context.filesDir, "valhalla/tiles.tar")

    private var engine: Valhalla? = null

    /**
     * Lazily builds and caches the engine against the on-device tile
     * tarball. Returns null (never throws) when the tiles haven't been
     * downloaded yet -- callers report that as an ordinary "not
     * available offline" result, not an error, since not having
     * downloaded routing tiles is an expected, normal app state.
     */
    private fun getOrBuildEngine(): Valhalla? {
        engine?.let { return it }
        val tar = tileTarFile()
        if (!tar.exists()) return null
        val config = ValhallaConfigFactory.usingTileExtract(tar.absolutePath)
        val built = Valhalla(context, config)
        engine = built
        return built
    }

    /** Whether routing tiles are present on-device, without paying to build the engine. Lets JS decide whether to offer the feature at all before ever calling [route]. */
    @PluginMethod
    fun tilesAvailable(call: PluginCall) {
        val result = JSObject()
        result.put("available", tileTarFile().exists())
        call.resolve(result)
    }

    /**
     * @param fromLat / fromLon / toLat / toLon (required, doubles) -- the walking route's endpoints.
     * @param costing (optional, default "pedestrian") -- any valhalla costing model name.
     * @return {available: false} if no tiles are on-device yet (not an
     *   error -- see [tilesAvailable]); otherwise
     *   {available: true, distanceMeters, durationSeconds, instructions: [{text, distanceMeters}]},
     *   parsed from Valhalla's own `route` JSON response
     *   (https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/#outputs-of-a-route).
     */
    @PluginMethod
    fun route(call: PluginCall) {
        val fromLat = call.getDouble("fromLat")
        val fromLon = call.getDouble("fromLon")
        val toLat = call.getDouble("toLat")
        val toLon = call.getDouble("toLon")
        if (fromLat == null || fromLon == null || toLat == null || toLon == null) {
            call.reject("fromLat, fromLon, toLat, and toLon are all required")
            return
        }
        val costing = call.getString("costing") ?: "pedestrian"

        val engine = getOrBuildEngine()
        if (engine == null) {
            val result = JSObject()
            result.put("available", false)
            call.resolve(result)
            return
        }

        val requestJson =
            JSONObject()
                .put(
                    "locations",
                    JSONArray()
                        .put(JSONObject().put("lat", fromLat).put("lon", fromLon))
                        .put(JSONObject().put("lat", toLat).put("lon", toLon)))
                .put("costing", costing)
                .put("format", "json")
                .toString()

        try {
            val rawResponse = engine.routeRaw(requestJson)
            call.resolve(parseRouteResponse(rawResponse))
        } catch (e: ValhallaException) {
            // A real routing failure (no path between the two points on
            // the tiles this device has, malformed request, etc.) --
            // reported as a rejection, distinct from "no tiles at all"
            // above, which is never the rider's fault.
            call.reject("valhalla routing failed: ${e.message}", e)
        }
    }

    /** Valhalla's own `route` JSON -> the flat shape queryEngine.js actually wants. Pulls the FIRST leg of the FIRST trip -- this plugin only ever requests a single origin/destination pair, never multi-leg trips. */
    private fun parseRouteResponse(rawJson: String): JSObject {
        val trip = JSONObject(rawJson).getJSONObject("trip")
        val leg = trip.getJSONArray("legs").getJSONObject(0)
        val summary = leg.getJSONObject("summary")

        val instructions = JSONArray()
        val maneuvers = leg.getJSONArray("maneuvers")
        for (i in 0 until maneuvers.length()) {
            val m = maneuvers.getJSONObject(i)
            val instruction = JSObject()
            instruction.put("text", m.getString("instruction"))
            instruction.put("distanceMeters", m.getDouble("length") * 1000.0) // valhalla reports length in km
            instructions.put(instruction)
        }

        val result = JSObject()
        result.put("available", true)
        result.put("distanceMeters", summary.getDouble("length") * 1000.0)
        result.put("durationSeconds", summary.getDouble("time"))
        result.put("instructions", instructions)
        return result
    }
}
