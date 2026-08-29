# Manual On-Device Test Script

Three things in this app are implemented and unit-tested but have never
been confirmed against real hardware or live data:

1. The GPS-based "nearest stop to me" fallback
2. The 3-tier learned-search cache (Tier 2/Tier 3 actually persisting
   and being hit, not just working in a unit test's fake storage)
3. Passio real-time bus position matching to the right route

This script gives exact steps for all three, plus how to watch the
app's internal decision-making live via Chrome DevTools, so "it seemed
to work" can become "I saw exactly which code path answered this."

## Setup: watching the app's internal logs

The app now logs which of its 3 search tiers answered each "nearest
stop" question, tagged `[thebus:tier]`. To see these on your phone:

1. On the phone: Settings → About Phone → tap "Build number" 7 times to
   enable Developer Options, then Settings → Developer Options → turn on
   "USB debugging."
2. Connect the phone to a computer with Chrome installed, via USB.
3. On the computer, open `chrome://inspect#devices` in Chrome. Your
   phone should appear, with TheBus listed as an inspectable target
   once the app is open on the phone (Capacitor apps are Chrome-
   debuggable WebViews).
4. Click "inspect" under TheBus's entry — a normal DevTools window
   opens, connected live to the app on your phone. The Console tab
   shows everything described below, in real time, as you type
   questions into the app.

If this is inconvenient, `adb logcat | grep thebus` (with the phone
connected via `adb`) shows the same log lines without opening DevTools.

## Test 1: GPS "nearest stop to me"

**Before starting:** make sure Location is enabled on the phone, and if
this is the app's first-ever launch, choose "YES, SHARE LOCATION" on the
onboarding prompt (or grant it via Android's permission prompt when
asked).

| Step | Type this | Expected result | What to check |
|---|---|---|---|
| 1 | `nearest stop to me` | A real stop name, a distance in miles, and "SERVED BY ROUTES: ..." | The distance should roughly match where you're actually standing — sanity-check it against a map app if unsure |
| 2 | `when is the next bus` (no stop named at all) | Answers for the nearest stop to your current position, labeled "(NEAREST TO YOU)" | Confirms the GPS fallback works for FIND_NEXT_ARRIVAL too, not just FIND_NEAREST_STOP |
| 3 | Turn off Location for the app (Android Settings → Apps → TheBus → Permissions → Location → Don't allow), then repeat step 1 | `COULDN'T GET YOUR LOCATION. CHECK THAT LOCATION IS TURNED ON FOR THIS APP AND TRY AGAIN.` | An honest failure message, not a crash or a silent wrong answer |

In the DevTools console, step 1 should show:
```
[thebus:tier] GPS { query: "me", lat: ..., lon: ... }
```
with `lat`/`lon` roughly matching your real position.

## Test 2: the 3-tier learned-search cache

This proves Tier 2 (places) and Tier 3 (exact phrases) actually persist
to disk and get reused — not just that the logic is right in a test.

| Step | Type this | Expected result |
|---|---|---|
| 1 | `nearest stop to [pick a real local business not already a known stop name — e.g. a specific restaurant]` | A real answer, resolved via the network (Nominatim) |
| 2 | **Force-close the app entirely** (swipe it away from Recent Apps, not just backgrounding it) | — |
| 3 | Reopen the app, type the exact same phrase from step 1 again | Same answer, **instantly** — no "PROCESSING..." delay long enough to suggest a network round-trip |
| 4 | Type a **slightly different phrasing** of the same place (e.g. drop a word, or say "the" instead of nothing) | Still resolves correctly and quickly, via Tier 2, not Tier 3 |

Watch the console across these steps:
- Step 1 should end with `[thebus:tier] NETWORK (geocoded, folded into tiers 2/3 for next time)`
- Step 3 (after the force-close/reopen) should show `[thebus:tier] TIER 3 (LANGUAGE) -> place` — if this instead shows `NETWORK` again, Tier 3 did NOT survive the app restart, which would mean `TheBusStorage.saveSearchMemory` isn't actually persisting (a real bug, not just an untested path)
- Step 4 should show `[thebus:tier] TIER 2 (PLACES)`

If step 3 shows a real "PROCESSING..." pause and a `NETWORK` log line instead of an instant `TIER 3` hit, stop and report that — it means the persistence layer is broken, which every unit test so far has been unable to catch (they use a fake in-memory storage).

## Test 3: Passio live bus position → route matching

**Timing matters for this one** — Hernando County Transit's buses run
on weekday daytime service. Run this test on a **weekday, roughly
7am–6pm**, when buses are actually on the road. Outside those hours the
Live Map will correctly show "NO BUSES CURRENTLY RUNNING," which is not
a failure, just untestable at that time.

| Step | Action | Expected result |
|---|---|---|
| 1 | Open the app with a network connection, tap `[ LIVE MAP ]` | Map loads, shows routes (colored lines) and stops (dots) |
| 2 | Wait up to 10 seconds | The status button at the bottom-left changes from "CONNECTING TO LIVE TRACKER..." to "N BUSES ACTIVE" (or "NO BUSES CURRENTLY RUNNING" outside service hours) |
| 3 | If buses are shown: tap a bus marker on the map | A popup shows a route name/number and speed |
| 4 | Compare the bus marker's **color** to the route line color directly underneath it | They should match — this is the part that was never confirmed against a live feed. If a bus is grey/uncolored (falls back to `#e0e0e0`) while sitting on a clearly-colored route line, that's the route-ID mismatch the code's own comments warned about |
| 5 | Tap the "N BUSES ACTIVE" button itself | A list opens: one row per bus, its route, the stop it's nearest to, and that route's next scheduled time there |
| 6 | Check that the route name shown in that list row is a real, sensible route (e.g. "Route 5 Yellow"), not "ROUTE NOT IN SCHEDULE DATA" | If you see "ROUTE NOT IN SCHEDULE DATA" for a bus that's clearly on a known route, that confirms the Passio routeId ↔ GTFS route_id correlation is failing for that route |

There's no `[thebus:tier]` log for this one (it's a different code path,
`liveMap.js`'s `matchRouteId`) — the visual check above (marker color vs.
route line color, and the bus-list route names) is the real signal here.

## What to send back

For each of the 3 tests: pass/fail, and for anything that fails, the
exact `[thebus:tier]` log lines (or a screenshot of the map/bus-list for
Test 3) so the actual failure mode is visible rather than just "it didn't
work."
